import { describe, expect, it } from "vitest";
import {
  createGenesis,
  INDEX_DOC,
  MeshNode,
  RoomReplica,
  keyCommitment,
  newAgreementKeyPair,
  newRoomKey,
  newSigningKeyPair,
  nextVersion,
  randomId,
  sealBlob,
  sealRoomName,
  sealSnapshot,
  sealUpdate,
  utf8,
  WorkspaceChain,
  wrapRoomKey
} from "@vault-rooms/secure";
import { createRoom, founder, invite, Network } from "@vault-rooms/secure/testkit";
import { DiskStore, fileNameOf } from "../../src/mesh/diskStore.js";
import { MemoryFiles } from "./memoryFiles.js";

function world() {
  const sign = newSigningKeyPair();
  const agree = newAgreementKeyPair();
  const { genesis, workspaceId, userId, deviceId } = createGenesis({ workspaceName: "Team", userName: "Ana", deviceName: "PC", deviceKey: sign, agreementPublicKey: agree.publicKey, tlsFingerprint: "A".repeat(43) });
  const chain = new WorkspaceChain(genesis);
  const roomId = randomId("r");
  const key = newRoomKey();
  chain.offer([
    nextVersion(workspaceId, chain.head, sign, (state) => {
      state.rooms[roomId] = { creator: userId, name: sealRoomName(workspaceId, roomId, 1, key, "Plans"), members: { [userId]: "manage" }, epochs: [{ n: 1, commit: keyCommitment(workspaceId, roomId, 1, key) }] };
    })
  ]);
  const ctx = { ws: workspaceId, room: roomId, n: 1, key, author: sign };
  return { chain, workspaceId, deviceId, sign, agree, roomId, key, ctx };
}

const docFile = (root: string, room: string, doc: string) => `${root}/docs/${fileNameOf(room)}/${fileNameOf(doc)}.jsonl`;
const lines = (text: string) => text.split("\n").filter((line) => line.trim());

describe("disk store", () => {
  it.each(["json", "ciphertext", "missing"])("refetches an attachment with a damaged %s cache from an already connected peer", async (damage) => {
    const { chain, ws, admin } = founder();
    const { joiner } = invite(chain, admin, { userName: "Reader" });
    const { roomId, key } = createRoom(chain, admin, "Files", { [joiner.userId]: "read" });
    const source = new MeshNode(WorkspaceChain.load(chain.all()), admin.id);
    const blob = sealBlob({ ws, room: roomId, n: 1, key, author: admin.sign }, utf8("original attachment"));
    source.publish(blob);
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    (await disk.open()).add(blob);
    await disk.flush();
    const path = [...files.data.keys()].find((p) => p.includes("/blobs/") && p.endsWith(".json"))!;
    if (damage === "json") files.data.set(path, '{"k":"b"');
    else if (damage === "ciphertext") files.data.set(path, JSON.stringify({ ...blob, ct: (blob.ct[0] === "A" ? "B" : "A") + blob.ct.slice(1) }));
    const damaged = new DiskStore(files, "m");
    const store = await damaged.open();
    if (damage === "missing") files.data.delete(path);
    const receiver = new MeshNode(WorkspaceChain.load(chain.all()), joiner.id, {}, store);
    const replica = new RoomReplica(receiver, roomId, { sign: joiner.sign, agree: joiner.agree });
    replica.addOwnKey(1, key);
    const net = new Network();
    net.link(source, receiver);
    try {
      await net.settle();
      expect(store.digest(roomId)).toBe(source.store.digest(roomId));
      const ref = { by: admin.id, id: blob.id, n: 1, size: utf8("original attachment").length };
      expect(await replica.readBlob(ref)).toBeNull();
      expect(store.blobKeys(roomId)).toEqual([]);
      expect(store.gone(roomId)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 120));
      await net.settle();
      await damaged.flush();
      expect(await replica.readBlob(ref)).toEqual(utf8("original attachment"));
      expect(store.digest(roomId)).toBe(source.store.digest(roomId));
      const reopened = await new DiskStore(files, "m").open();
      expect(await reopened.loadBlob(roomId, admin.id, blob.id)).toEqual(blob);
    } finally { replica.destroy(); source.stop(); receiver.stop(); }
  });

  it("keeps a temporarily locked attachment and reads it after unlocking", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const blob = sealBlob(w.ctx, utf8("locked attachment"));
    store.add(blob);
    await disk.flush();
    const before = [...files.data];
    files.failReads = (path) => path.includes("/blobs/");
    await expect(store.loadBlob(w.roomId, w.deviceId, blob.id)).rejects.toThrow("can't be read now");
    expect(store.blobKeys(w.roomId)).toEqual([`${w.deviceId}/${blob.id}`]);
    expect(store.gone(w.roomId)).toEqual([]);
    expect([...files.data]).toEqual(before);
    files.failReads = undefined;
    expect(await store.loadBlob(w.roomId, w.deviceId, blob.id)).toEqual(blob);
  });

  it("carries a failed edit into the next successful save before a restart", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const node = new MeshNode(w.chain, w.deviceId, {}, await disk.open());
    node.persist = (env) => disk.persisted(env);
    const replica = new RoomReplica(node, w.roomId, { sign: w.sign, agree: w.agree });
    replica.addOwnKey(1, w.key);
    const id = randomId("f");
    replica.editIndex((index) => index.set(id, { path: "Plan.md", kind: "md" }));
    const text = replica.noteDoc(id).getText("content");
    text.insert(0, "OLD");
    await node.stored();
    files.failNextWriteTo = ".jsonl";
    text.insert(3, "A");
    await node.stored();
    text.insert(4, "B");
    await node.stored();
    node.stop();
    replica.destroy();
    await disk.flush();
    const restored = await new DiskStore(files, "m").open();
    const reopened = new RoomReplica(new MeshNode(WorkspaceChain.load(w.chain.all()), w.deviceId, {}, restored), w.roomId, { sign: w.sign, agree: w.agree });
    reopened.addOwnKey(1, w.key);
    expect(restored.envelopesOf(w.roomId, id).updates.map((env) => env.clock)).toEqual([1, 2, 3]);
    expect(reopened.isComplete(id)).toBe(true);
    expect(reopened.noteText(id)).toBe("OLDAB");
    reopened.destroy();
  });

  it("does not acknowledge an edit arriving during an append until that edit is written", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const doc = randomId("f");
    const first = sealUpdate(w.ctx, doc, 1, utf8("first"));
    const next = sealUpdate(w.ctx, doc, 2, utf8("next"));
    const append = files.append.bind(files);
    files.append = async (path, data) => {
      files.append = append;
      store.add(next);
      await append(path, data);
    };
    store.add(first);
    await disk.persisted(first);
    await disk.persisted(next);
    expect(lines(await files.read(docFile("m", w.roomId, doc))).map((line) => JSON.parse(line).clock)).toEqual([1, 2]);
  });

  it("round-trips the record, wraps, envelopes and blobs", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "plugin/mesh/ws1");
    await disk.saveChain(w.chain.all());
    await disk.saveWraps([wrapRoomKey(w.workspaceId, w.roomId, 1, w.key, { id: w.deviceId, agree: w.agree.publicKey }, w.sign)]);
    const live = await disk.open();
    const doc = randomId("f");
    live.add(sealUpdate(w.ctx, doc, 1, utf8("one")));
    live.add(sealUpdate(w.ctx, doc, 2, utf8("two")));
    live.add(sealUpdate(w.ctx, INDEX_DOC, 1, utf8("index")));
    const blob = sealBlob(w.ctx, utf8("attachment"));
    live.add(blob);
    await disk.flush();

    const again = new DiskStore(files, "plugin/mesh/ws1");
    expect((await again.loadChain())!.map((v) => v.body.v)).toEqual([0, 1]);
    expect(await again.loadWraps()).toHaveLength(1);
    const loaded = await again.open();
    expect(loaded.digest(w.roomId)).toBe(live.digest(w.roomId));
    // The blob's ciphertext stays on disk until it is asked for.
    expect((await loaded.loadBlob(w.roomId, w.deviceId, blob.id))?.sig).toBe(blob.sig);
    // Loading doesn't write anything back (no duplicated lines).
    await again.flush();
    expect(lines(await files.read(docFile("plugin/mesh/ws1", w.roomId, doc)))).toHaveLength(2);
  });

  it("names files so that ids differing only in case never share one", () => {
    const id = randomId("r");
    const variant = id[0] + [...id.slice(1)].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join("");
    expect(fileNameOf(id)).toBe(fileNameOf(id).toLowerCase());
    expect(fileNameOf(id)).not.toBe(fileNameOf(variant));
  });

  it("rewrites a document's log, with its marks, after a snapshot replaces envelopes", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    store.isMember = () => false;
    const doc = randomId("f");
    for (let clock = 1; clock <= 5; clock++) store.add(sealUpdate(w.ctx, doc, clock, utf8(`u${clock}`)));
    await disk.flush();
    store.add(sealSnapshot(w.ctx, doc, 1, { [w.deviceId]: 4 }, utf8("state")));
    await disk.flush();
    const written = lines(await files.read(docFile("m", w.roomId, doc))).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(written.map((entry) => entry.k ?? "marks")).toEqual(["marks", "s", "u"]);
    const reloaded = await new DiskStore(files, "m").open();
    expect(reloaded.vv(w.roomId, doc)).toEqual({ [w.deviceId]: 5 });
  });

  it("keeps a document whose journal can't be read incomplete, never writes over that journal, and takes it in once it can", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const doc = randomId("f");
    for (let clock = 1; clock <= 3; clock++) store.add(sealUpdate(w.ctx, doc, clock, utf8(`u${clock}`)));
    await disk.flush();
    const path = docFile("m", w.roomId, doc);
    const before = files.data.get(path)!;
    // Another program holds the journal while the store opens again.
    files.failReads = (p) => p === path;
    const again = new DiskStore(files, "m");
    const late: number[] = [];
    again.onLateRead = (_room, _doc, envelopes) => {
      for (const env of envelopes) if (env.k === "u") late.push(env.clock);
    };
    const reopened = await again.open();
    expect(reopened.isUnreadable(w.roomId, doc)).toBe(true);
    expect(again.unreadDocs()).toBe(1);
    // An update comes in meanwhile (appended), and the document's journal is to be rewritten: it isn't, yet.
    reopened.add(sealUpdate(w.ctx, doc, 4, utf8("u4")));
    reopened.compact(w.roomId, doc, [], {});
    await again.flush();
    expect(files.data.get(path)!.startsWith(before)).toBe(true);
    // It can be read again: what it holds is taken in, and the document is complete.
    files.failReads = undefined;
    await again.retryUnread();
    expect(reopened.isUnreadable(w.roomId, doc)).toBe(false);
    expect(late).toEqual([1, 2, 3]);
    expect(reopened.vv(w.roomId, doc)).toEqual({ [w.deviceId]: 4 });
  });

  it("survives a torn append, an interrupted rewrite and an interrupted swap", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const doc = randomId("f");
    store.add(sealUpdate(w.ctx, doc, 1, utf8("kept")));
    await disk.flush();
    const path = docFile("m", w.roomId, doc);
    await files.append(path, '\n{"k":"u","ws":"tor');
    // The next append starts on its own line, so the torn one takes nothing with it.
    store.add(sealUpdate(w.ctx, doc, 2, utf8("after")));
    await disk.flush();
    expect((await new DiskStore(files, "m").open()).vv(w.roomId, doc)).toEqual({ [w.deviceId]: 2 });
    // A rewrite interrupted after the old log was moved aside: the old copy is still read.
    await files.rename(path, `${path}.old`);
    expect((await new DiskStore(files, "m").open()).vv(w.roomId, doc)).toEqual({ [w.deviceId]: 2 });
    // A swap of the record interrupted the same way.
    await disk.saveChain(w.chain.all());
    await files.rename("m/chain/000000.jsonl", "m/chain/000000.jsonl.old");
    expect(await new DiskStore(files, "m").loadChain()).toHaveLength(2);
  });

  it("tells when an envelope made here is on disk", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const env = sealUpdate(w.ctx, randomId("f"), 1, utf8("mine"));
    store.add(env);
    await disk.persisted(env);
    expect(await files.exists(docFile("m", w.roomId, env.doc))).toBe(true);
  });

  it("writes an envelope again when asked after its first write failed", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const env = sealUpdate(w.ctx, randomId("f"), 1, utf8("mine"));
    files.failNextWriteTo = ".jsonl";
    store.add(env);
    await expect(disk.persisted(env)).rejects.toThrow("disk full");
    await disk.persisted(env);
    expect(lines(await files.read(docFile("m", w.roomId, env.doc)))).toHaveLength(1);
  });

  it("writes again the envelopes of a log whose write failed in one append", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const doc = randomId("f");
    const envs = [1, 2, 3].map((clock) => sealUpdate(w.ctx, doc, clock, utf8(`edit ${clock}`)));
    files.failNextWriteTo = ".jsonl";
    for (const env of envs) store.add(env);
    await expect(disk.persisted(envs[0]!)).rejects.toThrow("disk full");
    let appends = 0;
    const append = files.append.bind(files);
    files.append = (path, data) => (appends++, append(path, data));
    await Promise.all(envs.map((env) => disk.persisted(env)));
    expect(appends).toBe(1);
    expect(lines(await files.read(docFile("m", w.roomId, doc)))).toHaveLength(3);
  });

  it("keeps the old record if writing the new one fails", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    await disk.saveChain(w.chain.all());
    files.failNextWriteTo = "000000.jsonl.tmp";
    await expect(disk.saveChain([w.chain.head])).rejects.toThrow("disk full");
    expect(await new DiskStore(files, "m").loadChain()).toHaveLength(2);
  });

  it("never reads a locked record, joins or wraps as none, and swaps a file in when a rename is held a moment", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    await disk.saveChain(w.chain.all());
    await disk.saveJoins([]);
    await disk.saveWraps([]);
    for (const name of ["chain/", "joins.json", "wraps.json"]) {
      files.failReads = (path) => path.startsWith(`m/${name}`);
      const again = new DiskStore(files, "m");
      const read = name === "chain/" ? again.loadChain() : name === "joins.json" ? again.loadJoins() : again.loadWraps();
      await expect(read).rejects.toThrow("can't be read now");
    }
    files.failReads = undefined;
    // An antivirus holding the file for a moment: the rename is tried again, not given up.
    let held = 2;
    const rename = files.rename.bind(files);
    files.rename = async (from, to) => {
      if (held-- > 0) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      return rename(from, to);
    };
    await disk.saveJoins([]);
    expect(await new DiskStore(files, "m").loadJoins()).toEqual([]);
    // Both renames of the swap went through, the first after two refusals.
    expect(held).toBe(-2);
  });

  it("stores the record in segments: a change appends its version, a replaced branch leaves nothing of the old one", async () => {
    const w = world();
    const userId = Object.keys(w.chain.head.body.state.users)[0]!;
    for (let i = 0; i < 1_050; i++) w.chain.offer([nextVersion(w.workspaceId, w.chain.head, w.sign, (state) => (state.users[userId]!.name = `Ana ${i}`))]);
    const files = new MemoryFiles();
    // As 0.3.8 stored it: one file, read once and written as segments by the next save.
    files.data.set("m/chain.json", JSON.stringify(w.chain.all()));
    const disk = new DiskStore(files, "m");
    expect(await disk.loadChain()).toHaveLength(1_052);
    await disk.saveChain(w.chain.all());
    expect([...files.data.keys()].filter((key) => key.startsWith("m/chain")).sort()).toEqual(["m/chain/000000.jsonl", "m/chain/000001.jsonl", "m/chain/000002.jsonl"]);
    // One more version: only it is written.
    const appended: string[] = [];
    const append = files.append.bind(files);
    files.append = async (path, data) => {
      appended.push(data);
      return append(path, data);
    };
    w.chain.offer([nextVersion(w.workspaceId, w.chain.head, w.sign, (state) => (state.users[userId]!.name = "Ana last"))]);
    await disk.saveChain(w.chain.all());
    expect(appended).toHaveLength(1);
    expect(appended[0]!.split("\n").filter(Boolean)).toHaveLength(1);
    const again = new DiskStore(files, "m");
    const read = await again.loadChain();
    expect(read).toHaveLength(1_053);
    expect(WorkspaceChain.load(read!).headHash).toBe(w.chain.headHash);
    // A torn last line (Obsidian stopped mid-append): read up to it, and written whole from its segment next time.
    await append("m/chain/000002.jsonl", '{"body":{"kind":"vr-ws');
    const torn = new DiskStore(files, "m");
    expect(await torn.loadChain()).toHaveLength(1_053);
    await torn.saveChain(w.chain.all());
    expect(files.data.get("m/chain/000002.jsonl")!.endsWith("}\n")).toBe(true);
    expect(await new DiskStore(files, "m").loadChain()).toHaveLength(1_053);
    // A branch that replaces versions from 700 on, shorter: segment 1 rewritten, segment 2 gone.
    const branch = w.chain.all().slice(0, 700);
    await torn.saveChain(branch);
    expect(files.data.has("m/chain/000002.jsonl")).toBe(false);
    expect(await new DiskStore(files, "m").loadChain()).toHaveLength(700);
  }, 60_000);

  it("wipes everything on leaving", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    await disk.saveChain(w.chain.all());
    await disk.wipe();
    expect([...files.data.keys()].filter((key) => key.startsWith("m/"))).toEqual([]);
  });
});
