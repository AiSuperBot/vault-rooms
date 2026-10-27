import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MeshNode, nextVersion, randomId, RoomReplica, WorkspaceChain, wrapRoomKey } from "@vault-rooms/secure";
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
  gone: string[];
}

function setup() {
  const { chain, ws, admin: ana } = founder();
  const { joiner: cy } = invite(chain, ana, { userName: "Cy" });
  const { joiner: rae } = invite(chain, ana, { userName: "Rae" });
  const { roomId, key } = createRoom(chain, ana, "Team", { [cy.userId]: "write", [rae.userId]: "read" });
  const net = new Network();
  const pcs = new Map<string, Pc>();
  /** A computer with this room's folder. `restart`: the same computer starting again (its stored envelopes kept). */
  const make = (device: TestDevice, folderPath: string, vault = new MemoryVault(), restart?: Pc): Pc => {
    const notices: string[] = [];
    const saved: { state: RoomFolderState | null } = { state: restart?.saved.state ?? null };
    const bound = new Set<string>();
    const gone: string[] = [];
    restart?.replica.destroy();
    const node = restart?.node ?? new MeshNode(WorkspaceChain.load(chain.all()), device.id, {
      envelope: (env) => {
        const pc = pcs.get(device.id);
        pc?.replica.receive(env);
        pc?.folder.remoteChanged();
      },
      wraps: () => pcs.get(device.id)?.replica.refreshKeys()
    });
    const replica = new RoomReplica(node, roomId, { sign: device.sign, agree: device.agree }, {
      index: () => pcs.get(device.id)?.folder.remoteChanged(),
      doc: () => pcs.get(device.id)?.folder.remoteChanged(),
      clash: (docId, lost) => pcs.get(device.id)?.folder.noteClashed(docId, lost)
    });
    const folder = new RoomFolder({
      folder: folderPath,
      replica,
      vault,
      deviceName: device.name,
      isBound: (id) => bound.has(id),
      folderGone: () => void gone.push(folderPath),
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
    const pc = { device, node, replica, vault, folder, notices, saved, bound, gone };
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
    const a2 = s.make(s.ana, "Team", a.vault, a);
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
    // Nothing of the reader's is lost: their version stays next to it, on this computer only.
    const copy = [...r.vault.files.keys()].find((path) => path.includes("(your copy"))!;
    expect(text(r.vault, copy)).toBe("anything goes\n");
    expect(r.notices[0]).toContain("was put back");
    expect([...a.vault.files.keys()].some((path) => path.includes("(your copy"))).toBe(false);
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

  it("never takes something missing from the index for a deletion", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "keep me\n");
    await a.vault.writeBytes("Team/img.png", new Uint8Array([9, 9]));
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    await a.folder.stop();
    // The device's store is lost (or its key hasn't arrived): it starts from an empty index, remembering the files.
    const fresh = s.make(s.ana, "Team", a.vault);
    fresh.saved.state = a.saved.state;
    await fresh.folder.start();
    await s.settle();
    expect(text(fresh.vault, "Team/Plan.md")).toBe("keep me\n");
    expect(fresh.vault.files.has("Team/img.png")).toBe(true);
    expect(fresh.vault.trashed).toEqual([]);
  });

  it("keeps an attachment version made at the same time as someone else's", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeBytes("Team/img.png", new Uint8Array([1]));
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
    await a.vault.writeBytes("Team/img.png", new Uint8Array([2]));
    await c.vault.writeBytes("Team/img.png", new Uint8Array([3]));
    await s.settle();
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    // Both end up with the same file, and the version that lost is kept as a copy, on both sides.
    expect([...a.vault.files.get("Team/img.png")!]).toEqual([...c.vault.files.get("Team/img.png")!]);
    const copies = (pc: typeof a) => [...pc.vault.files.keys()].filter((path) => path.includes("(conflict"));
    expect(copies(a)).toHaveLength(1);
    expect(copies(c)).toHaveLength(1);
    const kept = [...a.vault.files.get(copies(a)[0]!)!];
    expect([[2], [3]]).toContainEqual(kept);
    expect(kept).not.toEqual([...a.vault.files.get("Team/img.png")!]);
  });

  it("doesn't share or write files that could run something", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeBytes("Team/tool.ps1", new Uint8Array([1]));
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    expect(a.replica.files().size).toBe(0);
    expect(a.notices.some((n) => n.includes("tool.ps1"))).toBe(true);
    const blob = a.replica.putBlob(new Uint8Array([7]));
    a.replica.editIndex((files) => files.set(randomId("f"), { path: "run.exe", kind: "bin", blob }));
    a.folder.remoteChanged();
    await s.settle();
    expect(a.vault.files.has("Team/run.exe")).toBe(false);
  });

  it("deleting the room's folder here deletes nothing for anyone else", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/One.md", "1\n");
    await a.vault.writeText("Team/Two.md", "2\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    c.vault.removeFolder("Team");
    await s.settle();
    expect(c.gone).toEqual(["Team"]);
    expect([...a.replica.files().values()].map((entry) => entry.path).sort()).toEqual(["One.md", "Two.md"]);
    expect(text(a.vault, "Team/One.md")).toBe("1\n");
  });

  it("keeps a note too large to share on this computer, and doesn't overwrite it", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const big = "x".repeat(7 << 20);
    await a.vault.writeText("Team/Big.md", big);
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    expect(a.replica.files().size).toBe(0);
    expect(text(a.vault, "Team/Big.md")?.length).toBe(big.length);
    expect(a.notices.some((n) => n.includes("Big.md") && n.includes("too large"))).toBe(true);
  });

  it("puts a file back under its name when renamed to one that can't be shared", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "plan\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    await a.vault.rename("Team/Plan.md", `Team/${"x".repeat(130)}.md`);
    await s.settle();
    expect(text(a.vault, "Team/Plan.md")).toBe("plan\n");
    expect([...a.replica.files().values()].map((entry) => entry.path)).toEqual(["Plan.md"]);
    expect(a.notices.some((n) => n.includes("keeps its old name"))).toBe(true);
  });

  it("shares notes with Windows line endings as the editor sees them, without rewriting the file", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Win.md", "one\r\ntwo\r\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    const [id] = [...a.replica.files().keys()];
    expect(a.replica.noteText(id!)).toBe("one\ntwo\n");
    expect(text(a.vault, "Team/Win.md")).toBe("one\r\ntwo\r\n");
    await a.vault.writeText("Team/Win.md", "one\r\ntwo\r\nthree\r\n");
    await s.settle();
    expect(a.replica.noteText(id!)).toBe("one\ntwo\nthree\n");
  });

  it("brings someone else's edit into a note with Windows line endings", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Win.md", "one\r\ntwo\r\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    await c.vault.writeText("Team/Win.md", "one\ntwo\nthree from Cy\n");
    await s.settle();
    expect(text(a.vault, "Team/Win.md")).toBe("one\ntwo\nthree from Cy\n");
  });

  it("keeps an edit that may not have been stored before Obsidian stopped", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
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
    // Ana edits, but her disk never manages to store the change before Obsidian stops.
    a.node.persist = () => Promise.reject(new Error("disk full"));
    await a.vault.writeText("Team/Plan.md", "base\nAna's last words\n");
    await s.settle();
    await a.folder.stop();
    // Ana starts again: her store lacks the edit (Cy has the version before it), her file has it.
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    const files = [...again.vault.files.keys()];
    const copy = files.find((path) => path.includes("(conflict"));
    expect(copy && text(again.vault, copy)).toBe("base\nAna's last words\n");
  });

  it("doesn't hold in doubt an edit stored just as Obsidian stopped", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    // A slow disk: Obsidian stops while the last edit is still being written.
    a.node.persist = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
    await a.vault.writeText("Team/Plan.md", "base\nlast words\n");
    await a.folder.stop();
    expect(Object.values(a.saved.state!.known).filter((known) => known.unstored)).toEqual([]);
  });

  it("keeps an edit that may not have been stored when someone else deletes the file", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
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
    a.node.persist = () => Promise.reject(new Error("disk full"));
    await a.vault.writeText("Team/Plan.md", "base\nAna's last words\n");
    await s.settle();
    await a.folder.stop();
    await c.vault.trash("Team/Plan.md");
    await s.settle();
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect(text(again.vault, "Team/Plan.md")).toBe("base\nAna's last words\n");
    expect(text(c.vault, "Team/Plan.md")).toBe("base\nAna's last words\n");
  });

  it("shares again a new file whose entry wasn't stored before Obsidian stopped", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    link.cut();
    a.node.persist = () => Promise.reject(new Error("disk full"));
    await a.vault.writeText("Team/New.md", "");
    await s.settle();
    await a.folder.stop();
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect([...c.replica.files().values()].map((entry) => entry.path)).toEqual(["New.md"]);
  });

  it("deletes a file it never changed when someone else does, even while its own writes are slow", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await c.vault.writeText("Team/Cy.md", "from Cy\n");
    await s.settle();
    // Ana's disk is stuck while she adds a note; meanwhile Cy edits his note, then deletes it.
    a.node.persist = () => new Promise<void>(() => {});
    await a.vault.writeText("Team/New.md", "new\n");
    await s.settle();
    await c.vault.writeText("Team/Cy.md", "from Cy, edited\n");
    await s.settle();
    expect(text(a.vault, "Team/Cy.md")).toBe("from Cy, edited\n");
    await c.vault.trash("Team/Cy.md");
    await s.settle();
    expect(a.vault.files.has("Team/Cy.md")).toBe(false);
    expect(a.notices.filter((message) => message.includes("deleted by someone else"))).toEqual([]);
  });

  it("deletes a file it never changed when someone else did while it was off, even if its own last writes failed", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    const link = s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await c.vault.writeText("Team/Cy.md", "from Cy\n");
    await s.settle();
    // Ana's disk fails while she adds a note and Cy's edit comes in; then Obsidian stops.
    a.node.persist = () => Promise.reject(new Error("disk full"));
    await a.vault.writeText("Team/New.md", "new\n");
    await s.settle();
    await c.vault.writeText("Team/Cy.md", "from Cy, edited\n");
    await s.settle();
    await a.folder.stop();
    link.cut();
    // While Ana is away, Cy deletes his note.
    await c.vault.trash("Team/Cy.md");
    await s.settle();
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect(again.vault.files.has("Team/Cy.md")).toBe(false);
    expect([...c.replica.files().values()].map((entry) => entry.path)).toEqual(["New.md"]);
  });

  it("never writes over a note held back here, even when someone else changes it", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    const [id] = [...a.replica.files().keys()];
    // An editor's change to the note couldn't be shared, so the note is held back here; then Cy changes it.
    a.folder.holdBackNote(id!);
    await c.vault.writeText("Team/Plan.md", "base\nfrom Cy\n");
    await s.settle();
    expect(text(a.vault, "Team/Plan.md")).toBe("base\n");
  });

  it("takes another change to a new note still waiting for the room key as a change, not as one more new note", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const c = s.make(s.cy, "Team");
    s.net.link(a.node, c.node);
    await a.folder.start();
    await a.vault.writeText("Team/Early.md", "early\n");
    await s.settle();
    await a.vault.writeText("Team/Early.md", "early, then more\n");
    await s.settle();
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.folder.remoteChanged();
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    expect([...c.replica.files().values()].map((entry) => entry.path)).toEqual(["Early.md"]);
    expect(text(c.vault, "Team/Early.md")).toBe("early, then more\n");
  });

  it("shares again a note made while the room key was missing, if Obsidian stopped before its entry was stored", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    const c = s.make(s.cy, "Team");
    s.net.link(a.node, c.node);
    await a.folder.start();
    // No room key yet: Ana's new note waits for it; when it comes, her disk fails, and Obsidian stops.
    await a.vault.writeText("Team/Early.md", "early\n");
    await s.settle();
    a.node.persist = () => Promise.reject(new Error("disk full"));
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.folder.remoteChanged();
    await s.settle();
    await a.folder.stop();
    const again = s.make(s.ana, "Team", a.vault);
    again.saved.state = a.saved.state;
    s.net.link(again.node, c.node);
    await s.settle();
    again.replica.refreshKeys();
    await again.folder.start();
    await s.settle();
    expect([...c.replica.files().values()].map((entry) => entry.path)).toEqual(["Early.md"]);
  });

  it("keeps a change another program made as a copy, rather than undo someone's edit not written here yet", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    const c = s.make(s.cy, "Team");
    s.giveKey(a, s.ana);
    s.giveKey(a, s.cy);
    a.replica.refreshKeys();
    await a.folder.start();
    s.net.link(a.node, c.node);
    await s.settle();
    c.replica.refreshKeys();
    await c.folder.start();
    await s.settle();
    // Cy's edit reaches Ana's computer; before it is written there, a script changes the file on Ana's.
    await c.vault.writeText("Team/Plan.md", "base\nfrom Cy\n");
    await c.folder.settled();
    s.net.pump();
    await a.vault.writeText("Team/Plan.md", "base\nfrom a script\n");
    await s.settle();
    expect(text(c.vault, "Team/Plan.md")).toBe("base\nfrom Cy\n");
    expect(text(a.vault, "Team/Plan.md")).toBe("base\nfrom Cy\n");
    const copy = [...a.vault.files.keys()].find((path) => path.includes("(conflict"));
    expect(copy && text(a.vault, copy)).toBe("base\nfrom a script\n");
  });

  it("doesn't sync a folder whose last synced state can't be read, and leaves that state alone", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.vault.writeText("Team/Plan.md", "here\n");
    let saves = 0;
    const folder = new RoomFolder({
      folder: "Team",
      replica: a.replica,
      vault: a.vault,
      deviceName: "PC",
      isBound: () => false,
      loadState: () => Promise.reject(new Error("locked")),
      saveState: async () => void saves++,
      notify: (message) => a.notices.push(message),
      log: () => {}
    });
    await folder.start();
    await folder.onLocalWrite("Team/Plan.md");
    await folder.stop();
    expect(saves).toBe(0);
    expect(a.replica.files().size).toBe(0);
    expect(a.notices.join()).toMatch(/isn't syncing/);
  });

  it("does nothing more once the room's replica is let go", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Plan.md", "base\n");
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    const [id] = [...a.replica.files().keys()];
    // A change still queued when the room goes (access ended, or the room is being made again).
    void a.folder.onLocalWrite("Team/Plan.md");
    a.vault.files.set("Team/Plan.md", new TextEncoder().encode("changed\n"));
    a.replica.destroy();
    expect(() => a.replica.editIndex(() => {})).toThrow(/destroyed/);
    await a.folder.stop();
    expect(a.saved.state!.known[id!]!.hash).toBe(createHash("sha256").update("base\n").digest("base64url"));
  });

  it("doesn't call a newer version of someone else's attachment a clash", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeBytes("Team/img.png", new Uint8Array([1]));
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
    // Ana saves the image twice while Cy is away; Cy then gets only the newest.
    await a.vault.writeBytes("Team/img.png", new Uint8Array([2]));
    await s.settle();
    await a.vault.writeBytes("Team/img.png", new Uint8Array([3]));
    await s.settle();
    s.net.link(a.node, c.node);
    await s.settle();
    expect([...c.vault.files.get("Team/img.png")!]).toEqual([3]);
    expect([...c.vault.files.keys()].filter((path) => path.includes("(conflict"))).toEqual([]);
  });

  it("shares a deletion made just before stopping, and an attachment added back after its blob was cleaned up", async () => {
    const s = setup();
    const a = s.make(s.ana, "Team");
    await a.vault.writeText("Team/Gone.md", "bye\n");
    await a.vault.writeBytes("Team/report.pdf", new Uint8Array([5, 5]));
    s.giveKey(a, s.ana);
    a.replica.refreshKeys();
    await a.folder.start();
    await s.settle();
    await a.vault.trash("Team/Gone.md");
    await a.folder.stop();
    expect([...a.replica.files().values()].map((entry) => entry.path)).toEqual(["report.pdf"]);
    // The PDF is deleted and its blob cleaned up; the same file is added back later.
    const again = s.make(s.ana, "Team", a.vault, a);
    await again.folder.start();
    await a.vault.trash("Team/report.pdf");
    await s.settle();
    const [meta] = again.node.store.blobsOf(s.roomId);
    again.node.store.dropBlobs(s.roomId, [`${meta!.author}/${meta!.id}`]);
    await a.vault.writeBytes("Team/report.pdf", new Uint8Array([5, 5]));
    await s.settle();
    expect([...again.replica.files().values()].map((entry) => entry.path)).toEqual(["report.pdf"]);
    expect(again.node.store.blobKeys(s.roomId)).toHaveLength(1);
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

  /** Ana and Cy, both writers, sharing the room's folder (Ana's files first). */
  async function pair(files: Record<string, string | Uint8Array> = {}) {
    const s = setup();
    const a = s.make(s.ana, "Team");
    for (const [path, content] of Object.entries(files)) {
      if (typeof content === "string") await a.vault.writeText(path, content);
      else await a.vault.writeBytes(path, content);
    }
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
    return { s, a, c, link };
  }

  it("keeps one of two values saved at the same moment in the same place, and the other as a copy", async () => {
    const { s, a, c, link } = await pair({ "Team/Task.md": "---\ndue: 2030-01-01\n---\nPlan\n" });
    link.cut();
    // Another plugin writes a different date on each computer while they are apart.
    await a.vault.writeText("Team/Task.md", "---\ndue: 2030-01-03\n---\nPlan\n");
    await a.folder.settled();
    await c.vault.writeText("Team/Task.md", "---\ndue: 2030-01-04\n---\nPlan\n");
    await c.folder.settled();
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    const main = text(a.vault, "Team/Task.md")!;
    expect(text(c.vault, "Team/Task.md")).toBe(main);
    expect(["---\ndue: 2030-01-03\n---\nPlan\n", "---\ndue: 2030-01-04\n---\nPlan\n"]).toContain(main);
    const other = main.includes("01-03") ? "---\ndue: 2030-01-04\n---\nPlan\n" : "---\ndue: 2030-01-03\n---\nPlan\n";
    const copies = [a.vault, c.vault].flatMap((vault) => [...vault.files.keys()].filter((path) => path.includes("(conflict")).map((path) => text(vault, path)));
    expect(copies).toContain(other);
  });

  it("keeps a new save of an attachment made while its clash copy was being written", async () => {
    const { s, a, c, link } = await pair({ "Team/img.png": new Uint8Array([1]) });
    link.cut();
    await a.vault.writeBytes("Team/img.png", new Uint8Array([2]));
    await a.folder.settled();
    await c.vault.writeBytes("Team/img.png", new Uint8Array([3]));
    await c.folder.settled();
    // Whichever computer keeps its own version aside to take the other's, its user saves the image once more meanwhile.
    const saved: string[] = [];
    for (const [pc, again] of [[a, 4], [c, 5]] as const) {
      pc.vault.beforeGuardedWrite = (path) => {
        if (path !== "Team/img.png" || saved.includes(pc.device.name)) return;
        saved.push(pc.device.name);
        void pc.vault.writeBytes(path, new Uint8Array([again]));
      };
    }
    s.net.link(a.node, c.node);
    await s.settle();
    await s.settle();
    expect(saved).toHaveLength(1);
    const [pc, mine, again] = saved[0] === a.device.name ? [a, 2, 4] : [c, 3, 5];
    const versions = [...pc.vault.files.entries()].filter(([path]) => path.startsWith("Team/img")).map(([, bytes]) => [...bytes]);
    expect(versions).toContainEqual([again]);
    expect(versions).toContainEqual([mine]);
  });

  it("doesn't read attachments that didn't change when a note does", async () => {
    const { s, a, c } = await pair({ "Team/img.png": new Uint8Array(1000).fill(7), "Team/Plan.md": "plan\n" });
    let reads = 0;
    const read = a.replica.readBlob.bind(a.replica);
    a.replica.readBlob = (ref) => (reads++, read(ref));
    await c.vault.writeText("Team/Plan.md", "plan\nmore\n");
    await s.settle();
    expect(text(a.vault, "Team/Plan.md")).toBe("plan\nmore\n");
    expect(reads).toBe(0);
  });

  it("passes on the work of someone who may no longer write to a computer that catches up later", async () => {
    const { s, a, c } = await pair();
    await c.vault.writeText("Team/Cy.md", "from Cy\n");
    await c.vault.writeBytes("Team/pic.png", new Uint8Array([7, 7]));
    await s.settle();
    // Cy may only read from now on; then Rae's computer catches up, from Ana's alone.
    a.node.offerVersions([nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => void (state.rooms[s.roomId]!.members[s.cy.userId] = "read"))]);
    s.giveKey(a, s.rae);
    const r = s.make(s.rae, "Team");
    s.net.link(r.node, a.node);
    await s.settle();
    r.replica.refreshKeys();
    await r.folder.start();
    await s.settle();
    a.replica.passOnOldWork((author) => author === s.ana.id);
    await s.settle();
    await s.settle();
    expect(text(r.vault, "Team/Cy.md")).toBe("from Cy\n");
    expect([...(r.vault.files.get("Team/pic.png") ?? [])]).toEqual([7, 7]);
  });
});
