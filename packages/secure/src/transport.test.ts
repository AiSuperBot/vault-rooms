import { afterEach, describe, expect, it } from "vitest";
import * as tls from "node:tls";
import { fromUtf8, utf8 } from "./bytes.js";
import { WorkspaceChain } from "./chain.js";
import { newSigningKeyPair } from "./crypto.js";
import { makeAnnouncement, readAnnouncement } from "./discovery.js";
import { INDEX_DOC, openEnvelope, sealUpdate } from "./envelope.js";
import { encodeFrame, FrameReader } from "./frames.js";
import { randomId } from "./ids.js";
import { formatInviteLink, newInvite, parseInviteLink } from "./invite.js";
import { MeshNode } from "./mesh.js";
import { joinWorkspace, PeerManager } from "./peers.js";
import { createRoom, founder, invite, step } from "./testkit.js";
import { createTlsIdentity, type TlsIdentity } from "./tlsIdentity.js";
import { dial, PeerServer, workspaceTag, type PeerLink, type TransportConfig } from "./transport.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function world() {
  const tlsA = await createTlsIdentity("ana");
  const tlsC = await createTlsIdentity("cy");
  const { chain, ws, admin: ana } = founder("Team", "Ana", tlsA.fingerprint);
  const { joiner: cy } = invite(chain, ana, { userName: "Cy", tls: tlsC.fingerprint });
  const { roomId, key } = createRoom(chain, ana, "Plans", { [cy.userId]: "write" });
  return { chain, ws, ana, cy, tlsA, tlsC, roomId, key };
}

/** A peer: node, server, manager, all on localhost. */
async function peer(chain: WorkspaceChain, device: { id: string; sign: ReturnType<typeof newSigningKeyPair> }, tlsId: TlsIdentity, staticPeers: Array<{ host: string; port: number }> = []) {
  const node = new MeshNode(WorkspaceChain.load(chain.all()), device.id);
  const config: TransportConfig = { workspaceId: chain.workspaceId, deviceId: device.id, deviceKey: device.sign, tls: tlsId, membership: () => node.effective() };
  const manager = new PeerManager(node, config, () => staticPeers);
  const server = new PeerServer(config, (link) => manager.accept(link));
  const port = await server.listen(0, "127.0.0.1");
  cleanups.push(() => server.close(), () => manager.stop());
  return { node, config, manager, server, port };
}

describe("frames", () => {
  it("reassemble messages split anywhere and refuse oversized ones", () => {
    const bytes = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: "two" })]);
    const reader = new FrameReader();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 3) out.push(...reader.push(bytes.subarray(i, i + 3)));
    expect(out).toEqual([{ a: 1 }, { b: "two" }]);
    const small = new FrameReader(10);
    expect(() => small.push(encodeFrame({ long: "x".repeat(50) }))).toThrow(/frame_too_large/);
  });
});

describe("TLS transport", () => {
  it("connects two members, pinned and mutually authenticated, and syncs over it", async () => {
    const w = await world();
    const a = await peer(w.chain, w.ana, w.tlsA);
    const c = await peer(w.chain, w.cy, w.tlsC, [{ host: "127.0.0.1", port: a.port }]);
    c.manager.start();
    await until(() => a.manager.connected().includes(w.cy.id) && c.manager.connected().includes(w.ana.id));
    a.node.publish(sealUpdate({ ws: w.ws, room: w.roomId, n: 1, key: w.key, author: w.ana.sign }, INDEX_DOC, 1, utf8("over TLS")));
    await until(() => c.node.store.envelopesOf(w.roomId, INDEX_DOC).updates.length === 1);
    expect(fromUtf8(openEnvelope(c.node.store.envelopesOf(w.roomId, INDEX_DOC).updates[0]!, w.key))).toBe("over TLS");
  });

  it("refuses a server whose certificate isn't the pinned one", async () => {
    const w = await world();
    const a = await peer(w.chain, w.ana, w.tlsA);
    const config: TransportConfig = { workspaceId: w.ws, deviceId: w.cy.id, deviceKey: w.cy.sign, tls: w.tlsC, membership: () => w.chain.state };
    await expect(dial(config, "127.0.0.1", a.port, { device: w.ana.id, fingerprint: w.tlsC.fingerprint })).rejects.toThrow("certificate_mismatch");
  });

  it("refuses a caller that claims a member's id without its key", async () => {
    const w = await world();
    const rejected: string[] = [];
    const node = new MeshNode(WorkspaceChain.load(w.chain.all()), w.ana.id);
    const config: TransportConfig = { workspaceId: w.ws, deviceId: w.ana.id, deviceKey: w.ana.sign, tls: w.tlsA, membership: () => node.effective() };
    const server = new PeerServer(config, () => rejected.push("accepted!"), (reason) => rejected.push(reason));
    const port = await server.listen(0, "127.0.0.1");
    cleanups.push(() => server.close());
    const impostor: TransportConfig = { workspaceId: w.ws, deviceId: w.cy.id, deviceKey: newSigningKeyPair(), tls: await createTlsIdentity("x"), membership: () => w.chain.state };
    await expect(dial(impostor, "127.0.0.1", port, { device: w.ana.id, fingerprint: w.tlsA.fingerprint })).rejects.toThrow();
    await until(() => rejected.length > 0);
    expect(rejected).toEqual(["auth_signature"]);
  });

  it("refuses anything but a well-formed auth frame, and drops oversized frames before auth", async () => {
    const w = await world();
    const reasons: string[] = [];
    const config: TransportConfig = { workspaceId: w.ws, deviceId: w.ana.id, deviceKey: w.ana.sign, tls: w.tlsA, membership: () => w.chain.state };
    const server = new PeerServer(config, () => reasons.push("accepted!"), (reason) => reasons.push(reason));
    const port = await server.listen(0, "127.0.0.1");
    cleanups.push(() => server.close());
    const raw = (payload: Buffer) =>
      new Promise<void>((resolve) => {
        const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1.3" }, () => socket.write(payload));
        socket.on("close", () => resolve());
        socket.on("error", () => resolve());
      });
    await raw(encodeFrame({ t: "hello", ws: w.ws }));
    await raw(Buffer.concat([Buffer.from([0, 2, 0, 0]), Buffer.alloc(16)]));
    await until(() => reasons.length >= 2);
    expect(reasons).toEqual(expect.arrayContaining(["auth_malformed", "bad_frame"]));
    expect(reasons).not.toContain("accepted!");
  });

  it("lets a new device join over TLS with an invite link, then sync", async () => {
    const w = await world();
    const tlsD = await createTlsIdentity("dee");
    const fresh = newInvite(w.ana.userId, { [w.roomId]: "read" }, Date.now() + 3_600_000);
    step(w.chain, w.ana, (state) => (state.invites[fresh.inviteId] = fresh.record));
    const a = await peer(w.chain, w.ana, w.tlsA);
    a.node.publish(sealUpdate({ ws: w.ws, room: w.roomId, n: 1, key: w.key, author: w.ana.sign }, INDEX_DOC, 1, utf8("for Dee")));
    const link = parseInviteLink(formatInviteLink({ workspaceId: w.ws, inviteId: fresh.inviteId, secret: fresh.secret, peers: [`127.0.0.1:${a.port}`] }));
    const deeKey = newSigningKeyPair();
    const { chain, join, link: firstLink } = await joinWorkspace({ invite: link, userName: "Dee", deviceName: "Dee PC", deviceKey: deeKey, agreementKey: { publicKey: w.cy.agree.publicKey, secretKey: w.cy.agree.secretKey }, tls: tlsD, newUserId: randomId("u") });
    expect(chain.workspaceId).toBe(w.ws);
    const d = new MeshNode(chain, join.body.device.id);
    d.addJoin(join);
    const config: TransportConfig = { workspaceId: w.ws, deviceId: join.body.device.id, deviceKey: deeKey, tls: tlsD, membership: () => d.effective() };
    const manager = new PeerManager(d, config);
    cleanups.push(() => manager.stop());
    manager.adopt(firstLink as PeerLink);
    await until(() => d.store.envelopesOf(w.roomId, INDEX_DOC).updates.length === 1);
    expect(a.node.effective().devices[join.body.device.id]).toBeDefined();
  });

  it("won't join through a peer that isn't part of the workspace the link names", async () => {
    const w = await world();
    const other = await world();
    const b = await peer(other.chain, other.ana, other.tlsA);
    const fresh = newInvite(w.ana.userId, {}, Date.now() + 3_600_000);
    const link = { workspaceId: w.ws, inviteId: fresh.inviteId, secret: fresh.secret, peers: [`127.0.0.1:${b.port}`] };
    await expect(joinWorkspace({ invite: link, userName: "Eve", deviceName: "Eve", deviceKey: newSigningKeyPair(), agreementKey: w.cy.agree, tls: await createTlsIdentity("eve"), newUserId: randomId("u") })).rejects.toThrow(/could not join/);
  });
});

describe("discovery announcements", () => {
  it("accept fresh announcements signed by members, nothing else", async () => {
    const w = await world();
    const now = Date.now();
    const good = Buffer.from(JSON.stringify(makeAnnouncement(w.ws, w.cy.id, w.cy.sign, 4567, now)));
    expect(readAnnouncement(good, w.ws, w.chain.state, now)).toEqual({ device: w.cy.id, port: 4567 });
    expect(readAnnouncement(good, w.ws, w.chain.state, now + 121_000)).toBeNull();
    expect(readAnnouncement(good, founder().ws, w.chain.state, now)).toBeNull();
    const forged = Buffer.from(JSON.stringify(makeAnnouncement(w.ws, w.cy.id, newSigningKeyPair(), 4567, now)));
    expect(readAnnouncement(forged, w.ws, w.chain.state, now)).toBeNull();
    const tampered = JSON.parse(good.toString());
    tampered.p = 9999;
    expect(readAnnouncement(Buffer.from(JSON.stringify(tampered)), w.ws, w.chain.state, now)).toBeNull();
    expect(readAnnouncement(Buffer.from("not json"), w.ws, w.chain.state, now)).toBeNull();
    expect(workspaceTag(w.ws)).not.toContain(w.ws.slice(0, 10));
  });
});
