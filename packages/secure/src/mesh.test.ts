import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { fromUtf8, utf8 } from "./bytes.js";
import { MAX_FORK_DEPTH, WorkspaceChain } from "./chain.js";
import { randomBytes } from "./crypto.js";
import { INDEX_DOC, openEnvelope, sealBlob, sealPresence, sealSnapshot, sealUpdate, type Envelope, type StoredEnvelope } from "./envelope.js";
import { randomId } from "./ids.js";
import { createJoinRecord, foldJoinInto, joinHash } from "./invite.js";
import { keyCommitment, newRoomKey, sealRoomName, unwrapRoomKey, wrapRoomKey } from "./keys.js";
import { encodeFrame } from "./frames.js";
import { JoinHandshake, MeshNode, versionBatches, type Channel, type PeerMessage, type PeerSession } from "./mesh.js";
import { RoomReplica } from "./replica.js";
import { createRoom, fold, founder, invite, Network, step, type TestDevice } from "./testkit.js";
import { activeDevice, nextVersion, rebaseChange } from "./workspace.js";

function nodeFor(chain: WorkspaceChain, device: TestDevice, log: string[] = []): MeshNode {
  return new MeshNode(WorkspaceChain.load(chain.all()), device.id, { rejected: (reason) => log.push(reason) });
}

function texts(node: MeshNode, room: string, key: Uint8Array): string[] {
  const { updates } = node.store.envelopesOf(room, INDEX_DOC);
  return updates.map((env) => fromUtf8(openEnvelope(env, key))).sort();
}

function setup() {
  const { chain, ws, admin: ana } = founder();
  const { joiner: ben } = invite(chain, ana, { userName: "Ben" });
  const { joiner: cy } = invite(chain, ana, { userName: "Cy" });
  const { roomId, key } = createRoom(chain, ana, "Plans", { [cy.userId]: "write" });
  const seal = (device: TestDevice, clock: number, text: string): Envelope => sealUpdate({ ws, room: roomId, n: 1, key, author: device.sign }, INDEX_DOC, clock, utf8(text));
  return { chain, ws, ana, ben, cy, roomId, key, seal };
}

describe("mesh", () => {
  it("coalesces repair requests and cancels them when stopped", () => {
    const { chain, ana, cy } = setup();
    const node = nodeFor(chain, ana);
    const sent: PeerMessage[] = [];
    node.connect({ send: (message) => sent.push(message), close: () => {} }, cy.id);
    sent.length = 0;
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 50; i++) node.resync();
      vi.advanceTimersByTime(99);
      expect(sent).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(sent.map((message) => message.t)).toEqual(["hello"]);
      node.resync();
      node.stop();
      vi.advanceTimersByTime(100);
      expect(sent.map((message) => message.t)).toEqual(["hello"]);
    } finally { node.stop(); vi.useRealTimers(); }
  });

  it("bounds aggregate summary bytes and still transfers history absent from its hints", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const source = nodeFor(chain, ana);
    const receiver = nodeFor(chain, cy);
    const doc = randomId("f");
    const env = sealUpdate({ ws, room: roomId, n: 1, key, author: ana.sign }, doc, 1, utf8("omitted history"));
    source.publish(env);
    const sent: PeerMessage[] = [];
    const receiving = receiver.connect({ send: (message) => sent.push(message), close: () => {} }, ana.id);
    const digest = vi.spyOn(receiver.store, "digest").mockReturnValue("A".repeat(43));
    const docs = vi.spyOn(receiver.store, "docs").mockReturnValue([...Array.from({ length: 9000 }, () => randomId("f")), doc]);
    const snaps = vi.spyOn(receiver.store, "snapshotKeys").mockReturnValue(Array.from({ length: 100 }, (_, i) => `s/${roomId}/${doc}/${ana.id}/${i + 1}`));
    try {
      receiving.receive({ t: "digests", rooms: {} });
    } finally { docs.mockRestore(); snaps.mockRestore(); digest.mockRestore(); }
    const summary = sent.find((message) => message.t === "room")!;
    expect(Buffer.byteLength(JSON.stringify(summary), "utf8")).toBeLessThan(64 << 20);
    expect(summary.t === "room" && Object.hasOwn(summary.docs as object, doc)).toBe(false);
    const sending = source.connect({ send: (message) => receiving.receive(message), close: () => {} }, cy.id);
    sending.receive(summary);
    expect(receiver.store.envelopesOf(roomId, doc).updates).toEqual([env]);
    expect(receiver.store.digest(roomId)).toBe(source.store.digest(roomId));
    sending.close("done");
    receiving.close("done");
  });

  it("sends versions as 0.3.6 does unless the hello said it reads parts, and live edits past a stuck queue", async () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const ahead = WorkspaceChain.load(chain.all());
    step(ahead, ana, (state) => { state.name = "later"; });
    step(ahead, ana, (state) => { state.name = "later still"; });
    for (const items of [undefined, ["fragments"]]) {
      const sent: PeerMessage[] = [];
      // Never drains: everything queued waits behind the first message.
      const session = nodeFor(ahead, ana).connect({ send: (message) => sent.push(message), drained: () => new Promise(() => {}), close: () => {} }, cy.id);
      session.receive({ t: "hello", ws, head: chain.head.body.v, recent: [[chain.head.body.v, chain.headHash]], ...(items ? { items } : {}) });
      await Promise.resolve();
      expect(sent.map((message) => message.t)).toEqual(["hello"]);
      session.send({ t: "push", env: sealUpdate({ ws, room: roomId, n: 1, key, author: ana.sign }, INDEX_DOC, 1, utf8("live")) });
      expect(sent.map((message) => message.t)).toEqual(["hello", "push"]);
      session.close("done");
    }
    // The answer itself: no `end` without the hello's say-so (0.3.6 drops a versions message with keys it doesn't know).
    for (const items of [undefined, ["fragments"]]) {
      const sent: PeerMessage[] = [];
      const session = nodeFor(ahead, ana).connect({ send: (message) => sent.push(message), close: () => {} }, cy.id);
      session.receive({ t: "hello", ws, head: chain.head.body.v, recent: [[chain.head.body.v, chain.headHash]], ...(items ? { items } : {}) });
      await Promise.resolve();
      // Versions that fit go in one message: 0.3.6 judges each message as a branch on its own.
      const versions = sent.filter((message) => message.t === "versions");
      expect(versions).toHaveLength(1);
      expect("end" in versions[0]!).toBe(items !== undefined);
      session.close("done");
    }
  });

  it("builds a room's summary once for every peer, and again once the room changed", () => {
    const { chain, ana, ben, cy, roomId, seal } = setup();
    const node = nodeFor(chain, ana);
    node.publish(seal(ana, 1, "one"));
    const summaries = (device: string) => {
      const sent: PeerMessage[] = [];
      const session = node.connect({ send: (message) => sent.push(message), close: () => {} }, device);
      session.receive({ t: "digests", rooms: {} });
      session.close("done");
      return sent.find((message) => message.t === "room")!;
    };
    const first = summaries(cy.id);
    expect(summaries(ben.id)).toBe(first);
    node.publish(seal(ana, 2, "two"));
    const next = summaries(cy.id);
    expect(next).not.toBe(first);
    expect(next.t === "room" && Object.values(next.docs)[0]!.vv[ana.id]).toBe(2);
  });

  it("passes a push on only to peers that don't have it yet, and encodes it once for all of them", () => {
    const { chain, ana, ben, cy, seal } = setup();
    const node = nodeFor(chain, ben);
    const sent = new Map<string, PeerMessage[]>([[ana.id, []], [cy.id, []]]);
    const sessions = new Map([...sent.keys()].map((device) => [device, node.connect({ send: (message) => sent.get(device)!.push(message), close: () => {} }, device)]));
    // Ana sent it to Ben and Cy at once: Ben doesn't send it to Cy again.
    sessions.get(ana.id)!.receive({ t: "push", env: seal(ana, 1, "one"), items: [ana.id, ben.id, cy.id] });
    expect(sent.get(cy.id)!.filter((message) => message.t === "push")).toHaveLength(0);
    // Without that (0.3.6 sends none): passed on, saying who has it now.
    sessions.get(ana.id)!.receive({ t: "push", env: seal(ana, 2, "two") });
    const pushed = sent.get(cy.id)!.filter((message) => message.t === "push");
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.t === "push" && pushed[0]!.items).toEqual(expect.arrayContaining([ana.id, cy.id]));
    expect(encodeFrame(pushed[0])).toBe(encodeFrame(pushed[0]));
    for (const session of sessions.values()) session.close("done");
  });

  it("sends its wraps only to a peer whose hello shows it doesn't hold the same ones", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const node = nodeFor(chain, ana);
    const wrap = wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    const none = node.wrapsDigest();
    expect(node.addWrap(wrap)).toBe(true);
    expect(node.wrapsDigest()).not.toBe(none);
    const wrapsSent = (items?: string[]) => {
      const sent: PeerMessage[] = [];
      const session = node.connect({ send: (message) => sent.push(message), close: () => {} }, cy.id);
      session.receive({ t: "hello", ws, head: chain.head.body.v, recent: [[chain.head.body.v, chain.headHash]], ...(items ? { items } : {}) });
      session.close("done");
      return sent.filter((message) => message.t === "wraps").length;
    };
    expect(wrapsSent()).toBe(1);
    expect(wrapsSent(["fragments", `wraps:${node.wrapsDigest()}`])).toBe(0);
    expect(wrapsSent(["fragments", "wraps:something else"])).toBe(1);
  });

  it("caps blob hints at the count accepted by the receiving parser", () => {
    const { chain, ana, cy, roomId } = setup();
    const source = nodeFor(chain, ana);
    const sent: PeerMessage[] = [];
    const session = source.connect({ send: (message) => sent.push(message), close: () => {} }, cy.id);
    const keys = vi.spyOn(source.store, "blobKeys").mockReturnValue(Array.from({ length: 100_001 }, () => `${ana.id}/${"A".repeat(43)}`));
    try { session.receive({ t: "digests", rooms: {} }); } finally { keys.mockRestore(); }
    const summary = sent.find((message) => message.t === "room")!;
    expect(summary.t === "room" && summary.blobs.length).toBe(100_000);
    const receiver = nodeFor(chain, cy).connect({ send: () => {}, close: () => {} }, ana.id);
    receiver.receive(summary);
    expect(receiver.isClosed).toBe(false);
    session.close("done");
    receiver.close("done");
  });

  it("keeps a progressing branch beyond 30 seconds, but reconnects after an idle transfer", () => {
    const { chain, ana, ben, cy } = setup();
    step(chain, ana, (state) => { state.users[ben.userId]!.admin = true; });
    const start = chain.length;
    const theirs = WorkspaceChain.load(chain.all());
    step(theirs, ben, (state) => { state.name = "one"; });
    step(theirs, ben, (state) => { state.name = "two"; });
    step(theirs, ben, (state) => { state.devices[cy.id]!.revoked = true; });
    step(chain, ana, (state) => { state.name = "senior branch"; });
    const whole = WorkspaceChain.load(chain.all());
    expect(whole.offer(theirs.since(start)).status).toBe("replaced");
    const receiver = nodeFor(chain, ana);
    const session = receiver.connect({ send: () => {}, close: () => {} }, ben.id);
    vi.useFakeTimers();
    try {
      for (const version of theirs.since(start)) {
        session.receive({ t: "versions", versions: [version], end: theirs.head.body.v, hash: theirs.headHash });
        vi.advanceTimersByTime(20_000);
      }
      expect(session.isClosed).toBe(false);
      expect(receiver.chain.headHash).toBe(whole.headHash);
      const idle = nodeFor(chain, ana).connect({ send: () => {}, close: () => {} }, ben.id);
      const first = { t: "versions", versions: [theirs.versionAt(start)], end: theirs.head.body.v, hash: theirs.headHash };
      idle.receive(first);
      vi.advanceTimersByTime(20_000);
      idle.receive(first); // Replays do not extend the progress deadline.
      vi.advanceTimersByTime(10_001);
      expect(idle.isClosed).toBe(true);
    } finally { session.close("done"); vi.useRealTimers(); }
  });

  it("checks only incoming versions when replaying or staging history", () => {
    const { chain, ana, ben } = setup();
    for (let i = 0; i < 40; i++) step(chain, ana, (state) => { state.name = `change ${i}`; });
    const receiver = nodeFor(chain, ana);
    const session = receiver.connect({ send: () => {}, close: () => {} }, ben.id);
    const start = chain.length;
    step(chain, ana, (state) => { state.name = "next"; });
    step(chain, ana, (state) => { state.name = "last"; });
    const load = vi.spyOn(WorkspaceChain, "load");
    try {
      for (let i = 0; i < 10; i++) session.receive({ t: "versions", versions: [receiver.chain.head], end: receiver.chain.head.body.v, hash: receiver.chain.headHash });
      for (const version of chain.since(start)) session.receive({ t: "versions", versions: [version], end: chain.head.body.v, hash: chain.headHash });
      expect(receiver.chain.headHash).toBe(chain.headHash);
      expect(load).not.toHaveBeenCalled();
    } finally { session.close("done"); load.mockRestore(); }
  });

  it("sends 1000 rooms and their contents after backpressure without overflowing the job queue", async () => {
    const { chain, ws, admin } = founder();
    const { joiner } = invite(chain, admin);
    const key = newRoomKey();
    step(chain, admin, (state) => {
      for (let i = 0; i < 1000; i++) {
        const id = randomId("r");
        state.rooms[id] = { creator: admin.userId, name: sealRoomName(ws, id, 1, key, `Room ${i}`), members: { [admin.userId]: "manage" }, epochs: [{ n: 1, commit: keyCommitment(ws, id, 1, key) }] };
      }
    });
    const source = nodeFor(chain, admin);
    const receiver = nodeFor(chain, joiner);
    for (const room of Object.keys(chain.state.rooms)) source.publish(sealUpdate({ ws, room, n: 1, key, author: admin.sign }, INDEX_DOC, 1, utf8("content")));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const summaries: string[] = [];
    const session = source.connect({
      send(message) {
        if (message.t === "room") summaries.push(message.room);
        if (message.t === "envelopes") for (const env of message.items as StoredEnvelope[]) receiver.publish(env);
      },
      drained: () => gate,
      close: () => release()
    }, joiner.id);
    try {
      session.receive({ t: "digests", rooms: {} });
      for (const room of Object.keys(chain.state.rooms)) session.receive({ t: "room", room, docs: {}, blobs: [] });
      expect(session.isClosed).toBe(false);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(summaries).toHaveLength(1000);
      for (const room of summaries) expect(receiver.store.digest(room)).toBe(source.store.digest(room));
      expect(session.isClosed).toBe(false);
    } finally { session.close("done"); }
  });

  it("chooses the same authenticated branch whole, split at 500, or split by bytes with its revocation last", () => {
    const { chain, ana, ben, cy } = setup();
    step(chain, ana, (state) => { state.users[ben.userId]!.admin = true; });
    const start = chain.length;
    const theirs = WorkspaceChain.load(chain.all());
    for (let i = 0; i < 500; i++) step(theirs, ben, (state) => { state.name = `change ${i}`; });
    step(theirs, ben, (state) => { state.devices[cy.id]!.revoked = true; });
    step(chain, ana, (state) => { state.name = "senior branch"; });
    const branch = theirs.since(start);
    const whole = WorkspaceChain.load(chain.all());
    expect(whole.offer(branch).status).toBe("replaced");
    for (const parts of [[branch.slice(0, 500), branch.slice(500)], versionBatches(branch, 25_000)]) {
      const log: string[] = [];
      const node = nodeFor(chain, ana, log);
      const session = node.connect({ send: () => {}, close: () => {} }, ben.id);
      parts.forEach((versions, i) => {
        session.receive({ t: "versions", versions, end: theirs.head.body.v, hash: theirs.headHash });
        if (i < parts.length - 1) expect(node.chain.headHash).toBe(chain.headHash);
      });
      expect(log).toEqual([]);
      expect(node.chain.headHash).toBe(whole.headHash);
      expect(activeDevice(node.effective(), cy.id)).toBeNull();
    }
    const net = new Network();
    const receiver = nodeFor(chain, ana);
    net.link(nodeFor(theirs, ben), receiver);
    net.pump();
    expect(receiver.chain.headHash).toBe(whole.headHash);
  });

  it("does not apply an incomplete or incorrectly signed branch", () => {
    const { chain, ana, ben } = setup();
    const log: string[] = [];
    const node = nodeFor(chain, ana, log);
    const later = WorkspaceChain.load(chain.all());
    step(later, ana, (state) => { state.name = "one"; });
    step(later, ana, (state) => { state.name = "two"; });
    const session = node.connect({ send: () => {}, close: () => {} }, ben.id);
    session.receive({ t: "versions", versions: later.since(chain.length).slice(0, 1), end: later.head.body.v, hash: later.headHash });
    expect(node.chain.headHash).toBe(chain.headHash);
    const bad = structuredClone(later.head);
    bad.body.state.name = "forged";
    session.receive({ t: "versions", versions: [bad], end: later.head.body.v, hash: later.headHash });
    expect(node.chain.headHash).toBe(chain.headHash);
    expect(log.some((reason) => reason.startsWith("versions:"))).toBe(true);
  });

  it("catches up with 101 concurrent writers' snapshots without losing history", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const writers = [ana];
    for (let i = 0; i < 100; i++) writers.push(invite(chain, ana, { userName: `Writer ${i}`, rooms: { [roomId]: "write" } }).joiner);
    const a = nodeFor(chain, ana);
    const id = randomId("f");
    const index = new Y.Doc();
    index.getMap("files").set(id, { path: "Writers.md", kind: "md" });
    a.publish(sealUpdate({ ws, room: roomId, n: 1, key, author: ana.sign }, INDEX_DOC, 1, Y.encodeStateAsUpdate(index)));
    writers.forEach((writer, i) => {
      const doc = new Y.Doc();
      doc.getText("content").insert(0, `writer ${i}\n`);
      expect(a.publish(sealSnapshot({ ws, room: roomId, n: 1, key, author: writer.sign }, id, 1, { [writer.id]: 1 }, Y.encodeStateAsUpdate(doc)))).toBe(true);
      doc.destroy();
    });
    const log: string[] = [];
    const c = nodeFor(chain, cy, log);
    const net = new Network();
    net.link(a, c);
    net.pump();
    expect(c.store.snapshotKeys(roomId, id)).toHaveLength(101);
    expect(c.store.digest(roomId)).toBe(a.store.digest(roomId));
    expect(log).toEqual([]);
    const replica = new RoomReplica(c, roomId, { sign: cy.sign, agree: cy.agree });
    replica.addOwnKey(1, key);
    const content = replica.noteText(id);
    for (let i = 0; i < 101; i++) expect(content).toContain(`writer ${i}\n`);
    expect(replica.isComplete(id)).toBe(true);
    replica.destroy();
  });

  it("awaits a slow transport through more than 128 MiB of catch-up, with bounded batches", async () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    const bytes = new Uint8Array(6 << 20);
    for (let i = 1; i <= 21; i++) expect(a.publish(sealUpdate({ ws, room: roomId, n: 1, key, author: ana.sign }, INDEX_DOC, i, bytes))).toBe(true);
    let queued = 0;
    let largest = 0;
    let sent = 0;
    let turns = 0;
    let closed = false;
    const channel: Channel = {
      send(message) {
        if (message.t !== "envelopes") return;
        const envs = message.items as StoredEnvelope[];
        queued += envs.reduce((n, env) => n + env.ct.length, 0);
        largest = Math.max(largest, queued);
        if (queued > 128 << 20) closed = true;
        for (const env of envs) { expect(c.publish(env)).toBe(true); sent++; }
      },
      drained: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); queued = 0; turns++; },
      close: () => { closed = true; }
    };
    const session = a.connect(channel, cy.id);
    session.receive({ t: "room", room: roomId, docs: {}, blobs: [] });
    const until = Date.now() + 20_000;
    while (sent < 21 && !closed && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toBe(21);
    expect(turns).toBeGreaterThan(10);
    expect(largest).toBeLessThan(17 << 20);
    expect(closed).toBe(false);
    expect(c.store.digest(roomId)).toBe(a.store.digest(roomId));
    session.close("done");
  }, 30_000);

  it("delivers live updates between two members", () => {
    const { chain, ana, cy, roomId, key, seal } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    net.link(a, c);
    net.pump();
    expect(a.publish(seal(ana, 1, "hello"))).toBe(true);
    net.pump();
    expect(texts(c, roomId, key)).toEqual(["hello"]);
  });

  it("catches up after being apart, in both directions", () => {
    const { chain, ana, cy, roomId, key, seal } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    for (let i = 1; i <= 3; i++) a.publish(seal(ana, i, `a${i}`));
    for (let i = 1; i <= 2; i++) c.publish(seal(cy, i, `c${i}`));
    net.link(a, c);
    net.pump();
    expect(texts(a, roomId, key)).toEqual(["a1", "a2", "a3", "c1", "c2"]);
    expect(texts(c, roomId, key)).toEqual(["a1", "a2", "a3", "c1", "c2"]);
    expect(a.store.digest(roomId)).toBe(c.store.digest(roomId));
  });

  it("relays through a peer that isn't in the room, which only ever holds ciphertext", () => {
    const { chain, ws, ana, ben, cy, roomId, key, seal } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const b = nodeFor(chain, ben);
    const c = nodeFor(chain, cy);
    net.link(a, b);
    net.link(b, c);
    net.pump();
    a.publish(seal(ana, 1, "via Ben"));
    net.pump();
    expect(texts(c, roomId, key)).toEqual(["via Ben"]);
    expect(b.store.envelopesOf(roomId, INDEX_DOC).updates).toHaveLength(1);
    // Ben has no key wrap for this room, so there is nothing he could decrypt it with.
    const wrapForCy = wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    expect(() => unwrapRoomKey(chain.state, ws, wrapForCy, ben.agree)).toThrow();
  });

  it("refuses writes from readers and from strangers' keys", () => {
    const { chain, ws, ana, ben, roomId, key } = setup();
    const log: string[] = [];
    const net = new Network();
    const a = nodeFor(chain, ana, log);
    const b = nodeFor(chain, ben);
    net.link(a, b);
    net.pump();
    // Ben isn't a member: his update is dropped at the first hop and never stored.
    const forged = sealUpdate({ ws, room: roomId, n: 1, key, author: ben.sign }, INDEX_DOC, 1, utf8("graffiti"));
    expect(b.publish(forged)).toBe(false);
    net.enqueue(() => (a as unknown as { sessionsFor?: unknown }) && undefined);
    net.pump();
    expect(a.store.envelopesOf(roomId, INDEX_DOC).updates).toHaveLength(0);
  });

  it("spreads workspace changes and lets the newest record decide", () => {
    const { chain, ana, cy } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    net.link(a, c);
    net.pump();
    const version = nextVersion(a.workspaceId, a.chain.head, ana.sign, (state) => (state.name = "Renamed"));
    a.offerVersions([version]);
    net.pump();
    expect(c.chain.state.name).toBe("Renamed");
    expect(c.chain.headHash).toBe(a.chain.headHash);
  });

  it("converges when two admins changed the record while apart", () => {
    const { chain, ana, ben } = setup();
    step(chain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const net = new Network();
    const a = nodeFor(chain, ana);
    const b = nodeFor(chain, ben);
    a.offerVersions([nextVersion(a.workspaceId, a.chain.head, ana.sign, (state) => (state.name = "Ana's"))]);
    b.offerVersions([nextVersion(b.workspaceId, b.chain.head, ben.sign, (state) => (state.name = "Ben's"))]);
    net.link(a, b);
    net.pump();
    expect(a.chain.headHash).toBe(b.chain.headHash);
    expect(a.chain.state.name).toBe("Ana's");
  });

  it("lets a new device join through any member, then get keys from a room member", () => {
    const { chain, ws, ana, ben, roomId, key, seal } = setup();
    // Ana invites Dee to the room; Dee joins through Ben while Ana is offline.
    const { joiner: dee, join } = invite(chain, ana, { userName: "Dee", rooms: { [roomId]: "read" }, fold: false });
    const net = new Network();
    const a = nodeFor(chain, ana);
    const b = nodeFor(chain, ben);
    a.publish(seal(ana, 1, "before Dee"));
    net.link(a, b);
    net.pump();
    let d: MeshNode | null = null;
    let sessionDB: PeerSession | null = null;
    let handshake: JoinHandshake | null = null;
    const route = { toDee: (message: unknown) => (sessionDB ? sessionDB.receive(message) : handshake!.receive(message)), toBen: (_: unknown) => {} };
    const deeChannel: Channel = { send: (m) => net.enqueue(() => route.toBen(JSON.parse(JSON.stringify(m)))), close: () => {} };
    const benChannel: Channel = { send: (m) => net.enqueue(() => route.toDee(JSON.parse(JSON.stringify(m)))), close: () => {} };
    const sessionBD = b.connect(benChannel, dee.id);
    route.toBen = (message) => sessionBD.receive(message);
    handshake = new JoinHandshake(
      deeChannel,
      ws,
      join,
      (joinedChain) => {
        d = new MeshNode(joinedChain, dee.id);
        d.addJoin(join);
        sessionDB = d.connect(deeChannel, ben.id);
      },
      (reason) => {
        throw new Error(reason);
      }
    );
    handshake.start();
    net.pump();
    expect(d).not.toBeNull();
    const deeNode = d as unknown as MeshNode;
    // Dee holds the room's ciphertext straight away...
    expect(deeNode.store.envelopesOf(roomId, INDEX_DOC).updates).toHaveLength(1);
    // ...and Ana learnt of the join through Ben.
    expect(a.effective().devices[dee.id]?.user).toBe(dee.userId);
    // Ana, a room member, wraps the key for Dee's device; it reaches Dee through Ben.
    a.addWrap(wrapRoomKey(ws, roomId, 1, key, { id: dee.id, agree: dee.agree.publicKey }, ana.sign));
    net.pump();
    const wrap = deeNode.allWraps().find((w) => w.body.to === dee.id)!;
    const deeKey = unwrapRoomKey(deeNode.effective(), ws, wrap, dee.agree);
    expect(texts(deeNode, roomId, deeKey)).toEqual(["before Dee"]);
  });

  it("takes in a burst of wraps with one event and a few messages, so no peer's send queue fills", async () => {
    const { chain, ws, admin: ana } = founder();
    const people: TestDevice[] = [];
    for (let i = 0; i < 50; i++) people.push(invite(chain, ana, { userName: `P${i}` }).joiner);
    const members = Object.fromEntries(people.map((person) => [person.userId, "write" as const]));
    const rooms = Array.from({ length: 30 }, (_, i) => createRoom(chain, ana, `R${i}`, members));
    const wraps = rooms.flatMap(({ roomId, key }) => people.map((person) => wrapRoomKey(ws, roomId, 1, key, { id: person.id, agree: person.agree.publicKey }, ana.sign)));
    let told = 0;
    const node = new MeshNode(WorkspaceChain.load(chain.all()), people[0]!.id, { wraps: () => void told++ });
    const closed: string[] = [];
    const sent: PeerMessage[] = [];
    const channel = (name: string, out?: PeerMessage[]): Channel => ({ send: (message) => void out?.push(message), close: (reason) => void closed.push(`${name}:${reason}`), drained: () => new Promise<void>((resolve) => setImmediate(resolve)) });
    const fromAna = node.connect(channel("ana"), ana.id);
    node.connect(channel("p1", sent), people[1]!.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    sent.length = 0;
    for (let i = 0; i < wraps.length; i += 500) {
      fromAna.receive(JSON.parse(JSON.stringify({ t: "wraps", wraps: wraps.slice(i, i + 500) })));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(node.allWraps()).toHaveLength(1_500);
    expect(closed).toEqual([]);
    expect(told).toBe(3);
    expect(sent.filter((message) => message.t === "wraps").map((message) => message.t === "wraps" && message.wraps.length)).toEqual([500, 500, 500]);
  }, 60_000);

  it("isn't sent a snapshot it dropped again and again by a peer that only relays the room", async () => {
    const { chain, ws, ana, ben, cy, roomId, key } = setup();
    const a = nodeFor(chain, ana);
    const b = nodeFor(chain, ben);
    const doc = randomId("f");
    const ctx = (device: TestDevice) => ({ ws, room: roomId, n: 1, key, author: device.sign });
    const cyDoc = new Y.Doc();
    cyDoc.clientID = 5;
    cyDoc.getText("content").insert(0, "cy line\n");
    const anaDoc = new Y.Doc();
    anaDoc.clientID = 9;
    Y.applyUpdate(anaDoc, Y.encodeStateAsUpdate(cyDoc));
    anaDoc.getText("content").insert(0, "ana\n");
    const envelopes = [
      sealUpdate(ctx(cy), doc, 1, Y.encodeStateAsUpdate(cyDoc)),
      sealSnapshot(ctx(cy), doc, 1, { [cy.id]: 1 }, Y.encodeStateAsUpdate(cyDoc)),
      sealUpdate(ctx(ana), doc, 1, Y.encodeStateAsUpdate(anaDoc, Y.encodeStateVector(cyDoc))),
      sealSnapshot(ctx(ana), doc, 1, { [cy.id]: 1, [ana.id]: 1 }, Y.encodeStateAsUpdate(anaDoc))
    ];
    // Ana's computer, a member, drops Cy's snapshot (Ana's holds it); Ben's, which only relays the room, keeps both.
    const replica = new RoomReplica(a, roomId, { sign: ana.sign, agree: ana.agree });
    replica.addOwnKey(1, key);
    a.events.envelope = (env) => replica.receive(env);
    replica.noteDoc(doc);
    for (const env of envelopes) {
      a.publish(env);
      b.publish(env);
    }
    expect(a.store.snapshotKeys(roomId, doc)).toHaveLength(1);
    expect(b.store.snapshotKeys(roomId, doc)).toHaveLength(2);
    const net = new Network();
    const { ab } = net.link(a, b);
    let sentToA = 0;
    const receive = ab.receive.bind(ab);
    ab.receive = (message: unknown) => {
      if ((message as PeerMessage).t === "envelopes") sentToA += (message as { items: unknown[] }).items.length;
      return receive(message);
    };
    await net.settle();
    for (let i = 0; i < 3; i++) {
      ab.askAgain();
      await net.settle();
    }
    expect(sentToA).toBe(0);
    // Even sent, it would be let go before its signature is checked (as add would refuse it).
    expect(a.store.holds(envelopes[1]!)).toBe(true);
  });

  it("passes a catch-up on by comparing, not by pushing it to peers that hold it", async () => {
    const { chain, ws, ana, ben, cy, roomId, key } = setup();
    const { joiner: dee } = invite(chain, ana, { userName: "Dee" });
    const [a, b, c, d] = [ana, ben, cy, dee].map((device) => nodeFor(chain, device));
    const envelopes = Array.from({ length: 300 }, (_, i) => sealUpdate({ ws, room: roomId, n: 1, key, author: ana.sign }, INDEX_DOC, i + 1, utf8(`x${i + 1}`)));
    const net = new Network();
    net.link(b!, c!);
    net.link(b!, d!);
    net.pump();
    for (const env of envelopes) a!.publish(env);
    // Cy's and Dee's computers have all of it but the last.
    for (const env of envelopes.slice(0, 299)) {
      c!.store.add(env);
      d!.store.add(env);
    }
    let pushes = 0;
    for (const session of (b as unknown as { sessions: Set<{ remoteDevice: string; channel: Channel }> }).sessions) {
      const send = session.channel.send.bind(session.channel);
      session.channel.send = (message) => {
        if (message.t === "push") pushes++;
        send(message);
      };
    }
    net.link(a!, b!);
    await net.settle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await net.settle();
    expect(pushes).toBe(0);
    for (const node of [b, c, d]) expect(node!.store.envelopesOf(roomId, INDEX_DOC).updates).toHaveLength(300);
  });

  it("checks the record a join gets message by message, and gives up on a peer that goes quiet", () => {
    const { chain, ana } = setup();
    const other = founder();
    const join = createJoinRecord({ workspaceId: chain.workspaceId, inviteId: randomId("i"), secret: newRoomKey(), user: { id: randomId("u"), name: "Eve" }, deviceName: "Eve", deviceKey: ana.sign, agreementPublicKey: ana.agree.publicKey, tlsFingerprint: "A".repeat(43) });
    const outcome = () => {
      const result: { failed?: string; chain?: WorkspaceChain } = {};
      const handshake = new JoinHandshake({ send: () => {}, close: () => {} }, chain.workspaceId, join, (got) => (result.chain = got), (reason) => (result.failed = reason));
      handshake.start();
      return { handshake, result };
    };
    // Another workspace's record: refused at its first version, not after a million.
    const stranger = outcome();
    stranger.handshake.receive({ t: "hello", ws: chain.workspaceId, head: 1_000_000 });
    stranger.handshake.receive(JSON.parse(JSON.stringify({ t: "versions", versions: other.chain.all() })));
    expect(stranger.result.failed).toMatch(/^other_workspace/);
    // Versions that don't extend what came before: refused at once.
    const broken = outcome();
    broken.handshake.receive({ t: "hello", ws: chain.workspaceId, head: 1_000_000 });
    broken.handshake.receive(JSON.parse(JSON.stringify({ t: "versions", versions: [chain.all()[0], chain.all()[2]] })));
    expect(broken.result.failed).toMatch(/bad_chain|unknown_parent|gap/);
    // A peer that says nothing more: given up on, so the link's next address is tried.
    vi.useFakeTimers();
    try {
      const quiet = outcome();
      quiet.handshake.receive({ t: "hello", ws: chain.workspaceId, head: 5 });
      vi.advanceTimersByTime(30_001);
      expect(quiet.result.failed).toBe("join_timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a revoked device and refuses its later writes", () => {
    const { chain, ana, cy, roomId, seal } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    net.link(a, c);
    net.pump();
    a.offerVersions([nextVersion(a.workspaceId, a.chain.head, ana.sign, (state) => (state.devices[cy.id]!.revoked = true))]);
    net.pump();
    expect(a.connectedDevices()).toEqual([]);
    expect(a.publish(seal(cy, 1, "after revocation"))).toBe(false);
    expect(a.store.envelopesOf(roomId, INDEX_DOC).updates).toHaveLength(0);
  });

  it("tells a device it was revoked before letting it go, over a channel that queues", async () => {
    const { chain, ws, ana, cy } = setup();
    const a = nodeFor(chain, ana);
    const sent: PeerMessage[] = [];
    let closed = false;
    const session = a.connect({ send: (message) => { if (!closed) sent.push(message); }, drained: () => Promise.resolve(), close: () => { closed = true; } }, cy.id);
    session.receive({ t: "hello", ws, head: chain.head.body.v, recent: [[chain.head.body.v, chain.headHash]] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    sent.length = 0;
    a.offerVersions([nextVersion(a.workspaceId, a.chain.head, ana.sign, (state) => (state.devices[cy.id]!.revoked = true))]);
    expect(closed).toBe(true);
    expect(sent.map((message) => message.t)).toContain("versions");
  });

  it("passes presence on without storing it, and without looping", () => {
    const { chain, ws, ana, ben, cy, roomId, key } = setup();
    const net = new Network();
    const seen: string[] = [];
    const a = nodeFor(chain, ana);
    const b = new MeshNode(WorkspaceChain.load(chain.all()), ben.id);
    const c = new MeshNode(WorkspaceChain.load(chain.all()), cy.id, { presence: (env) => seen.push(env.author) });
    net.link(a, b);
    net.link(b, c);
    net.link(a, c);
    net.pump();
    a.publish(sealPresence({ ws, room: roomId, n: 1, key, author: ana.sign }, Date.now(), utf8("cursor")));
    const delivered = net.pump();
    expect(seen).toEqual([ana.id]);
    expect(delivered).toBeLessThan(20);
    expect(c.store.rooms()).toEqual([]);
  });

  it("ends a session with a device that speaks for another workspace", () => {
    const one = setup();
    const other = founder();
    const net = new Network();
    const a = nodeFor(one.chain, one.ana);
    // Same device id (the transport proved the key), but its node belongs to a different workspace.
    const x = new MeshNode(other.chain, one.cy.id);
    net.link(a, x);
    net.pump();
    expect(a.connectedDevices()).toEqual([]);
    expect(x.connectedDevices()).toEqual([]);
  });

  it("keeps nothing a stranger sends before joining, and only one wrap per slot", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const a = nodeFor(chain, ana);
    const stranger = founder().admin;
    const session = a.connect({ send: () => {}, close: () => {} }, stranger.id);
    // A made-up join for an invite nobody issued: refused, and not kept for later.
    const fake = createJoinRecord({ workspaceId: ws, inviteId: randomId("i"), secret: randomBytes(32), user: { id: randomId("u"), name: "Eve" }, deviceName: "Eve", deviceKey: stranger.sign, agreementPublicKey: stranger.agree.publicKey, tlsFingerprint: stranger.tls });
    // Nor are other joins it passes on, and the session ends.
    const other = founder().admin;
    const passing = a.connect({ send: () => {}, close: () => {} }, other.id);
    passing.receive({ t: "joins", joins: [createJoinRecord({ workspaceId: ws, inviteId: randomId("i"), secret: randomBytes(32), user: { id: randomId("u"), name: "Mal" }, deviceName: "Mal", deviceKey: other.sign, agreementPublicKey: other.agree.publicKey, tlsFingerprint: other.tls })] });
    expect(passing.isClosed).toBe(true);
    expect(a.joinEntries()).toEqual([]);
    session.receive({ t: "join", join: fake });
    expect(session.isClosed).toBe(true);
    expect(a.joinEntries()).toEqual([]);
    expect(a.addWrap(wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign))).toBe(true);
    expect(a.addWrap(wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign))).toBe(false);
    expect(a.allWraps()).toHaveLength(1);
  });

  it("keeps one join per invite, the one every peer picks", () => {
    const { chain, ws, ana } = setup();
    const a = nodeFor(chain, ana);
    const withInvite = invite(chain, ana, { fold: false });
    a.offerVersions(chain.since(a.chain.length));
    const joins = [withInvite.join];
    for (let i = 0; i < 5; i++) {
      const device = founder().admin;
      joins.push(createJoinRecord({ workspaceId: ws, inviteId: withInvite.inviteId, secret: withInvite.secret, user: { id: randomId("u"), name: `Twin ${i}` }, deviceName: "Twin", deviceKey: device.sign, agreementPublicKey: device.agree.publicKey, tlsFingerprint: device.tls }));
    }
    for (const j of joins) a.addJoin(j);
    expect(a.pendingJoinRecords()).toHaveLength(1);
    const lowest = joins.map((j) => joinHash(j)).sort()[0];
    expect(joinHash(a.pendingJoinRecords()[0]!)).toBe(lowest);
  });

  it("a wrap that doesn't verify can't take the place of the genuine one", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const a = nodeFor(chain, ana);
    const genuine = wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    // Someone sends a wrap in Ana's name (same room, epoch and recipient) with a signature that doesn't hold.
    const forged = structuredClone(genuine);
    forged.sig = genuine.sig.startsWith("A") ? `B${genuine.sig.slice(1)}` : `A${genuine.sig.slice(1)}`;
    expect(a.addWrap(forged)).toBe(false);
    expect(a.addWrap(genuine)).toBe(true);
    expect(a.allWraps()).toEqual([genuine]);
  });

  it("keeps the wraps of a room whose creation lost a race, so the room made again has its key", () => {
    const { chain, ws, ana, ben } = setup();
    step(chain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const b = nodeFor(chain, ben);
    const parent = b.chain.head;
    // Ben creates a room and files his receipt for its key.
    const draft = WorkspaceChain.load(b.chain.all());
    const { roomId, key } = createRoom(draft, ben, "Design");
    const lost = draft.head;
    b.offerVersions([lost]);
    const receipt = wrapRoomKey(ws, roomId, 1, key, { id: ben.id, agree: ben.agree.publicKey }, ben.sign);
    expect(b.addWrap(receipt)).toBe(true);
    // At the same moment Ana, who ranks higher, changed something else: her version wins, and the room is gone...
    expect(b.offerVersions([nextVersion(ws, parent, ana.sign, (state) => (state.name = "Ana's"))]).status).toBe("replaced");
    expect(b.allWraps()).toEqual([]);
    expect(b.savedWraps()).toEqual([receipt]);
    // ...until Ben's device makes it again, with the same key: the receipt counts again, here and after a restart.
    b.offerVersions([nextVersion(ws, b.chain.head, ben.sign, (state) => void Object.assign(state, rebaseChange(parent.body.state, lost.body.state, state)))]);
    expect(b.allWraps()).toEqual([receipt]);
    const restarted = nodeFor(b.chain, ben);
    restarted.restore([], b.savedWraps());
    expect(restarted.allWraps()).toEqual([receipt]);
  });

  it("a join the losing branch took back out doesn't come back", () => {
    const { chain, ws, ana, ben, roomId } = setup();
    step(chain, ana, (state) => {
      state.users[ben.userId]!.admin = true;
      state.rooms[roomId]!.members[ben.userId] = "write";
    });
    const { joiner: mal, join } = invite(chain, ben, { userName: "Mal", fold: false });
    const a = nodeFor(chain, ana);
    const parent = a.chain.head;
    // Ben records Mal's join, then revokes Mal's device; Ana, at the same moment, lowers Ben in a room: hers wins.
    a.offerVersions([nextVersion(ws, parent, ben.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    a.offerVersions([nextVersion(ws, a.chain.head, ben.sign, (state) => (state.devices[mal.id]!.revoked = true))]);
    expect(a.offerVersions([nextVersion(ws, parent, ana.sign, (state) => (state.rooms[roomId]!.members[ben.userId] = "read"))]).status).toBe("replaced");
    expect(a.pendingJoinRecords()).toEqual([]);
    expect(a.effective().devices[mal.id]).toBeUndefined();
  });

  it("someone the losing branch took out of a room stays out, even if the room was deleted after", () => {
    const { chain, ws, ana, ben, cy, roomId } = setup();
    const { roomId: other } = createRoom(chain, ana, "Other", { [ben.userId]: "write" });
    step(chain, ana, (state) => {
      state.users[ben.userId]!.admin = true;
      state.rooms[roomId]!.members[ben.userId] = "manage";
      state.rooms[roomId]!.members[cy.userId] = "manage";
    });
    const { joiner: mal, join } = invite(chain, ben, { userName: "Mal", rooms: { [roomId]: "write" }, fold: false });
    const c = nodeFor(chain, cy);
    const parent = c.chain.head;
    // Ben records Mal's join and takes him out of the room, then Cy deletes the room; Ana's change at the same moment wins.
    c.offerVersions([nextVersion(ws, parent, ben.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    c.offerVersions([nextVersion(ws, c.chain.head, ben.sign, (state) => void delete state.rooms[roomId]!.members[mal.userId])]);
    c.offerVersions([nextVersion(ws, c.chain.head, cy.sign, (state) => void (state.rooms[roomId]!.deleted = true))]);
    expect(c.offerVersions([nextVersion(ws, parent, ana.sign, (state) => void delete state.rooms[other]!.members[ben.userId])]).status).toBe("replaced");
    expect(c.pendingJoinRecords()).toEqual([]);
    expect(c.effective().devices[mal.id]).toBeUndefined();
  });

  it("a join comes back when the losing branch only deleted a room it gave", () => {
    const { chain, ws, ana, ben, cy, roomId } = setup();
    const { roomId: other } = createRoom(chain, ana, "Other", { [ben.userId]: "write" });
    step(chain, ana, (state) => {
      state.users[ben.userId]!.admin = true;
      state.rooms[roomId]!.members[ben.userId] = "manage";
      state.rooms[roomId]!.members[cy.userId] = "manage";
    });
    const { join } = invite(chain, ben, { userName: "Mal", rooms: { [roomId]: "write" }, fold: false });
    const c = nodeFor(chain, cy);
    const parent = c.chain.head;
    c.offerVersions([nextVersion(ws, parent, ben.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    c.offerVersions([nextVersion(ws, c.chain.head, cy.sign, (state) => void (state.rooms[roomId]!.deleted = true))]);
    expect(c.offerVersions([nextVersion(ws, parent, ana.sign, (state) => void delete state.rooms[other]!.members[ben.userId])]).status).toBe("replaced");
    expect(c.pendingJoinRecords()).toEqual([join]);
  });

  it("another computer of an existing user comes back when the losing branch only changed that user's rooms", () => {
    const { chain, ws, ana, ben, cy, roomId } = setup();
    const { roomId: other } = createRoom(chain, ana, "Other", { [ben.userId]: "write" });
    step(chain, ana, (state) => {
      state.users[ben.userId]!.admin = true;
      state.rooms[roomId]!.members[ben.userId] = "manage";
    });
    const { join } = invite(chain, cy, { forUser: cy, fold: false });
    const a = nodeFor(chain, ana);
    const parent = a.chain.head;
    // Cy records her new computer, and Ben lowers Cy in the room he manages; Ana's change at the same moment wins.
    a.offerVersions([nextVersion(ws, parent, cy.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    a.offerVersions([nextVersion(ws, a.chain.head, ben.sign, (state) => void (state.rooms[roomId]!.members[cy.userId] = "read"))]);
    expect(a.offerVersions([nextVersion(ws, parent, ana.sign, (state) => void delete state.rooms[other]!.members[ben.userId])]).status).toBe("replaced");
    expect(a.pendingJoinRecords()).toEqual([join]);
  });

  it("a join comes back when its person only left a room themselves in the losing branch", () => {
    const { chain, ws, ana, ben, roomId } = setup();
    const { roomId: other } = createRoom(chain, ana, "Other", { [ben.userId]: "write" });
    step(chain, ana, (state) => {
      state.users[ben.userId]!.admin = true;
      state.rooms[roomId]!.members[ben.userId] = "manage";
    });
    const { joiner: mal, join } = invite(chain, ben, { userName: "Mal", rooms: { [roomId]: "write" }, fold: false });
    const a = nodeFor(chain, ana);
    const parent = a.chain.head;
    // Ben records Mal's join and Mal leaves the room he was given; Ana, at the same moment, takes Ben out of another room.
    a.offerVersions([nextVersion(ws, parent, ben.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    a.offerVersions([nextVersion(ws, a.chain.head, mal.sign, (state) => void delete state.rooms[roomId]!.members[mal.userId])]);
    expect(a.offerVersions([nextVersion(ws, parent, ana.sign, (state) => void delete state.rooms[other]!.members[ben.userId])]).status).toBe("replaced");
    expect(a.pendingJoinRecords()).toEqual([join]);
  });

  it("a join whose recording lost a race waits to be recorded again", () => {
    const { chain, ws, ana, ben, cy, roomId } = setup();
    step(chain, ana, (state) => (state.rooms[roomId]!.members[ben.userId] = "manage"));
    const { joiner: dan, join } = invite(chain, ana, { userName: "Dan", fold: false });
    const a = nodeFor(chain, ana);
    const parent = a.chain.head;
    a.offerVersions([nextVersion(ws, parent, ana.sign, (state) => foldJoinInto(state, join), Date.now(), [join])]);
    expect(a.chain.state.devices[dan.id]).toBeDefined();
    // At the same moment Ben lowers Cy in the room he manages: that takes standing away, so his branch wins.
    expect(a.offerVersions([nextVersion(ws, parent, ben.sign, (state) => (state.rooms[roomId]!.members[cy.userId] = "read"))]).status).toBe("replaced");
    expect(a.chain.state.devices[dan.id]).toBeUndefined();
    expect(a.pendingJoinRecords()).toEqual([join]);
    expect(a.effective().devices[dan.id]).toBeDefined();
  });

  it("keeps the wraps of a deleted room while a fork could still undo the deletion", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const toCy = wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    step(chain, ana, (state) => (state.rooms[roomId]!.deleted = true));
    const a = nodeFor(chain, ana);
    a.restore([], [toCy]);
    expect(a.savedWraps()).toEqual([toCy]);
    for (let i = 0; i <= MAX_FORK_DEPTH; i++) a.offerVersions([nextVersion(ws, a.chain.head, ana.sign, (state) => (state.name = `Team ${i}`))]);
    expect(a.savedWraps()).toEqual([]);
  });

  it("after a restart, still knows who held a room's newest key, until that key is replaced", () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const toCy = wrapRoomKey(ws, roomId, 1, key, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    // Cy leaves the room; the key is to be replaced, and Ana's device restarts before it is.
    step(chain, cy, (state) => void delete state.rooms[roomId]!.members[cy.userId]);
    const a = nodeFor(chain, ana);
    a.restore([], [toCy]);
    expect(a.allWraps()).toEqual([]);
    expect(a.savedWraps()).toEqual([toCy]);
    a.offerVersions([nextVersion(ws, a.chain.head, ana.sign, (state) => void state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(ws, roomId, 2, newRoomKey()) }))]);
    expect(a.savedWraps()).toEqual([]);
  });

  it("one peer's flood of wraps that never verify can't push out a wrap another peer sent", () => {
    const { chain, ws, ana, ben, cy, roomId } = setup();
    const a = nodeFor(chain, ana);
    // Cy's wrap of a key Ana's record doesn't know yet arrives, then a flood of junk from Ben's device.
    const k2 = newRoomKey();
    const early = wrapRoomKey(ws, roomId, 2, k2, { id: cy.id, agree: cy.agree.publicKey }, cy.sign);
    a.addWrap(early, { remoteDevice: cy.id } as PeerSession);
    for (let i = 0; i < 2100; i++) a.addWrap({ ...early, body: { ...early.body, by: randomId("d") } }, { remoteDevice: ben.id } as PeerSession);
    a.offerVersions([nextVersion(ws, a.chain.head, cy.sign, (state) => void state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(ws, roomId, 2, k2) }))]);
    expect(a.allWraps()).toContainEqual(early);
  });

  it("waits for what is being stored even when a listener fails", async () => {
    const { chain, ana, seal } = setup();
    const a = new MeshNode(WorkspaceChain.load(chain.all()), ana.id, {
      stored: () => {
        throw new Error("listener");
      }
    });
    a.persist = () => Promise.resolve();
    a.publish(seal(ana, 1, "stored"));
    await expect(a.stored()).resolves.toBeUndefined();
  });

  it("stops storing, and trying again, once stopped", async () => {
    vi.useFakeTimers();
    try {
      const { chain, ana, seal } = setup();
      const a = nodeFor(chain, ana);
      let tries = 0;
      a.persist = () => (tries++, Promise.reject(new Error("disk full")));
      a.publish(seal(ana, 1, "never stored"));
      await vi.advanceTimersByTimeAsync(0);
      a.stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(tries).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps (receipts included) of a key that lost a rotation race stop counting, so the right one can take their place", () => {
    const { chain, ws, ana, cy, roomId } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    const link = net.link(a, c);
    net.pump();
    link.cut();
    // Apart, both rotate the room's key; Cy files a receipt for hers.
    const kc = newRoomKey();
    const ka = newRoomKey();
    c.offerVersions([nextVersion(ws, c.chain.head, cy.sign, (state) => void state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(ws, roomId, 2, kc) }))]);
    expect(c.addWrap(wrapRoomKey(ws, roomId, 2, kc, { id: cy.id, agree: cy.agree.publicKey }, cy.sign))).toBe(true);
    a.offerVersions([nextVersion(ws, a.chain.head, ana.sign, (state) => void state.rooms[roomId]!.epochs.push({ n: 2, commit: keyCommitment(ws, roomId, 2, ka) }))]);
    // They meet; Ana's rotation wins. Cy's receipt for the losing key no longer counts, and Ana's wrap gets through.
    net.link(a, c);
    net.pump();
    expect(c.chain.headHash).toBe(a.chain.headHash);
    expect(c.allWraps().filter((w) => w.body.n === 2)).toEqual([]);
    const right = wrapRoomKey(ws, roomId, 2, ka, { id: cy.id, agree: cy.agree.publicKey }, ana.sign);
    expect(a.addWrap(right)).toBe(true);
    net.pump();
    expect(c.allWraps().map((w) => w.body.commit)).toContain(keyCommitment(ws, roomId, 2, ka));
    // A wrap naming another commitment than the record's is refused outright.
    const stale = wrapRoomKey(ws, roomId, 2, kc, { id: cy.id, agree: cy.agree.publicKey }, cy.sign);
    expect(c.addWrap(stale)).toBe(false);
  });

  it("stores before sending, and keeps trying when storing fails", async () => {
    vi.useFakeTimers();
    try {
      const { chain, ana, cy, roomId, key, seal } = setup();
      const net = new Network();
      const a = nodeFor(chain, ana);
      const c = nodeFor(chain, cy);
      let failures = 1;
      a.persist = () => (failures-- > 0 ? Promise.reject(new Error("disk full")) : Promise.resolve());
      net.link(a, c);
      net.pump();
      const env = seal(ana, 1, "kept back");
      a.publish(env);
      await vi.advanceTimersByTimeAsync(0);
      net.pump();
      expect(texts(c, roomId, key)).toEqual([]);
      expect(a.isUnpersisted(env as StoredEnvelope)).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      net.pump();
      expect(texts(c, roomId, key)).toEqual(["kept back"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes on at once what it received, and keeps storing it until it is stored", async () => {
    vi.useFakeTimers();
    try {
      const { chain, ana, ben, cy, roomId, key, seal } = setup();
      const net = new Network();
      const a = nodeFor(chain, ana);
      const b = nodeFor(chain, ben);
      const c = nodeFor(chain, cy);
      let failures = 1;
      b.persist = () => (failures-- > 0 ? Promise.reject(new Error("disk full")) : Promise.resolve());
      net.link(a, b);
      net.link(b, c);
      net.pump();
      a.publish(seal(ana, 1, "via Ben"));
      net.pump();
      await vi.advanceTimersByTimeAsync(0);
      // Ben's disk couldn't store it: passed on all the same, and known not to be stored here yet.
      expect(texts(c, roomId, key)).toEqual(["via Ben"]);
      expect(b.hasUnstoredReceived(`${roomId}/${INDEX_DOC}/`)).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(b.hasUnstoredReceived(`${roomId}/${INDEX_DOC}/`)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the record as the previous release does, 500 versions a message, cutting only what wouldn't fit a frame", () => {
    const { chain, ana, cy } = setup();
    const base = chain.length;
    for (let i = 0; i < 20; i++) createRoom(chain, ana, `Room ${i}`);
    const added = chain.all().slice(base);
    /** Cy's computer with the record up to `base` (and, with `own`, a version of its own), meeting Ana's: what it is sent. */
    const meet = (own: boolean) => {
      const prefix = WorkspaceChain.load(chain.all().slice(0, base));
      if (own) step(prefix, cy, (state) => void (state.users[cy.userId]!.name = "Cy too"));
      const c = new MeshNode(prefix, cy.id);
      const offered: number[] = [];
      const offer = c.offerVersions.bind(c);
      c.offerVersions = (versions, from, appendOnly) => (from && offered.push(versions.length), offer(versions, from, appendOnly));
      const net = new Network();
      net.link(nodeFor(chain, ana), c);
      net.pump();
      return offered;
    };
    // Behind, or with a branch of its own: all of it in one message, judged whole.
    expect(meet(false)).toEqual([added.length]);
    expect(meet(true)).toEqual([added.length]);
    // Cut by size: every version, in order, each run within the size (or a single version).
    const size = (version: (typeof added)[number]) => Buffer.byteLength(JSON.stringify(version));
    const limit = Math.max(...added.map(size)) * 3;
    const runs = versionBatches(added, limit);
    expect(runs.flat()).toEqual(added);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) expect(run.length === 1 || run.reduce((bytes, version) => bytes + size(version), 0) <= limit).toBe(true);
    expect(versionBatches(added, Infinity)).toEqual([added]);
  });

  it("lets a join take effect only within the record's limits, counting the joins before it", () => {
    const { chain, ana } = setup();
    // Computers of Ana's up to one below the limit, then two more joining at once.
    while (Object.values(chain.state.devices).filter((device) => device.user === ana.userId).length < 29) invite(chain, ana, { forUser: ana });
    const joins = [invite(chain, ana, { forUser: ana, fold: false }).join, invite(chain, ana, { forUser: ana, fold: false }).join];
    const a = nodeFor(chain, ana);
    for (const join of joins) a.addJoin(join);
    expect(a.joinsInEffect()).toHaveLength(1);
    expect(Object.values(a.effective().devices).filter((device) => device.user === ana.userId)).toHaveLength(30);
    // Once the one in effect is recorded, the other can't take effect at all.
    const recorded = a.joinsInEffect()[0]!;
    fold(chain, ana, recorded);
    const b = nodeFor(chain, ana);
    b.addJoin(joins.find((join) => join !== recorded)!);
    expect(b.joinsInEffect()).toEqual([]);
    expect(Object.values(b.effective().devices).filter((device) => device.user === ana.userId)).toHaveLength(30);
  });

  it("doesn't hold an attachment it received in memory to store it again", async () => {
    vi.useFakeTimers();
    try {
      const { chain, ws, ana, cy, roomId, key } = setup();
      const net = new Network();
      const a = nodeFor(chain, ana);
      const c = nodeFor(chain, cy);
      let tries = 0;
      c.persist = () => (tries++, Promise.reject(new Error("disk full")));
      net.link(a, c);
      net.pump();
      a.publish(sealBlob({ ws, room: roomId, n: 1, key, author: ana.sign }, utf8("a large scan")));
      net.pump();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(c.store.blobKeys(roomId)).toHaveLength(1);
      expect(tries).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes on more small file versions than fit in one message", async () => {
    const { chain, ws, ana, cy, roomId, key } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    for (let i = 0; i < 501; i++) a.publish(sealBlob({ ws, room: roomId, n: 1, key, author: ana.sign }, utf8(`file ${i}`)));
    const c = nodeFor(chain, cy);
    net.link(a, c);
    await net.settle();
    expect(c.store.blobKeys(roomId)).toHaveLength(501);
  });

  it("refuses presence that isn't fresh", () => {
    const { chain, ws, ana, roomId, key } = setup();
    const a = nodeFor(chain, ana);
    expect(a.publish(sealPresence({ ws, room: roomId, n: 1, key, author: ana.sign }, Date.now() - 11 * 60_000, utf8("old")))).toBe(false);
    expect(a.publish(sealPresence({ ws, room: roomId, n: 1, key, author: ana.sign }, Date.now(), utf8("now")))).toBe(true);
  });

  it("sends what it made only once it is stored", async () => {
    const { chain, ana, cy, roomId, key, seal } = setup();
    const net = new Network();
    const a = nodeFor(chain, ana);
    const c = nodeFor(chain, cy);
    let release: () => void = () => {};
    a.persist = () => new Promise<void>((resolve) => (release = resolve));
    net.link(a, c);
    net.pump();
    a.publish(seal(ana, 1, "pending"));
    net.pump();
    expect(texts(c, roomId, key)).toEqual([]);
    release();
    await net.settle();
    expect(texts(c, roomId, key)).toEqual(["pending"]);
  });

  it("a joining device refuses a record that doesn't know its invite", () => {
    const { chain, ws, ana } = setup();
    const { join } = invite(WorkspaceChain.load(chain.all()), ana, { fold: false });
    const outcome: string[] = [];
    const handshake = new JoinHandshake({ send: () => {}, close: () => {} }, ws, join, () => outcome.push("accepted"), (reason) => outcome.push(reason));
    handshake.receive({ t: "hello", ws, head: chain.head.body.v, recent: [] });
    handshake.receive({ t: "versions", versions: JSON.parse(JSON.stringify(chain.all())) });
    expect(outcome).toEqual([expect.stringMatching(/join_no_invite/)]);
  });

  it("counts its record as compared once a device the record lists answers, or when it lists no other, and asks again after a time away", () => {
    const { chain, ana, ben, cy } = setup();
    // A device joining through this one (its join not recorded yet) only has the record it got here: it doesn't count.
    const pending = invite(chain, ana, { fold: false });
    const a = nodeFor(chain, ana);
    expect(a.addJoin(pending.join)).toBe(true);
    expect(a.recordCompared).toBe(false);
    const joiner = a.connect({ send: () => {}, close: () => {} }, pending.joiner.id);
    joiner.receive({ t: "digests", rooms: {} });
    expect(a.recordCompared).toBe(false);
    // A member's answer to our hello counts.
    const sent: PeerMessage[] = [];
    const session = a.connect({ send: (m) => sent.push(m), close: () => {} }, cy.id);
    session.receive({ t: "digests", rooms: {} });
    expect(a.recordCompared).toBe(true);
    // After a time away it doesn't, until the member answers the hello it is sent again.
    sent.length = 0;
    a.recompare();
    expect(a.recordCompared).toBe(false);
    expect(sent.map((m) => m.t)).toEqual(["hello"]);
    session.receive({ t: "digests", rooms: {} });
    expect(a.recordCompared).toBe(true);
    // A device whose record lists no other active device has nothing to wait for (another device's revoked, say).
    const b = nodeFor(chain, ana);
    expect(b.recordCompared).toBe(false);
    for (const device of [ben, cy]) step(b.chain, ana, (state) => void (state.devices[device.id]!.revoked = true));
    expect(b.recordCompared).toBe(true);
    // Nor has one that was alone when it started, with only those that joined through it since; until it was away.
    const alone = founder();
    const c = nodeFor(alone.chain, alone.admin);
    expect(c.recordCompared).toBe(true);
    invite(c.chain, alone.admin, { userName: "Newcomer" });
    expect(c.recordCompared).toBe(true);
    c.recompare();
    expect(c.recordCompared).toBe(false);
  });

  it("takes from a device that isn't a member here only versions that extend its record, and lets it go on anything else", () => {
    const { chain, ana, ben } = setup();
    // A branch made elsewhere, next to ours, that would win against it (it revokes a device).
    const theirs = WorkspaceChain.load(chain.all());
    step(theirs, ana, (state) => void (state.devices[ben.id]!.revoked = true));
    step(chain, ana, (state) => void (state.name = "Ours"));
    const check = WorkspaceChain.load(chain.all());
    expect(check.offer(theirs.since(theirs.head.body.v)).status).toBe("replaced");
    const a = nodeFor(chain, ana);
    const sent: PeerMessage[] = [];
    const session = a.connect({ send: (m) => sent.push(m), close: () => {} }, founder().admin.id);
    // It holds our record up to where the branches part: it hears our hello, then sends its branch.
    const base = theirs.head.body.v - 1;
    session.receive({ t: "hello", ws: a.workspaceId, head: base, recent: [[base, theirs.hashAt(base)!]] });
    expect(sent.map((m) => m.t)).toEqual(["hello"]);
    session.receive({ t: "versions", versions: theirs.since(base + 1) });
    expect(session.isClosed).toBe(true);
    expect(a.chain.state.name).toBe("Ours");
    // Versions without a hello first, or with the first version of all among them, end the session too.
    const unasked = a.connect({ send: () => {}, close: () => {} }, founder().admin.id);
    unasked.receive({ t: "versions", versions: chain.since(chain.head.body.v) });
    expect(unasked.isClosed).toBe(true);
    const first = a.connect({ send: () => {}, close: () => {} }, founder().admin.id);
    first.receive({ t: "hello", ws: a.workspaceId, head: base, recent: [[base, theirs.hashAt(base)!]] });
    first.receive({ t: "versions", versions: chain.all().slice(0, 2) });
    expect(first.isClosed).toBe(true);
    // An answer that is over (its digests) without making it a member ends it as well.
    const over = a.connect({ send: () => {}, close: () => {} }, founder().admin.id);
    over.receive({ t: "hello", ws: a.workspaceId, head: base, recent: [[base, theirs.hashAt(base)!]] });
    over.receive({ t: "digests", rooms: {} });
    expect(over.isClosed).toBe(true);
  });

  it("says nothing to a device that isn't a member until it presents a join, even if it knows the workspace", () => {
    const { chain, ana } = setup();
    const stranger = founder().admin;
    const sent: PeerMessage[] = [];
    const a = nodeFor(chain, ana);
    const session = a.connect({ send: (m) => sent.push(m), close: () => {} }, stranger.id);
    expect(sent).toEqual([]);
    session.receive({ t: "hello", ws: a.workspaceId, head: 0, recent: [] });
    expect(session.isClosed).toBe(true);
    // Knowing the workspace id (the first version's hash) proves nothing either.
    const again = a.connect({ send: (m) => sent.push(m), close: () => {} }, stranger.id);
    again.receive({ t: "hello", ws: a.workspaceId, head: 0, recent: [[0, chain.hashAt(0)!]] });
    expect(again.isClosed).toBe(true);
    expect(sent).toEqual([]);
  });
});
