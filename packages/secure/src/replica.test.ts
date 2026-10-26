import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { fromUtf8, utf8 } from "./bytes.js";
import { WorkspaceChain } from "./chain.js";
import { randomId } from "./ids.js";
import { keyCommitment, newRoomKey, wrapRoomKey } from "./keys.js";
import { openEnvelope } from "./envelope.js";
import { MeshNode } from "./mesh.js";
import { pathKey, safeRoomPath } from "./paths.js";
import { RoomReplica, type FileEntry } from "./replica.js";
import { createRoom, founder, invite, Network, type TestDevice } from "./testkit.js";
import { nextVersion } from "./workspace.js";

describe("room paths", () => {
  it("accept ordinary names, in any script", () => {
    for (const ok of ["Plan.md", "Design/Notes.md", "תכנית עבודה.md", "a b/c-d_e (1).png", "日本語/メモ.md"]) expect(safeRoomPath(ok)).toBe(ok.normalize("NFC"));
  });
  it("refuse anything that could leave the room folder or reach Obsidian's configuration", () => {
    for (const bad of ["../evil.md", "a/../../b.md", "/etc/passwd", "C:/Windows/x", "C:x", ".obsidian/plugins/x/main.js", "Notes/.obsidian/app.json", ".trash/x", "a\\b", "a//b", "", "con.md", "Notes/NUL", "lpt1.txt", "end.", "end ", "a:b", "tab\there", `${"x".repeat(121)}.md`]) {
      expect(safeRoomPath(bad), bad).toBeNull();
    }
    expect(safeRoomPath(42)).toBeNull();
  });
  it("compare case- and form-insensitively", () => {
    expect(pathKey("Notes.md")).toBe(pathKey("NOTES.md"));
    expect(pathKey("e\u0301.md")).toBe(pathKey("\u00e9.md"));
  });
});

interface Member {
  device: TestDevice;
  node: MeshNode;
  replica: RoomReplica;
  refused: string[];
}

function setup() {
  const { chain, ws, admin: ana } = founder();
  const { joiner: cy } = invite(chain, ana, { userName: "Cy" });
  const { joiner: rae } = invite(chain, ana, { userName: "Rae" });
  const { joiner: ben } = invite(chain, ana, { userName: "Ben" });
  const { roomId, key } = createRoom(chain, ana, "Plans", { [cy.userId]: "write", [rae.userId]: "read" });
  const net = new Network();
  const nodes = new Map<string, MeshNode>();
  const members = new Map<string, Member>();
  const nodeOf = (device: TestDevice) => {
    let node = nodes.get(device.id);
    if (!node) {
      node = new MeshNode(WorkspaceChain.load(chain.all()), device.id, {
        envelope: (env) => members.get(device.id)?.replica.receive(env),
        wraps: () => members.get(device.id)?.replica.refreshKeys()
      });
      nodes.set(device.id, node);
    }
    return node;
  };
  const member = (device: TestDevice): Member => {
    const node = nodeOf(device);
    const refused: string[] = [];
    const replica = new RoomReplica(node, roomId, { sign: device.sign, agree: device.agree }, { localRefused: (_doc, code) => refused.push(code) });
    const m = { device, node, replica, refused };
    members.set(device.id, m);
    return m;
  };
  // Ana wraps the key to every member's device, her own included.
  const wrapFor = (device: TestDevice, n = 1, k = key) => nodeOf(ana).addWrap(wrapRoomKey(ws, roomId, n, k, { id: device.id, agree: device.agree.publicKey }, ana.sign));
  return { chain, ws, ana, cy, rae, ben, roomId, key, net, nodeOf, member, wrapFor };
}

function addNote(replica: RoomReplica, path: string, text: string): string {
  const fileId = randomId("f");
  replica.editIndex((files) => files.set(fileId, { path, kind: "md" }));
  const doc = replica.noteDoc(fileId);
  doc.getText("content").insert(0, text);
  return fileId;
}

describe("room replica", () => {
  it("co-edits a note: both sides converge, including edits made while apart", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    const link = s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Hello");
    s.net.pump();
    expect([...c.replica.files().values()]).toEqual([{ path: "Plan.md", kind: "md" }]);
    expect(c.replica.noteText(fileId)).toBe("Hello");
    // Apart: Ana appends, Cy prepends.
    link.cut();
    a.replica.noteDoc(fileId).getText("content").insert(5, " world");
    c.replica.noteDoc(fileId).getText("content").insert(0, "Hi! ");
    s.net.link(a.node, c.node);
    s.net.pump();
    expect(a.replica.noteText(fileId)).toBe("Hi! Hello world");
    expect(c.replica.noteText(fileId)).toBe("Hi! Hello world");
  });

  it("keeps readers' local edits to themselves", () => {
    const s = setup();
    const a = s.member(s.ana);
    const r = s.member(s.rae);
    s.wrapFor(s.ana);
    s.wrapFor(s.rae);
    a.replica.refreshKeys();
    s.net.link(a.node, r.node);
    s.net.pump();
    r.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Original");
    s.net.pump();
    expect(r.replica.canWrite()).toBe(false);
    r.replica.noteDoc(fileId).getText("content").insert(0, "Vandal ");
    expect(r.refused).toEqual(["read_only"]);
    expect(r.replica.reload(fileId).getText("content").toString()).toBe("Original");
    s.net.pump();
    expect(a.replica.noteText(fileId)).toBe("Original");
  });

  it("shows nothing until the key arrives, then everything", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    a.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Secret plan");
    s.net.link(a.node, c.node);
    s.net.pump();
    expect(c.replica.files().size).toBe(0);
    expect(c.replica.epochsMissing()).toEqual([1]);
    s.wrapFor(s.cy);
    s.net.pump();
    expect(c.replica.noteText(fileId)).toBe("Secret plan");
  });

  it("keeps edits made before any key arrived, and sends them once one does", () => {
    const s = setup();
    const a = s.member(s.ana);
    const fileId = randomId("f");
    a.replica.editIndex((files) => files.set(fileId, { path: "Early.md", kind: "md" }));
    expect(a.node.store.envelopesOf(s.roomId, "index").updates).toHaveLength(0);
    a.replica.addOwnKey(1, s.key);
    expect(a.node.store.envelopesOf(s.roomId, "index").updates).toHaveLength(1);
    const c = s.member(s.cy);
    s.wrapFor(s.cy);
    s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    expect(c.replica.files().get(fileId)?.path).toBe("Early.md");
  });

  it("never lists a path that could leave the room folder", () => {
    const s = setup();
    const a = s.member(s.ana);
    s.wrapFor(s.ana);
    a.replica.refreshKeys();
    a.replica.editIndex((files) => {
      files.set(randomId("f"), { path: "../outside.md", kind: "md" });
      files.set(randomId("f"), { path: ".obsidian/plugins/evil/main.js", kind: "bin" });
      files.set(randomId("f"), { path: "Fine.md", kind: "md" });
      files.set(randomId("f"), { path: "Odd.md", kind: "exe" } as unknown as FileEntry);
    });
    expect([...a.replica.files().values()].map((f) => f.path)).toEqual(["Fine.md"]);
  });

  it("shares attachments as encrypted blobs others can check", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    const ref = a.replica.putBlob(utf8("PNG bytes"));
    const fileId = randomId("f");
    a.replica.editIndex((files) => files.set(fileId, { path: "img.png", kind: "bin", blob: ref }));
    s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    const entry = c.replica.files().get(fileId)!;
    expect(fromUtf8(c.replica.readBlob(entry.blob!)!)).toBe("PNG bytes");
  });

  it("compacts with a snapshot that a newcomer can start from", () => {
    const s = setup();
    const a = s.member(s.ana);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    const fileId = addNote(a.replica, "Long.md", "");
    const text = a.replica.noteDoc(fileId).getText("content");
    for (let i = 0; i < 50; i++) text.insert(text.length, `line ${i}\n`);
    expect(a.replica.snapshot(fileId)).not.toBeNull();
    expect(a.node.store.envelopesOf(s.roomId, fileId).updates).toHaveLength(0);
    const c = s.member(s.cy);
    s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    expect(c.replica.noteText(fileId)).toBe(text.toString());
  });

  it("after a key rotation, a removed member can't read new content", () => {
    const s = setup();
    const a = s.member(s.ana);
    s.wrapFor(s.ana);
    a.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Before");
    // Rae is removed and the key rotated in the same change.
    const k2 = newRoomKey();
    a.node.offerVersions([
      nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => {
        delete state.rooms[s.roomId]!.members[s.rae.userId];
        state.rooms[s.roomId]!.epochs.push({ n: 2, commit: keyCommitment(s.ws, s.roomId, 2, k2) });
      })
    ]);
    a.replica.addOwnKey(2, k2);
    a.replica.noteDoc(fileId).getText("content").insert(6, " and after");
    const latest = a.node.store.envelopesOf(s.roomId, fileId).updates.at(-1)!;
    expect(latest.n).toBe(2);
    // Rae's last key is epoch 1: the new update doesn't open with it; it does with the new key.
    expect(() => openEnvelope(latest, s.key)).toThrow(/decrypt_failed/);
    const update = openEnvelope(latest, k2);
    const check = new Y.Doc();
    Y.applyUpdate(check, update);
    expect(update.length).toBeGreaterThan(0);
  });
});
