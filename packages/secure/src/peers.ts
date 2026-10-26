import type { WorkspaceChain } from "./chain.js";
import { createJoinRecord, type InviteLink, type JoinRecord } from "./invite.js";
import { applyJoins } from "./invite.js";
import { JoinHandshake, type MeshNode, type PeerSession } from "./mesh.js";
import { dial, verifyAcceptor, type PeerLink, type TransportConfig } from "./transport.js";
import { activeDevice, type WorkspaceState } from "./workspace.js";
import type { KeyPair } from "./crypto.js";
import type { TlsIdentity } from "./tlsIdentity.js";

/**
 * Keeps one connection per peer: dials devices seen by discovery or listed by address, accepts incoming ones, and
 * hands each authenticated connection to the mesh node. When two connections to the same device exist (both
 * dialled at once), the one dialled by the lower device id stays, so both ends drop the same one.
 */

export interface Address {
  host: string;
  port: number;
}

export interface PeerManagerEvents {
  connected?(device: string, link: PeerLink): void;
  disconnected?(device: string, reason: string): void;
  dialFailed?(target: string, reason: string): void;
}

interface Candidate extends Address {
  firstSeen: number;
  lastSeen: number;
}

const WAIT_FOR_DIAL_MS = 8_000;
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;

export class PeerManager {
  private links = new Map<string, { link: PeerLink; session: PeerSession }>();
  private candidates = new Map<string, Candidate>();
  private dialing = new Set<string>();
  private backoff = new Map<string, { until: number; delay: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly node: MeshNode,
    private readonly config: TransportConfig,
    private readonly staticPeers: () => Address[] = () => [],
    private readonly events: PeerManagerEvents = {},
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), 3_000);
    (this.timer as { unref?: () => void }).unref?.();
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const { link } of this.links.values()) link.channel.close("stopping");
    this.links.clear();
  }

  connected(): string[] {
    return [...this.links.keys()];
  }

  /** From discovery. */
  candidate(device: string, host: string, port: number): void {
    if (device === this.config.deviceId) return;
    const now = this.now();
    const known = this.candidates.get(device);
    this.candidates.set(device, { host, port, firstSeen: known && known.host === host && known.port === port ? known.firstSeen : now, lastSeen: now });
    this.maybeDial(device);
  }

  /** From the server: an authenticated incoming connection. */
  accept(link: PeerLink): void {
    this.attach(link);
  }

  /** Adopt a connection made elsewhere (e.g. the one a joining device used to fetch the record). */
  adopt(link: PeerLink): void {
    this.attach(link);
  }

  private tick(): void {
    if (this.stopped) return;
    for (const device of this.candidates.keys()) this.maybeDial(device);
    for (const address of this.staticPeers()) this.dialAddress(address);
  }

  private inBackoff(key: string): boolean {
    const entry = this.backoff.get(key);
    return entry !== undefined && entry.until > this.now();
  }

  private failed(key: string, reason: string): void {
    const previous = this.backoff.get(key)?.delay ?? MIN_BACKOFF_MS / 2;
    const delay = Math.min(MAX_BACKOFF_MS, previous * 2);
    this.backoff.set(key, { until: this.now() + delay, delay });
    this.events.dialFailed?.(key, reason);
  }

  private maybeDial(device: string): void {
    if (this.stopped || this.links.has(device) || this.dialing.has(device) || this.inBackoff(device)) return;
    const candidate = this.candidates.get(device);
    const record = activeDevice(this.node.effective(), device);
    if (!candidate || !record) return;
    // The lower id dials; the higher one waits a little in case the other side can't reach it (a firewall), then dials too.
    if (this.config.deviceId > device && this.now() - candidate.firstSeen < WAIT_FOR_DIAL_MS) return;
    this.dialing.add(device);
    dial(this.config, candidate.host, candidate.port, { device, fingerprint: record.tls })
      .then((link) => this.attach(link))
      .catch((error: Error) => this.failed(device, error.message))
      .finally(() => this.dialing.delete(device));
  }

  /** A peer known only by address: dial, then check who answered against the record. */
  private dialAddress(address: Address): void {
    const key = `${address.host}:${address.port}`;
    if (this.stopped || this.dialing.has(key) || this.inBackoff(key)) return;
    if ([...this.links.values()].some(({ link }) => link.direction === "out" && link.remoteAddress === address.host)) return;
    this.dialing.add(key);
    dial(this.config, address.host, address.port)
      .then((link) => {
        if (!link.unverifiedAcceptor || !verifyAcceptor(this.node.effective(), this.node.workspaceId, this.config.deviceId, link.unverifiedAcceptor)) {
          link.channel.close("unverified_peer");
          return this.failed(key, "unverified_peer");
        }
        if (link.remoteDevice === this.config.deviceId || this.links.has(link.remoteDevice)) return link.channel.close("duplicate");
        this.attach(link);
      })
      .catch((error: Error) => this.failed(key, error.message))
      .finally(() => this.dialing.delete(key));
  }

  private attach(link: PeerLink): void {
    if (this.stopped) return link.channel.close("stopping");
    const existing = this.links.get(link.remoteDevice);
    if (existing) {
      // Keep the connection dialled by the lower device id; both ends reach the same decision.
      const dialerOf = (l: PeerLink) => (l.direction === "out" ? this.config.deviceId : l.remoteDevice);
      const lower = this.config.deviceId < link.remoteDevice ? this.config.deviceId : link.remoteDevice;
      if (dialerOf(existing.link) === lower || dialerOf(link) !== lower) return link.channel.close("duplicate");
      existing.link.channel.close("duplicate");
    }
    const session = this.node.connect(link.channel, link.remoteDevice);
    const entry = { link, session };
    this.links.set(link.remoteDevice, entry);
    this.backoff.delete(link.remoteDevice);
    link.onMessage((message) => session.receive(message));
    link.onClose((reason) => {
      session.close(reason);
      if (this.links.get(link.remoteDevice) === entry) {
        this.links.delete(link.remoteDevice);
        this.events.disconnected?.(link.remoteDevice, reason);
      }
    });
    this.events.connected?.(link.remoteDevice, link);
  }
}

/** An empty membership, for a device that has no workspace record yet. */
export function noMembership(): WorkspaceState {
  return { name: "joining", roomCreation: "admins", users: {}, devices: {}, invites: {}, rooms: {} };
}

/**
 * Join a workspace with an invite link: dial the peers the link lists, send the join record, receive and check the
 * workspace record, then check the peer that answered against it. Resolves with the record, the join record and the
 * open connection (to be adopted by a PeerManager once the node exists).
 */
export async function joinWorkspace(input: {
  invite: InviteLink;
  extraPeers?: Address[];
  userName: string;
  deviceName: string;
  deviceKey: KeyPair;
  agreementKey: KeyPair;
  tls: TlsIdentity;
  /** For joining as another device of an existing user (invites made "for" that user). */
  existingUserId?: string;
  newUserId: string;
}): Promise<{ chain: WorkspaceChain; join: JoinRecord; link: PeerLink }> {
  const { invite } = input;
  const config: TransportConfig = { workspaceId: invite.workspaceId, deviceId: "", deviceKey: input.deviceKey, tls: input.tls, membership: noMembership };
  const join = createJoinRecord({
    workspaceId: invite.workspaceId,
    inviteId: invite.inviteId,
    secret: invite.secret,
    user: { id: input.existingUserId ?? invite.forUser ?? input.newUserId, name: input.userName },
    deviceName: input.deviceName,
    deviceKey: input.deviceKey,
    agreementPublicKey: input.agreementKey.publicKey,
    tlsFingerprint: input.tls.fingerprint
  });
  config.deviceId = join.body.device.id;
  const addresses: Address[] = [
    ...invite.peers.map((peer) => {
      const at = peer.lastIndexOf(":");
      return { host: peer.slice(0, at).replace(/^\[|\]$/g, ""), port: Number(peer.slice(at + 1)) };
    }),
    ...(input.extraPeers ?? [])
  ];
  const errors: string[] = [];
  for (const address of addresses) {
    try {
      const link = await dial(config, address.host, address.port);
      const chain = await new Promise<WorkspaceChain>((resolve, reject) => {
        const handshake = new JoinHandshake(link.channel, invite.workspaceId, join, resolve, (reason) => reject(new Error(reason)));
        link.onMessage((message) => handshake.receive(message));
        link.onClose((reason) => reject(new Error(reason)));
        handshake.start();
      });
      // Now that the record is known, check that whoever answered is the device it claimed, with its pinned certificate.
      const membership = applyJoins(chain.state, chain.workspaceId, [{ join, firstSeen: Date.now() }]).state;
      if (!link.unverifiedAcceptor || !verifyAcceptor(membership, chain.workspaceId, join.body.device.id, link.unverifiedAcceptor)) {
        link.channel.close("unverified_peer");
        throw new Error("unverified_peer");
      }
      return { chain, join, link };
    } catch (error) {
      errors.push(`${address.host}:${address.port} ${(error as Error).message}`);
    }
  }
  throw new Error(`could not join: ${errors.join("; ") || "no peer addresses"}`);
}
