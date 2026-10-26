import { describe, expect, it } from "vitest";
import { MeshNode, randomId, RoomReplica, WorkspaceChain, wrapRoomKey } from "@vault-rooms/secure";
import { createRoom, founder, invite, Network, type TestDevice } from "@vault-rooms/secure/testkit";
import { RoomFolder, type RoomFolderState } from "../../src/mesh/roomFolder.js";
import { MemoryVault } from "./memoryVault.js";

interface Pc {
  device: TestDevice;
  node: MeshNode;
  replica: RoomReplica;
  vault: MemoryVault;
  folder: RoomFolder;
  notices: string[];
  saved: { state: RoomFolderState | null };
  bound: Set<string>;
}

function setup() {
  const { chain, ws, admin: ana } = founder();
  const { joiner: cy } = invite(chain, ana, { userName: "Cy" });
  const { joiner: rae } = invite(chain, ana, { userName: "Rae" });
  const { roomId, key } = createRoom(chain, ana, "Team", { [cy.userId]: "write", [rae.userId]: "read" });
  const net = new Network();
  const pcs = new Map<string, Pc>();
  const make = (device: TestDevice, folderPath: string, vault = new MemoryVault()): Pc => {
    const notices: string[] = [];
    const saved: { state: RoomFolderState | null } = { state: null };
    const bound = new Set<string>();
    const node = new MeshNode(WorkspaceChain.load(chain.all()), device.id, {
      envelope: (env) => {
        const pc = pcs.get(device.id);
        pc?.replica.receive(env);
        pc?.folder.remoteChanged();
      },
      wraps: () => pcs.get(device.id)?.replica.refreshKeys()
    });
    const replica = new RoomReplica(node, roomId, { sign: device.sign, agree: device.agree }, { index: () => pcs.get(device.id)?.folder.remoteChanged(), doc: () => pcs.get(device.id)?.folder.remoteChanged() });
    const folder = new RoomFolder({
      folder: folderPath,
      replica,
      vault,
      deviceName: device.name,
      isBound: (id) => bound.has(id),
      loadState: async () => saved.state,
      saveState: async (state) => {
        saved.state = structuredClone(state);
      },
      notify: (message) => notices.push(message),
      log: () => {},
      now: () => new Date("2026-10-26T12:30:00Z")
    });
    vault.listener = {
      write: (path) => void folder.onLocalWrite(path),
      delete: (path) => void folder.onLocalDelete(path),
      rename: (from, to) => void folder.onLocalRename(from, to)
    };
    const pc = { device, node, replica, vault, folder, notices, saved, bound };
    pcs.set(device.id, pc);
    return pc;
  };
  const giveKey = (from: Pc, to: TestDevice) => from.node.addWrap(wrapRoomKey(ws, roomId, 1, key, { id: to.id, agree: to.agree.publicKey }, ana.sign));
  /** Run until the network and every folder are quiet. */
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      net.pump();
      for (const pc of pcs.values()) await pc.folder.settled();
    }
  };
  return { ws, ana, cy, rae, roomId, key, net, make, giveKey, settle };
}

const text = (vault: MemoryVault, path: string) => vault.text(path);

describe("room folder", () => {
  it("shares a folder's files and keeps both sides in step", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "# Plan\n");
    await a.vault.writeBytes("Team/img.png", new Uint8Array([1, 2, 3]));
    const c = s.make(s.cy, "Shared/Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    expect(text(c.vault, "Shared/Team/Plan.md")).toBe("# Plan\n");
    expect([...c.vault.files.get("Shared/Team/img.png")!]).toEqual([1, 2, 3]);
    // Edits, renames and deletions travel both ways.
    await c.vault.writeText("Shared/Team/Plan.md", "# Plan\n\n- [ ] Kickoff\n");
    await s.settle();
    expect(text(a.vault, "Team/Plan.md")).toBe("# Plan\n\n- [ ] Kickoff\n");
    await a.vault.rename("Team/Plan.md", "Team/Roadmap.md");
    await s.settle();
    expect(text(c.vault, "Shared/Team/Roadmap.md")).toBe("# Plan\n\n- [ ] Kickoff\n");
    expect(c.vault.files.has("Shared/Team/Plan.md")).toBe(false);
    await c.vault.trash("Shared/Team/img.png");
    await s.settle();
    expect(a.vault.files.has("Team/img.png")).toBe(false);
    expect(a.vault.trashed).toContain("Team/img.png");
  });

  it("keeps a file changed on both sides as a conflict copy instead of overwriting it", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Notes.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    // Cy closes Obsidian; while it's closed, his copy changes on disk, and Ana edits hers.
    link.cut();
    await c.folder.stop();
    c.vault.silently("Team/Notes.md", "base\nCy's offline edit\n");
    await a.vault.writeText("Team/Notes.md", "base\nAna's edit\n");
    await s.settle();
    // Cy restarts: his copy changed here and remotely since the last sync.
    const c2 = s.make(s.cy, "Team", c.vault);
    c2.saved.state = c.saved.state;
    s.net.link(a.node, c2.node);
    await s.settle();
    c2.replica.refreshKeys();
    await c2.folder.start();
    await s.settle();
    const copies = [...c2.vault.files.keys()].filter((path) => path.includes("(conflict"));
    expect(copies).toHaveLength(1);
    expect(text(c2.vault, copies[0]!)).toBe("base\nCy's offline edit\n");
    // The note itself now holds the shared version, on both sides.
    expect(text(c2.vault, "Team/Notes.md")).toBe("base\nAna's edit\n");
    expect(text(a.vault, "Team/Notes.md")).toBe("base\nAna's edit\n");
    expect(c2.notices.some((n) => n.includes("kept as"))).toBe(true);
    // The conflict copy is shared like any new file, so nothing is lost for anyone.
    await s.settle();
    expect([...a.vault.files.keys()].some((path) => path.includes("(conflict"))).toBe(true);
  });

  it("shares an offline edit made while Obsidian was closed when nothing changed remotely", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Todo.md", "one\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    await a.folder.stop();
    a.vault.silently("Team/Todo.md", "one\ntwo\n");
    const a2 = s.make(s.ana, "Team", a.vault);
    a2.saved.state = a.saved.state;
    a2.replica.refreshKeys();
    await a2.folder.start();
    await s.settle();
    const [id] = [...a2.replica.files().keys()];
    expect(a2.replica.noteText(id!)).toBe("one\ntwo\n");
    expect([...a2.vault.files.keys()].filter((path) => path.includes("(conflict"))).toEqual([]);
  });

  it("brings back a file deleted elsewhere if it was changed here", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Keep.md", "v1\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    link.cut();
    await c.folder.stop();
    c.vault.silently("Team/Keep.md", "v1\nimportant\n");
    await a.vault.trash("Team/Keep.md");
    await s.settle();
    const c2 = s.make(s.cy, "Team", c.vault);
    c2.saved.state = c.saved.state;
    s.net.link(a.node, c2.node);
    await s.settle();
    c2.replica.refreshKeys();
    await c2.folder.start();
    await s.settle();
    expect(text(c2.vault, "Team/Keep.md")).toBe("v1\nimportant\n");
    expect(text(a.vault, "Team/Keep.md")).toBe("v1\nimportant\n");
  });

  it("puts back a reader's local changes", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Rules.md", "be nice\n");
    const r = s.make(s.rae, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.rae);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, r.node);
    await s.settle();
    r.replica.refreshKeys();
    await r.folder.start();
    await s.settle();
    await r.vault.writeText("Team/Rules.md", "anything goes\n");
    await s.settle();
    expect(text(r.vault, "Team/Rules.md")).toBe("be nice\n");
    expect(text(a.vault, "Team/Rules.md")).toBe("be nice\n");
    expect(r.notices).toEqual(["You can only read this room. Your change was put back."]);
    await r.vault.trash("Team/Rules.md");
    await s.settle();
    expect(text(r.vault, "Team/Rules.md")).toBe("be nice\n");
  });

  it("gives clashing names the same tie-break everywhere", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    const one = randomId("f");
    const two = randomId("f");
    a.replica.editIndex((files) => {
      files.set(one, { path: "Same.md", kind: "md" });
      files.set(two, { path: "same.md", kind: "md" });
    });
    a.folder.remoteChanged();
    await s.settle();
    const names = [...a.vault.files.keys()].sort();
    expect(names).toHaveLength(2);
    const loser = one < two ? two : one;
    expect(names.some((name) => name.includes(`(${loser.slice(1, 5)})`))).toBe(true);
  });

  it("never writes outside its folder, whatever a writer puts in the index", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    a.replica.editIndex((files) => {
      files.set(randomId("f"), { path: "../escape.md", kind: "md" });
      files.set(randomId("f"), { path: ".obsidian/plugins/x/main.js", kind: "bin" });
    });
    a.folder.remoteChanged();
    await s.settle();
    expect([...a.vault.files.keys()].filter((path) => !path.startsWith("Team/"))).toEqual([]);
    expect([...a.vault.files.keys()]).toEqual([]);
  });

  it("leaves notes open in an editor to the editor", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Live.md", "start\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    const [id] = [...a.replica.files().keys()];
    a.bound.add(id!);
    a.replica.noteDoc(id!).getText("content").insert(0, "typed ");
    a.folder.remoteChanged();
    await s.settle();
    expect(text(a.vault, "Team/Live.md")).toBe("start\n");
  });
});
