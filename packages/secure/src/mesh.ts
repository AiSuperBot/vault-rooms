import { b64u, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { WorkspaceChain, type OfferResult } from "./chain.js";
import { hashTagged } from "./crypto.js";
import { isDocId, parseEnvelope, verifyEnvelope, type Envelope, type PresenceEnvelope, type StoredEnvelope } from "./envelope.js";
import { fail, SecureError } from "./errors.js";
import { applyJoins, joinHash, parseJoinRecord, verifyJoinRecord, type JoinRecord } from "./invite.js";
import { parseKeyWrap, verifyKeyWrap, type KeyWrap } from "./keys.js";
import { EnvelopeStore, type VersionVector } from "./store.js";
import * as v from "./validate.js";
import { activeDevice, parseSignedVersion, type SignedVersion, type WorkspaceState } from "./workspace.js";

/**
 * A mesh node: this device's copy of the workspace (record, pending joins, key wraps, encrypted room content) and
 * its sessions with other peers. Peers exchange only what the other side lacks and pass new things on, so the
 * workspace converges whichever peers happen to be online. Everything received is verified before it is kept or
 * passed on. Transport (TLS, proving who is on the other end) is the caller's job: a session is created for a
 * channel whose remote device id the transport has already proven.
 */

export interface Channel {
  send(message: PeerMessage): void;
  close(reason: string): void;
}

type Recent = Array<[number, string]>;
type DocSummary = { vv: VersionVector; snaps: string[] };

export type PeerMessage =
  /** First message on a session: where my workspace record stands (`head` -1: I have none yet, I'm joining). */
  | { t: "hello"; ws: string; head: number; recent: Recent }
  /** Consecutive workspace versions, starting right after one the receiver has (or at genesis for a joiner). */
  | { t: "versions"; versions: unknown[] }
  | { t: "joins"; joins: unknown[] }
  | { t: "wraps"; wraps: unknown[] }
  /** Summaries of the rooms I hold. */
  | { t: "digests"; rooms: Record<string, string> }
  /** Exactly what I hold of one room, so the other side can send what I lack. */
  | { t: "room"; room: string; docs: Record<string, DocSummary>; blobs: string[] }
  | { t: "envelopes"; items: unknown[] }
  /** One new envelope, live. */
  | { t: "push"; env: unknown }
  /** A joining device's first message: its join record. */
  | { t: "join"; join: unknown };

export interface MeshEvents {
  /** The workspace record changed; for "replaced", `lost` lists our versions that a winning branch replaced. */
  chain?(result: OfferResult): void;
  /** A new room envelope was stored (from a peer or published here). */
  envelope?(env: StoredEnvelope): void;
  presence?(env: PresenceEnvelope): void;
  wraps?(): void;
  /** The effective membership changed (record or joins). */
  membership?(): void;
  /** A peer sent something invalid. Reported for diagnostics; never thrown at the caller. */
  rejected?(reason: string, from: string): void;
  sessions?(): void;
}

const RECENT = 64;
const MAX_ITEMS = 500;
const MAX_BATCH_BYTES = 8 << 20;
const PRESENCE_MEMORY = 2000;
const MAX_PENDING = 2000;

function hashOf(purpose: string, value: unknown): string {
  return b64u(hashTagged(purpose, utf8(canonicalJson(value))));
}

function errorText(error: unknown): string {
  return error instanceof SecureError ? `${error.code}:${error.message}` : `error:${String(error)}`;
}

export class MeshNode {
  readonly store: EnvelopeStore;
  chain: WorkspaceChain;
  private joins = new Map<string, { join: JoinRecord; firstSeen: number }>();
  private wraps = new Map<string, KeyWrap>();
  /** Joins and wraps that didn't verify yet (our record may be behind); retried when membership changes. */
  private pendingJoins = new Map<string, { join: JoinRecord; firstSeen: number }>();
  private pendingWraps = new Map<string, KeyWrap>();
  private sessions = new Set<PeerSession>();
  private seenPresence = new Set<string>();
  private effectiveCache: WorkspaceState | null = null;

  constructor(
    chain: WorkspaceChain,
    readonly deviceId: string,
    readonly events: MeshEvents = {},
    store?: EnvelopeStore,
    readonly now: () => number = Date.now
  ) {
    this.chain = chain;
    this.store = store ?? new EnvelopeStore();
  }

  get workspaceId(): string {
    return this.chain.workspaceId;
  }

  /** The signed record plus valid joins no one has recorded yet: the membership every check uses. */
  effective(): WorkspaceState {
    if (!this.effectiveCache) this.effectiveCache = applyJoins(this.chain.state, this.workspaceId, this.joins.values()).state;
    return this.effectiveCache;
  }

  private membershipChanged(): void {
    // Joins the record now covers, or that turned invalid, are dropped; pending ones get another chance.
    for (const [hash, entry] of [...this.joins, ...this.pendingJoins]) {
      this.joins.delete(hash);
      this.pendingJoins.delete(hash);
      try {
        verifyJoinRecord(this.chain.state, this.workspaceId, entry.join, entry.firstSeen);
        this.joins.set(hash, entry);
      } catch (error) {
        if (error instanceof SecureError && error.code === "join_no_invite") this.pendingJoins.set(hash, entry);
      }
    }
    this.effectiveCache = null;
    for (const [hash, wrap] of this.pendingWraps) {
      if (!verifyKeyWrap(this.effective(), this.workspaceId, wrap)) continue;
      this.pendingWraps.delete(hash);
      this.wraps.set(hash, wrap);
      this.events.wraps?.();
    }
    for (const session of [...this.sessions]) {
      if (session.ready && !activeDevice(this.effective(), session.remoteDevice)) session.close("not_a_member");
      else session.resync();
    }
    this.events.membership?.();
  }

  pendingJoinRecords(): JoinRecord[] {
    return [...this.joins.values()].map((entry) => entry.join);
  }

  /** Joins and when this device first saw them, for saving; `restore` puts them back after a restart. */
  joinEntries(): Array<{ join: JoinRecord; firstSeen: number }> {
    return [...this.joins.values(), ...this.pendingJoins.values()];
  }

  /** Reload saved joins and wraps without passing them on (peers get them at the next sync). */
  restore(joins: Array<{ join: JoinRecord; firstSeen: number }>, wraps: KeyWrap[]): void {
    for (const entry of joins) this.pendingJoins.set(joinHash(entry.join), entry);
    for (const wrap of wraps) this.pendingWraps.set(hashOf("wrap-hash", wrap), wrap);
    this.membershipChanged();
  }

  allWraps(): KeyWrap[] {
    return [...this.wraps.values()];
  }

  // ---- adding things (made here or received) ----

  offerVersions(versions: SignedVersion[], from?: PeerSession): OfferResult {
    const result = this.chain.offer(versions);
    if (result.status === "appended" || result.status === "replaced") {
      this.events.chain?.(result);
      this.broadcast({ t: "versions", versions: this.chain.since(versions[0]!.body.v) }, from);
      this.membershipChanged();
    }
    return result;
  }

  /** True if the join was new and valid. A join for an invite our record doesn't know yet is kept for later. */
  addJoin(join: JoinRecord, from?: PeerSession): boolean {
    const hash = joinHash(join);
    if (this.joins.has(hash) || this.pendingJoins.has(hash)) return false;
    const entry = { join, firstSeen: this.now() };
    try {
      verifyJoinRecord(this.chain.state, this.workspaceId, join, entry.firstSeen);
    } catch (error) {
      if (error instanceof SecureError && error.code === "join_no_invite" && this.pendingJoins.size < MAX_PENDING) this.pendingJoins.set(hash, entry);
      throw error;
    }
    this.joins.set(hash, entry);
    this.broadcast({ t: "joins", joins: [join] }, from);
    this.membershipChanged();
    return true;
  }

  addWrap(wrap: KeyWrap, from?: PeerSession): boolean {
    const hash = hashOf("wrap-hash", wrap);
    if (this.wraps.has(hash) || this.pendingWraps.has(hash)) return false;
    if (!verifyKeyWrap(this.effective(), this.workspaceId, wrap)) {
      if (this.pendingWraps.size < MAX_PENDING) this.pendingWraps.set(hash, wrap);
      return false;
    }
    this.wraps.set(hash, wrap);
    this.events.wraps?.();
    this.broadcast({ t: "wraps", wraps: [wrap] }, from);
    return true;
  }

  /** Store and pass on a room envelope (presence is only passed on). False if invalid or already known. */
  publish(env: Envelope, from?: PeerSession): boolean {
    if (!verifyEnvelope(this.effective(), this.workspaceId, env)) return false;
    if (env.k === "p") {
      const key = `${env.room}/${env.author}/${env.at}/${env.sig}`;
      if (this.seenPresence.has(key)) return false;
      if (this.seenPresence.size >= PRESENCE_MEMORY) this.seenPresence.clear();
      this.seenPresence.add(key);
      this.events.presence?.(env);
      this.broadcast({ t: "push", env }, from);
      return true;
    }
    const result = this.store.add(env);
    if (result === "conflict") this.events.rejected?.("equivocation", env.author);
    if (result !== "added") return false;
    this.events.envelope?.(env);
    this.broadcast({ t: "push", env }, from);
    return true;
  }

  // ---- sessions ----

  /** Start a session over an authenticated channel. `remoteDevice` is the device id the transport proved. */
  connect(channel: Channel, remoteDevice: string): PeerSession {
    const session = new PeerSession(this, channel, remoteDevice);
    this.sessions.add(session);
    session.start();
    this.events.sessions?.();
    return session;
  }

  /** @internal */
  detach(session: PeerSession): void {
    if (this.sessions.delete(session)) this.events.sessions?.();
  }

  connectedDevices(): string[] {
    return [...this.sessions].filter((s) => s.ready).map((s) => s.remoteDevice);
  }

  closeAll(reason: string): void {
    for (const session of [...this.sessions]) session.close(reason);
  }

  private broadcast(message: PeerMessage, except?: PeerSession): void {
    for (const session of this.sessions) if (session !== except && session.ready) session.send(message);
  }

  /** @internal Recent version hashes, for working out where two chains meet. */
  recent(): Recent {
    const head = this.chain.head.body.v;
    const out: Recent = [];
    for (let at = Math.max(0, head - RECENT + 1); at <= head; at++) out.push([at, this.chain.hashAt(at)!]);
    return out;
  }
}

/** One peer, over one channel. The node owns the shared state; the session only speaks the protocol. */
export class PeerSession {
  ready = false;
  private closed = false;

  constructor(
    private readonly node: MeshNode,
    private readonly channel: Channel,
    readonly remoteDevice: string
  ) {}

  /** @internal */
  start(): void {
    // A device that isn't a member yet may only introduce itself with a join record.
    if (activeDevice(this.node.effective(), this.remoteDevice)) this.begin();
  }

  private begin(): void {
    this.ready = true;
    this.send({ t: "hello", ws: this.node.workspaceId, head: this.node.chain.head.body.v, recent: this.node.recent() });
  }

  /** Compare rooms again (envelopes refused earlier may verify now). */
  resync(): void {
    if (this.ready) this.sendDigests();
  }

  send(message: PeerMessage): void {
    if (!this.closed) this.channel.send(message);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.node.detach(this);
    this.channel.close(reason);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private reject(reason: string): void {
    this.node.events.rejected?.(reason, this.remoteDevice);
  }

  /** Feed one message from the channel. Never throws: bad input is reported, and before membership ends the session. */
  receive(raw: unknown): void {
    if (this.closed) return;
    try {
      this.handle(raw);
    } catch (error) {
      this.reject(errorText(error));
      if (!this.ready) this.close("protocol");
    }
  }

  private handle(raw: unknown): void {
    const message = v.obj(raw, "message", ["t", "ws", "head", "recent", "versions", "joins", "wraps", "rooms", "room", "docs", "blobs", "items", "env", "join"]);
    if (!this.ready) {
      if (message.t !== "join") return this.close("not_a_member");
      const join = parseJoinRecord(message.join);
      if (join.body.device.id !== this.remoteDevice) return this.close("join_mismatch");
      this.node.addJoin(join, this);
      if (!activeDevice(this.node.effective(), this.remoteDevice)) return this.close("not_a_member");
      this.begin();
      return;
    }
    switch (message.t) {
      case "hello":
        return this.onHello(message);
      case "versions":
        return this.onVersions(message.versions);
      case "joins":
        return this.each(message.joins, (join) => this.node.addJoin(parseJoinRecord(join), this));
      case "wraps":
        return this.each(message.wraps, (wrap) => this.node.addWrap(parseKeyWrap(wrap), this));
      case "digests":
        return this.onDigests(message.rooms);
      case "room":
        return this.onRoom(message);
      case "envelopes":
        return this.each(message.items, (item) => this.node.publish(parseEnvelope(item), this));
      case "push":
        return this.each([message.env], (item) => this.node.publish(parseEnvelope(item), this));
      case "join":
        return this.each([message.join], (join) => this.node.addJoin(parseJoinRecord(join), this));
      default:
        return this.reject("unknown_message");
    }
  }

  /** Handle each item of a batch; one bad item doesn't spoil the rest. */
  private each(value: unknown, handle: (item: unknown) => unknown): void {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) v.bad("message.items");
    for (const item of value) {
      try {
        handle(item);
      } catch (error) {
        this.reject(errorText(error));
      }
    }
  }

  private onHello(message: Record<string, unknown>): void {
    if (message.ws !== this.node.workspaceId) return this.close("other_workspace");
    const theirHead = v.int(message.head, "hello.head", -1, 1e12);
    if (!Array.isArray(message.recent) || message.recent.length > RECENT) v.bad("hello.recent");
    // The newest version both sides have. If the other side's head isn't ours, send everything after it; a joiner
    // (head -1) gets the whole record from genesis.
    let common = -1;
    let theirHeadHash: string | undefined;
    for (const entry of message.recent as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) v.bad("hello.recent");
      const at = v.int(entry[0], "hello.recent.v", 0, 1e12);
      const hash = v.hash(entry[1], "hello.recent.hash");
      if (at === theirHead) theirHeadHash = hash;
      if (this.node.chain.hashAt(at) === hash) common = Math.max(common, at);
    }
    if (theirHead !== this.node.chain.head.body.v || theirHeadHash !== this.node.chain.headHash) {
      const versions = theirHead === -1 ? this.node.chain.all() : this.node.chain.since(common >= 0 ? common + 1 : 1);
      for (let i = 0; i < versions.length; i += MAX_ITEMS) this.send({ t: "versions", versions: versions.slice(i, i + MAX_ITEMS) });
    }
    const joins = this.node.pendingJoinRecords();
    if (joins.length > 0) this.send({ t: "joins", joins });
    const wraps = this.node.allWraps();
    for (let i = 0; i < wraps.length; i += MAX_ITEMS) this.send({ t: "wraps", wraps: wraps.slice(i, i + MAX_ITEMS) });
    this.sendDigests();
  }

  private onVersions(raw: unknown): void {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) v.bad("versions");
    const versions = raw.map(parseSignedVersion).filter((version) => version.body.v > 0);
    if (versions.length === 0) return;
    const result = this.node.offerVersions(versions, this);
    if (result.status === "rejected" && result.reason !== "loses") this.reject(`versions:${result.reason}`);
  }

  /** Every room of the record that isn't deleted: peers relay rooms they aren't in, as ciphertext. */
  private rooms(): string[] {
    return Object.entries(this.node.effective().rooms)
      .filter(([, room]) => !room.deleted)
      .map(([roomId]) => roomId);
  }

  private sendDigests(): void {
    const rooms: Record<string, string> = {};
    for (const room of this.rooms()) rooms[room] = this.node.store.digest(room);
    this.send({ t: "digests", rooms });
  }

  private onDigests(raw: unknown): void {
    const theirs = v.idMap(raw, "digests", "r", 10_000);
    for (const room of this.rooms()) if (theirs[room] === undefined || theirs[room] !== this.node.store.digest(room)) this.sendRoom(room);
  }

  private sendRoom(room: string): void {
    const docs: Record<string, DocSummary> = {};
    for (const doc of this.node.store.docs(room)) docs[doc] = { vv: this.node.store.vv(room, doc), snaps: this.node.store.snapshotKeys(room, doc) };
    this.send({ t: "room", room, docs, blobs: this.node.store.blobIds(room) });
  }

  /** The other side told us exactly what it holds of a room: send what it lacks. */
  private onRoom(message: Record<string, unknown>): void {
    const room = v.id(message.room, "room.room", "r");
    if (!this.rooms().includes(room)) return;
    const theirs = parseRoomSummary(message.docs);
    if (!Array.isArray(message.blobs) || message.blobs.length > 100_000) v.bad("room.blobs");
    const theirBlobs = new Set(message.blobs.map((id) => v.hash(id, "room.blob")));
    const store = this.node.store;
    const missing: StoredEnvelope[] = [];
    for (const doc of store.docs(room)) {
      const summary = theirs.get(doc) ?? { vv: {}, snaps: [] };
      const sent = new Set<StoredEnvelope>(store.missingFor(room, doc, summary.vv));
      for (const key of store.snapshotKeys(room, doc)) if (!summary.snaps.includes(key)) sent.add(store.snapshotByKey(room, doc, key)!);
      missing.push(...sent);
    }
    for (const id of store.blobIds(room)) if (!theirBlobs.has(id)) missing.push(store.blob(room, id)!);
    // Keep messages a reasonable size.
    let batch: StoredEnvelope[] = [];
    let bytes = 0;
    for (const env of missing) {
      batch.push(env);
      bytes += env.ct.length;
      if (batch.length >= MAX_ITEMS || bytes > MAX_BATCH_BYTES) {
        this.send({ t: "envelopes", items: batch });
        batch = [];
        bytes = 0;
      }
    }
    if (batch.length > 0) this.send({ t: "envelopes", items: batch });
  }
}

function parseRoomSummary(raw: unknown): Map<string, DocSummary> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) v.bad("room.docs");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 100_000) v.bad("room.docs");
  const out = new Map<string, DocSummary>();
  for (const [doc, value] of entries) {
    if (!isDocId(doc)) v.bad("room.docs.id");
    const o = v.obj(value, "room.doc", ["vv", "snaps"]);
    const vv: VersionVector = {};
    for (const [author, clock] of Object.entries(v.idMap(o.vv, "room.vv", "d", 5000))) vv[author] = v.int(clock, "room.vv.clock", 0, Number.MAX_SAFE_INTEGER);
    if (!Array.isArray(o.snaps) || o.snaps.length > 100) v.bad("room.snaps");
    out.set(doc, { vv, snaps: o.snaps.map((key) => v.str(key, "room.snaps.key", 200)) });
  }
  return out;
}

/**
 * A device joining with an invite link has no workspace record yet. It sends its join record, receives the record
 * from genesis, and checks that it is the workspace the link named. Then the caller starts a normal node and
 * session on the same channel.
 */
export class JoinHandshake {
  private versions: SignedVersion[] = [];
  private targetHead = -1;
  private done = false;

  constructor(
    private readonly channel: Channel,
    private readonly workspaceId: string,
    private readonly join: JoinRecord,
    private readonly onChain: (chain: WorkspaceChain) => void,
    private readonly onFail: (reason: string) => void
  ) {}

  start(): void {
    this.channel.send({ t: "join", join: this.join });
  }

  receive(raw: unknown): void {
    if (this.done) return;
    try {
      const message = v.obj(raw, "message", ["t", "ws", "head", "recent", "versions", "joins", "wraps", "rooms", "room", "docs", "blobs", "items", "env", "join"]);
      if (message.t === "hello") {
        if (message.ws !== this.workspaceId) fail("other_workspace");
        this.targetHead = v.int(message.head, "hello.head", 0, 1e12);
        this.channel.send({ t: "hello", ws: this.workspaceId, head: -1, recent: [] });
      } else if (message.t === "versions") {
        if (!Array.isArray(message.versions) || message.versions.length > MAX_ITEMS) v.bad("versions");
        this.versions.push(...message.versions.map(parseSignedVersion));
      }
      if (this.targetHead >= 0 && this.versions.length === this.targetHead + 1) {
        const chain = WorkspaceChain.load(this.versions);
        if (chain.workspaceId !== this.workspaceId) fail("other_workspace");
        this.done = true;
        this.onChain(chain);
      }
    } catch (error) {
      this.done = true;
      this.onFail(errorText(error));
    }
  }
}
