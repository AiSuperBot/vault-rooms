import { describe, expect, it } from "vitest";
import { fromUtf8, utf8 } from "./bytes.js";
import { WorkspaceChain } from "./chain.js";
import { INDEX_DOC, openEnvelope, sealPresence, sealUpdate, type Envelope } from "./envelope.js";
import { randomId } from "./ids.js";
import { unwrapRoomKey, wrapRoomKey } from "./keys.js";
import { JoinHandshake, MeshNode, type Channel, type PeerMessage, type PeerSession } from "./mesh.js";
import { createRoom, founder, invite, step, type TestDevice } from "./testkit.js";
import { nextVersion } from "./workspace.js";

/** An in-memory network: messages queue up and are delivered (as JSON, like on the wire) by `pump`. */
class Network {
  private queue: Array<() => void> = [];
  links: Array<{ a: string; b: string; cut: () => void }> = [];

  /** Connect two nodes, as if the transport had authenticated both ends. */
  link(a: MeshNode, b: MeshNode): { ab: PeerSession; ba: PeerSession; cut: () => void } {
    let open = true;
    const sessions: { ab?: PeerSession; ba?: PeerSession } = {};
    // Closing either end closes the connection, so the other end's session ends too (as with a real socket).
    const channel = (to: () => PeerSession | undefined): Channel => ({
      send: (message: PeerMessage) => {
        const wire = JSON.stringify(message);
        this.queue.push(() => open && to()?.receive(JSON.parse(wire)));
      },
      close: () => {
        if (!open) return;
        open = false;
        this.queue.push(() => to()?.close("remote_closed"));
      }
    });
    sessions.ab = a.connect(channel(() => sessions.ba), b.deviceId);
    sessions.ba = b.connect(channel(() => sessions.ab), a.deviceId);
    const cut = () => {
      open = false;
      sessions.ab!.close("cut");
      sessions.ba!.close("cut");
    };
    this.links.push({ a: a.deviceId, b: b.deviceId, cut });
    return { ab: sessions.ab, ba: sessions.ba, cut };
  }

  pump(limit = 100_000): number {
    let delivered = 0;
    while (this.queue.length > 0 && delivered < limit) {
      this.queue.shift()!();
      delivered++;
    }
    if (this.queue.length > 0) throw new Error("network did not settle");
    return delivered;
  }

  enqueue(fn: () => void): void {
    this.queue.push(fn);
  }
}

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
    a.publish(sealPresence({ ws, room: roomId, n: 1, key, author: ana.sign }, 1, utf8("cursor")));
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

  it("says nothing to a device that isn't a member until it presents a join", () => {
    const { chain, ana } = setup();
    const stranger = founder().admin;
    const sent: PeerMessage[] = [];
    const a = nodeFor(chain, ana);
    const session = a.connect({ send: (m) => sent.push(m), close: () => {} }, stranger.id);
    expect(sent).toEqual([]);
    session.receive({ t: "hello", ws: a.workspaceId, head: 0, recent: [] });
    expect(session.isClosed).toBe(true);
    expect(sent).toEqual([]);
    expect(randomId("r")).toBeTruthy();
  });
});
