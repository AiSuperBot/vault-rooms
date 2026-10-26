import { describe, expect, it } from "vitest";
import {
  createGenesis,
  INDEX_DOC,
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
import { DiskStore } from "../../src/mesh/diskStore.js";
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

describe("disk store", () => {
  it("round-trips the record, wraps and envelopes", async () => {
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
    live.add(sealBlob(w.ctx, utf8("attachment")));
    await disk.flush();

    const again = new DiskStore(files, "plugin/mesh/ws1");
    expect((await again.loadChain())!.map((v) => v.body.v)).toEqual([0, 1]);
    expect(await again.loadWraps()).toHaveLength(1);
    const loaded = await again.open();
    expect(loaded.digest(w.roomId)).toBe(live.digest(w.roomId));
    // Loading doesn't write anything back (no duplicated lines).
    await again.flush();
    expect((await files.read(`plugin/mesh/ws1/docs/${w.roomId}/${doc}.jsonl`)).trim().split("\n")).toHaveLength(2);
  });

  it("rewrites a document's log after a snapshot prunes it", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const doc = randomId("f");
    for (let clock = 1; clock <= 5; clock++) store.add(sealUpdate(w.ctx, doc, clock, utf8(`u${clock}`)));
    await disk.flush();
    store.add(sealSnapshot(w.ctx, doc, 1, { [w.deviceId]: 4 }, utf8("state")));
    await disk.flush();
    const lines = (await files.read(`m/docs/${w.roomId}/${doc}.jsonl`)).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).k)).toEqual(["s", "u"]);
  });

  it("survives a torn last line and an interrupted swap", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    const store = await disk.open();
    const doc = randomId("f");
    store.add(sealUpdate(w.ctx, doc, 1, utf8("kept")));
    await disk.flush();
    await files.append(`m/docs/${w.roomId}/${doc}.jsonl`, '{"k":"u","ws":"tor');
    expect((await new DiskStore(files, "m").open()).vv(w.roomId, doc)).toEqual({ [w.deviceId]: 1 });
    // A swap interrupted after the old copy was moved aside: the old copy is still found.
    await disk.saveChain(w.chain.all());
    await files.rename("m/chain.json", "m/chain.json.old");
    expect(await new DiskStore(files, "m").loadChain()).toHaveLength(2);
  });

  it("keeps the old record if writing the new one fails", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    await disk.saveChain(w.chain.all());
    files.failNextWriteTo = "chain.json.tmp";
    await expect(disk.saveChain([w.chain.head])).rejects.toThrow("disk full");
    expect(await new DiskStore(files, "m").loadChain()).toHaveLength(2);
  });

  it("wipes everything on leaving", async () => {
    const w = world();
    const files = new MemoryFiles();
    const disk = new DiskStore(files, "m");
    await disk.saveChain(w.chain.all());
    await disk.wipe();
    expect([...files.data.keys()].filter((key) => key.startsWith("m/"))).toEqual([]);
  });
});
