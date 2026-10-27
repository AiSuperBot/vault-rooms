import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { fromUtf8, utf8 } from "./bytes.js";
import { WorkspaceChain } from "./chain.js";
import { randomId } from "./ids.js";
import { keyCommitment, newRoomKey, wrapRoomKey } from "./keys.js";
import { envelopeKey, openEnvelope, sealSnapshot } from "./envelope.js";
import { MeshNode } from "./mesh.js";
import { pathKey, safeRoomPath } from "./paths.js";
import { RoomReplica, type FileEntry } from "./replica.js";
import { STORE_LIMITS } from "./store.js";
import { createRoom, founder, invite, Network, step, type TestDevice } from "./testkit.js";
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

  it("shares attachments as encrypted blobs others can check", async () => {
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
    await s.net.settle();
    c.replica.refreshKeys();
    const entry = c.replica.files().get(fileId)!;
    expect(fromUtf8((await c.replica.readBlob(entry.blob!))!)).toBe("PNG bytes");
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

  it("a snapshot that lies about what it covers takes nothing away from members and freezes nothing", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    s.net.link(a.node, c.node);
    s.net.pump();
    c.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "Keep me");
    s.net.pump();
    // Cy, a writer, publishes an empty state claiming to cover every counter of everyone.
    const lie = sealSnapshot({ ws: s.ws, room: s.roomId, n: 1, key: s.key, author: s.cy.sign }, fileId, 1, { [s.ana.id]: Number.MAX_SAFE_INTEGER, [s.cy.id]: Number.MAX_SAFE_INTEGER }, Y.encodeStateAsUpdate(new Y.Doc()));
    expect(c.node.publish(lie)).toBe(true);
    s.net.pump();
    // Ana keeps every update (the snapshot doesn't contain them), and her text and counters are untouched.
    expect(a.node.store.envelopesOf(s.roomId, fileId).updates.length).toBeGreaterThan(0);
    expect(a.replica.reload(fileId).getText("content").toString()).toBe("Keep me");
    expect(a.node.store.maxClock(s.roomId, fileId, s.ana.id)).toBeLessThan(10);
    a.replica.noteDoc(fileId).getText("content").insert(7, " and more");
    s.net.pump();
    expect(c.replica.noteText(fileId)).toBe("Keep me and more");
  });

  /** Ana, Cy and Ben, all writers, each linked to the other two, sharing a note. */
  function triangle() {
    const s = setup();
    step(s.chain, s.ana, (state) => void (state.rooms[s.roomId]!.members[s.ben.userId] = "write"));
    for (const device of [s.ana, s.cy, s.ben, s.rae]) s.wrapFor(device);
    const [a, c, b] = [s.member(s.ana), s.member(s.cy), s.member(s.ben)];
    s.net.link(a.node, c.node);
    s.net.link(c.node, b.node);
    s.net.link(a.node, b.node);
    s.net.pump();
    for (const m of [a, c, b]) m.replica.refreshKeys();
    return { s, a, c, b };
  }

  it("lets go of a snapshot dropped as contained in another, instead of passing it around for ever", () => {
    const { s, a, c, b } = triangle();
    const fileId = addNote(a.replica, "Plan.md", "hello\n");
    s.net.pump();
    for (const m of [a, c, b]) m.replica.noteText(fileId);
    // Two writers snapshot the same note at once: one snapshot stays everywhere, and the network goes quiet.
    c.replica.snapshot(fileId);
    b.replica.snapshot(fileId);
    expect(() => s.net.pump(5_000)).not.toThrow();
    const kept = [a, c, b].map((m) => m.node.store.envelopesOf(s.roomId, fileId).snapshots.map((snapshot) => envelopeKey(snapshot)).join());
    expect(new Set(kept).size).toBe(1);
  });

  it("passes a former writer's work on only once it waited, if not the first writer to do it", () => {
    const { s, a, b } = triangle();
    const fileId = addNote(b.replica, "Ben.md", "Ben's work\n");
    s.net.pump();
    a.replica.noteText(fileId);
    const snapshots = () => a.node.store.envelopesOf(s.roomId, fileId).snapshots.length;
    a.replica.passOnOldWork((author) => author !== s.ben.id, false);
    expect(snapshots()).toBe(0);
    a.replica.passOnOldWork((author) => author !== s.ben.id, true);
    expect(snapshots()).toBe(1);
  });

  it("doesn't read and seal a former writer's file again and again when there is no room left for a copy", async () => {
    const { s, a, b } = triangle();
    const blob = b.replica.putBlob(utf8("Ben's picture"));
    b.replica.editIndex((files) => files.set(randomId("f"), { path: "pic.png", kind: "bin", blob }));
    s.net.pump();
    let reads = 0;
    const read = a.replica.readBlob.bind(a.replica);
    a.replica.readBlob = (ref) => (reads++, read(ref));
    const limit = STORE_LIMITS.memberBlobBytes;
    STORE_LIMITS.memberBlobBytes = 0;
    try {
      for (let run = 0; run < 3; run++) {
        a.replica.passOnOldWork((author) => author !== s.ben.id);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      STORE_LIMITS.memberBlobBytes = limit;
    }
    expect(reads).toBe(1);
  });

  it("never lets the snapshot of someone who may no longer write push out a writer's", () => {
    // Device ids are random, and which of two equal snapshots stays depends on them: tried several times.
    for (let round = 0; round < 8; round++) passedOnToLatePeer();
  });

  function passedOnToLatePeer() {
    const { s, a, c, b } = triangle();
    const fileId = addNote(b.replica, "Ben.md", "Ben's work\n");
    s.net.pump();
    for (const m of [a, c]) m.replica.noteText(fileId);
    // Ben snapshots his note; then his computer is revoked, and Ana passes his work on (the same content).
    b.replica.snapshot(fileId);
    s.net.pump();
    const revoked = nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => void (state.devices[s.ben.id]!.revoked = true));
    for (const m of [a, c]) m.node.offerVersions([revoked]);
    const writes = (author: string) => author !== s.ben.id;
    a.replica.passOnOldWork(writes);
    s.net.pump();
    for (const m of [a, c]) expect(m.node.store.envelopesOf(s.roomId, fileId).snapshots.map((snapshot) => snapshot.author)).toEqual([s.ana.id]);
    // Rae's computer catches up later, from Cy's alone.
    const r = s.member(s.rae);
    r.node.offerVersions([revoked]);
    s.net.link(c.node, r.node);
    s.net.pump();
    r.replica.refreshKeys();
    expect(r.replica.noteText(fileId)).toBe("Ben's work\n");
  }

  it("an honest snapshot is checked, then replaces what it really contains", () => {
    const s = setup();
    const a = s.member(s.ana);
    s.wrapFor(s.ana);
    a.replica.refreshKeys();
    const fileId = addNote(a.replica, "Plan.md", "One");
    a.replica.noteDoc(fileId).getText("content").insert(3, " two");
    const before = a.node.store.envelopesOf(s.roomId, fileId).updates.length;
    expect(a.replica.snapshot(fileId)).not.toBeNull();
    expect(before).toBeGreaterThan(0);
    expect(a.node.store.envelopesOf(s.roomId, fileId).updates).toHaveLength(0);
    expect(a.replica.reload(fileId).getText("content").toString()).toBe("One two");
    expect(a.node.store.vv(s.roomId, fileId)[s.ana.id]).toBe(before);
  });

  it("seals new content only under the room's newest key, holding edits until it arrives", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    c.replica.refreshKeys();
    s.net.link(a.node, c.node);
    s.net.pump();
    const fileId = addNote(a.replica, "Plan.md", "Before");
    s.net.pump();
    // Ana removes Rae and rotates; Cy learns of the new epoch before she has its key.
    const k2 = newRoomKey();
    a.node.offerVersions([
      nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => {
        delete state.rooms[s.roomId]!.members[s.rae.userId];
        state.rooms[s.roomId]!.epochs.push({ n: 2, commit: keyCommitment(s.ws, s.roomId, 2, k2) });
      })
    ]);
    a.replica.addOwnKey(2, k2);
    s.net.pump();
    expect(c.replica.sealEpoch()).toBeNull();
    expect(c.replica.edit(fileId, (doc) => doc.getText("content").insert(6, " (Cy)"))).toBe("queued");
    // Nothing went out under the old key, which Rae still has.
    expect(a.node.store.envelopesOf(s.roomId, fileId).updates.every((u) => u.author !== s.cy.id)).toBe(true);
    s.wrapFor(s.cy, 2, k2);
    s.net.pump();
    expect(a.replica.noteText(fileId)).toBe("Before (Cy)");
    expect(a.node.store.envelopesOf(s.roomId, fileId).updates.filter((u) => u.author === s.cy.id).every((u) => u.n === 2)).toBe(true);
  });

  it("drops a key the record no longer backs, and sends again what was sealed under it", () => {
    const s = setup();
    const a = s.member(s.ana);
    const c = s.member(s.cy);
    s.wrapFor(s.ana);
    s.wrapFor(s.cy);
    a.replica.refreshKeys();
    c.replica.refreshKeys();
    const link = s.net.link(a.node, c.node);
    s.net.pump();
    const fileId = addNote(a.replica, "Plan.md", "Start");
    s.net.pump();
    link.cut();
    // Apart, both start epoch 2 with their own key, and Cy writes under hers.
    const kc = newRoomKey();
    const ka = newRoomKey();
    c.node.offerVersions([nextVersion(s.ws, c.node.chain.head, s.cy.sign, (state) => void state.rooms[s.roomId]!.epochs.push({ n: 2, commit: keyCommitment(s.ws, s.roomId, 2, kc) }))]);
    c.replica.addOwnKey(2, kc);
    c.replica.noteDoc(fileId).getText("content").insert(5, " by Cy");
    a.node.offerVersions([nextVersion(s.ws, a.node.chain.head, s.ana.sign, (state) => void state.rooms[s.roomId]!.epochs.push({ n: 2, commit: keyCommitment(s.ws, s.roomId, 2, ka) }))]);
    a.replica.addOwnKey(2, ka);
    // They meet: Ana's rotation wins (she is an admin). Cy drops her key and gets Ana's.
    s.net.link(a.node, c.node);
    s.net.pump();
    expect(c.node.chain.headHash).toBe(a.node.chain.headHash);
    c.replica.refreshKeys();
    expect(c.replica.keyFor(2)).toBeUndefined();
    expect(a.replica.noteText(fileId)).toBe("Start");
    s.wrapFor(s.cy, 2, ka);
    s.net.pump();
    expect(a.replica.noteText(fileId)).toBe("Start by Cy");
  });

  it("refuses an edit it can't share and rebuilds the document without it", () => {
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
    expect(r.replica.edit(fileId, (doc) => doc.getText("content").insert(0, "Vandal "))).toBe("refused");
    expect(r.refused).toEqual([]);
    expect(r.replica.noteText(fileId)).toBe("Original");
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
