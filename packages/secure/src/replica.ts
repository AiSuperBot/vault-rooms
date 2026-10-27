import * as Y from "yjs";
import { blobKeyOf, envelopeKey, INDEX_DOC, openEnvelope, sealBlob, sealSnapshot, sealUpdate, type DocId, type SnapshotEnvelope, type StoredEnvelope, type UpdateEnvelope } from "./envelope.js";
import { fail, SecureError } from "./errors.js";
import { isHash, isId } from "./ids.js";
import { keyCommitment, unwrapRoomKey, type KeyWrap } from "./keys.js";
import type { KeyPair } from "./crypto.js";
import type { MeshNode } from "./mesh.js";
import { safeRoomPath } from "./paths.js";
import { vvDominates, type BlobMeta, type VersionVector } from "./store.js";
import { activeDevice, liveRoom, roleAtLeast, roleIn } from "./workspace.js";

/**
 * A room as one member device sees it: the keys it holds, the room index and the notes as live Yjs documents,
 * decrypted from the mesh node's envelopes, and local edits turned into signed, encrypted updates.
 *
 * Room index (the INDEX_DOC document): map "files", fileId -> FileEntry. Renames, creations and deletions are edits
 * to this map, so concurrent changes merge. Notes ("md") have their own document (the fileId); other files are
 * whole-file versions in encrypted blobs.
 */

export interface BlobRef {
  /** The device that published the blob (blobs are kept per author). */
  by: string;
  id: string;
  /** Key epoch the blob is encrypted under. */
  n: number;
  size: number;
}

export interface FileEntry {
  path: string;
  kind: "md" | "bin";
  /** Current version of a non-note file. */
  blob?: BlobRef;
  /** The blob id this version replaced, to spot concurrent edits (two versions of the same base). */
  base?: string;
  deleted?: true;
}

/** What became of a local edit: shared, kept until the room key arrives, or refused (and undone). */
export type EditResult = "published" | "queued" | "refused";

export const REMOTE = Symbol("vault-rooms-remote");
const SNAPSHOT_EVERY = 200;

interface DocState {
  doc: Y.Doc;
  /** Updates contained in `doc`, per author (contiguous), so a snapshot never claims more than it holds. */
  applied: VersionVector;
  /** Applied updates beyond a gap, per author. */
  extra: Map<string, Set<number>>;
  sinceSnapshot: number;
}

export interface ReplicaEvents {
  /** The index changed: these file ids were added, changed or removed. */
  index?(fileIds: string[]): void;
  /** A note's text changed because of a remote update. */
  doc?(fileId: string): void;
  /** A local edit made outside `edit` (an editor) couldn't be shared ("read_only", "too_large", ...). */
  localRefused?(docId: string, code: string): void;
}

function validBlobRef(value: unknown): BlobRef | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const ref = value as Record<string, unknown>;
  if (!isId(ref.by, "d") || !isHash(ref.id)) return undefined;
  if (!Number.isSafeInteger(ref.n) || (ref.n as number) < 1 || !Number.isSafeInteger(ref.size) || (ref.size as number) < 0) return undefined;
  return { by: ref.by, id: ref.id, n: ref.n as number, size: ref.size as number };
}

export class RoomReplica {
  private keys = new Map<number, Uint8Array>();
  private docs = new Map<DocId, DocState>();
  private waiting = new Map<string, UpdateEnvelope | SnapshotEnvelope>();
  /** Local edits made while this device lacked the room's newest key; published as soon as it arrives. */
  private unsent = new Map<DocId, Uint8Array[]>();
  /** Our own blobs sealed under a key the record no longer backs, to seal again once the right key is here. */
  private blobRescues: Array<{ oldId: string; bytes: Uint8Array }> = [];
  private localEditAt = new Map<DocId, number>();
  private editing = false;
  private refusal: string | null = null;
  private destroyed = false;

  constructor(
    private readonly node: MeshNode,
    readonly roomId: string,
    private readonly me: { sign: KeyPair; agree: KeyPair },
    private readonly events: ReplicaEvents = {}
  ) {
    this.refreshKeys();
    this.loadDoc(INDEX_DOC);
  }

  // ---- keys ----

  /**
   * Check held keys against the record and unwrap new key wraps addressed to this device. Call whenever the record or
   * the wraps change. Returns true if a new key arrived.
   */
  refreshKeys(wraps: KeyWrap[] = this.node.allWraps()): boolean {
    this.checkKeys();
    let added = false;
    for (const wrap of wraps) {
      const { body } = wrap;
      if (body.room !== this.roomId || body.to !== this.node.deviceId || this.keys.has(body.n)) continue;
      try {
        this.keys.set(body.n, unwrapRoomKey(this.node.effective(), this.node.workspaceId, wrap, this.me.agree));
        added = true;
      } catch {
        // A wrong or stale wrap: ignore it, another member will wrap again.
      }
    }
    if (added) this.keysArrived();
    return added;
  }

  /** A key this device made itself (it created the room or rotated the key); kept only if the record backs it. */
  addOwnKey(n: number, key: Uint8Array): void {
    if (!this.backed(n, key)) return;
    this.keys.set(n, key);
    this.keysArrived();
  }

  private backed(n: number, key: Uint8Array): boolean {
    const epoch = liveRoom(this.node.effective(), this.roomId)?.epochs[n - 1];
    return epoch !== undefined && keyCommitment(this.node.workspaceId, this.roomId, n, key) === epoch.commit;
  }

  /**
   * A key the record no longer backs (our rotation lost a race to someone else's) is dropped, and what we sealed under
   * it, which nobody else can read, is sealed again under the right key.
   */
  private checkKeys(): void {
    if (!liveRoom(this.node.effective(), this.roomId)) return;
    for (const [n, key] of [...this.keys]) {
      if (this.backed(n, key)) continue;
      this.keys.delete(n);
      this.rescue(n, key);
    }
  }

  private rescue(n: number, key: Uint8Array): void {
    const store = this.node.store;
    for (const docId of store.docs(this.roomId)) {
      const { snapshots, updates } = store.envelopesOf(this.roomId, docId);
      for (const env of [...updates, ...snapshots]) {
        if (env.author !== this.node.deviceId || env.n !== n) continue;
        try {
          this.queueUnsent(docId, openEnvelope(env, key));
        } catch {
          // not ours to rescue
        }
      }
    }
    for (const meta of store.blobsOf(this.roomId)) if (meta.author === this.node.deviceId && meta.n === n) void this.rescueBlob(meta, key);
  }

  private async rescueBlob(meta: BlobMeta, key: Uint8Array): Promise<void> {
    const env = await this.node.store.loadBlob(this.roomId, meta.author, meta.id);
    if (!env || this.destroyed) return;
    try {
      this.blobRescues.push({ oldId: meta.id, bytes: openEnvelope(env, key) });
    } catch {
      return;
    }
    this.flushBlobRescues();
  }

  private flushBlobRescues(): void {
    if (this.blobRescues.length === 0 || !this.sealEpoch() || !this.canWrite()) return;
    for (const { oldId, bytes } of this.blobRescues.splice(0)) {
      try {
        const blob = this.putBlob(bytes);
        this.editIndex((files) => {
          for (const [fileId, entry] of files.entries()) if (entry.blob?.by === this.node.deviceId && entry.blob.id === oldId) files.set(fileId, { ...entry, blob, base: oldId });
        });
      } catch {
        // too large or refused now: nothing more to do
      }
    }
  }

  private keysArrived(): void {
    this.retryWaiting();
    this.flushUnsent();
    this.flushBlobRescues();
  }

  keyFor(n: number): Uint8Array | undefined {
    return this.keys.get(n);
  }

  /** The key new content is sealed under: the room's newest epoch, if this device has it (never an older one). */
  sealEpoch(): { n: number; key: Uint8Array } | null {
    const n = liveRoom(this.node.effective(), this.roomId)?.epochs.length ?? 0;
    const key = this.keys.get(n);
    return key ? { n, key } : null;
  }

  epochsMissing(): number[] {
    const room = liveRoom(this.node.effective(), this.roomId);
    return (room?.epochs ?? []).map((e) => e.n).filter((n) => !this.keys.has(n));
  }

  // ---- reading ----

  get index(): Y.Map<FileEntry> {
    return this.loadDoc(INDEX_DOC).doc.getMap<FileEntry>("files");
  }

  /** Index entries with a safe path, deleted ones included (marked). Entries whose path fails the check are left out. */
  entries(): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();
    for (const [fileId, entry] of this.index.entries()) {
      if (!isId(fileId, "f") || typeof entry !== "object" || entry === null) continue;
      const path = safeRoomPath(entry.path);
      if (path === null || (entry.kind !== "md" && entry.kind !== "bin")) continue;
      const blob = entry.kind === "bin" ? validBlobRef(entry.blob) : undefined;
      out.set(fileId, {
        path,
        kind: entry.kind,
        ...(blob ? { blob } : {}),
        ...(isHash(entry.base) ? { base: entry.base } : {}),
        ...(entry.deleted === true ? { deleted: true as const } : {})
      });
    }
    return out;
  }

  /** Live index entries with a safe path. */
  files(): Map<string, FileEntry> {
    const out = new Map<string, FileEntry>();
    for (const [fileId, entry] of this.entries()) if (!entry.deleted) out.set(fileId, entry);
    return out;
  }

  /** The note document for a file (loaded and decrypted on first use). */
  noteDoc(fileId: string): Y.Doc {
    return this.loadDoc(fileId).doc;
  }

  noteText(fileId: string): string {
    return this.noteDoc(fileId).getText("content").toString();
  }

  /** Whether everything held for a document has been decrypted into it (nothing waits for a key). */
  isComplete(docId: DocId): boolean {
    this.loadDoc(docId);
    for (const env of this.waiting.values()) if (env.doc === docId) return false;
    return true;
  }

  /** Whether local edits of a document are waiting for the room's newest key. */
  hasUnsent(docId: DocId): boolean {
    return this.unsent.has(docId);
  }

  /** Whether something this device made isn't safely stored yet: any edit of these documents, or these envelopes (by key). */
  hasUnstored(docs: DocId[], keys: string[] = []): boolean {
    return docs.some((doc) => this.node.hasUnpersisted(`${this.roomId}/${doc}/`)) || keys.some((key) => this.node.isUnpersisted(key));
  }

  /** Key (see envelopeKey) of this device's latest update of a document, to check later whether it is stored. */
  ownUpdateKey(docId: DocId): string | null {
    const clock = this.node.store.maxClock(this.roomId, docId, this.node.deviceId);
    return clock > 0 ? envelopeKey({ k: "u", room: this.roomId, doc: docId, author: this.node.deviceId, clock } as StoredEnvelope) : null;
  }

  /** Key (see envelopeKey) of a blob this device made. */
  ownBlobKey(blobId: string): string {
    return envelopeKey({ k: "b", room: this.roomId, author: this.node.deviceId, id: blobId } as StoredEnvelope);
  }

  /** Resolves once what this device is storing right now is stored (or failed to be, this time). */
  stored(): Promise<void> {
    return this.node.stored();
  }

  /** Destroyed (the owner let go of the room): nothing can be read or changed through it any more. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** This device. */
  get deviceId(): string {
    return this.node.deviceId;
  }

  /** A blob's plaintext, if its ciphertext is held here and its key is known. */
  async readBlob(ref: BlobRef): Promise<Uint8Array | null> {
    const key = this.keys.get(ref.n);
    if (!key) return null;
    const env = await this.node.store.loadBlob(this.roomId, ref.by, ref.id);
    if (!env || env.n !== ref.n) return null;
    try {
      return openEnvelope(env, key);
    } catch {
      return null;
    }
  }

  role() {
    const device = activeDevice(this.node.effective(), this.node.deviceId);
    return device ? roleIn(this.node.effective(), this.roomId, device.user) : undefined;
  }

  canWrite(): boolean {
    return roleAtLeast(this.role(), "write");
  }

  // ---- incoming ----

  private loadDoc(docId: DocId): DocState {
    let state = this.docs.get(docId);
    if (state) return state;
    const store = this.node.store;
    const doc = new Y.Doc({ gc: true });
    // Marks: updates folded into a snapshot this device checked (and applied, below).
    state = { doc, applied: { ...store.marksOf(this.roomId, docId).marks }, extra: new Map(), sinceSnapshot: 0 };
    this.docs.set(docId, state);
    const { snapshots, updates } = store.envelopesOf(this.roomId, docId);
    for (const env of [...snapshots, ...updates]) this.applyEnvelope(state, docId, env);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) this.localUpdate(docId, update);
    });
    if (updates.some((u) => snapshots.some((s) => u.clock <= (s.covers[u.author] ?? 0)))) this.compact(docId);
    return state;
  }

  /** When this device last changed a document (ms), to tell a note being worked on here from one left alone. */
  lastLocalEdit(docId: DocId): number {
    return this.localEditAt.get(docId) ?? 0;
  }

  private localUpdate(docId: DocId, update: Uint8Array): void {
    this.localEditAt.set(docId, Date.now());
    try {
      this.publishLocal(docId, update);
    } catch (error) {
      const code = error instanceof SecureError ? error.code : "error";
      // No key yet: keep the edit and send it once the key arrives, so local and shared state can't drift apart.
      if (code === "no_room_key") return this.queueUnsent(docId, update);
      this.refusal = code;
      if (!this.editing) this.events.localRefused?.(docId, code);
    }
  }

  /**
   * Make a local edit to a document as one transaction. "refused": it couldn't be shared (read only, too large, over
   * the room's storage limit), and the document was rebuilt without it.
   */
  edit(docId: DocId, change: (doc: Y.Doc) => void): EditResult {
    if (this.destroyed) fail("destroyed");
    const state = this.loadDoc(docId);
    this.refusal = null;
    this.editing = true;
    try {
      state.doc.transact(() => change(state.doc));
    } finally {
      this.editing = false;
    }
    if (this.refusal !== null) {
      this.reload(docId);
      return "refused";
    }
    return this.unsent.has(docId) ? "queued" : "published";
  }

  /** Throw away local state of a document and rebuild it from the stored envelopes (undoes a refused local edit). */
  reload(docId: DocId): Y.Doc {
    this.docs.get(docId)?.doc.destroy();
    this.docs.delete(docId);
    this.unsent.delete(docId);
    return this.loadDoc(docId).doc;
  }

  /** Called by the owner for every new envelope the node stored. */
  receive(env: StoredEnvelope): void {
    if (this.destroyed || env.room !== this.roomId || env.k === "b") return;
    const state = this.docs.get(env.doc);
    // Notes not loaded yet are decrypted when they are first opened; only tell the owner something changed.
    if (!state) {
      this.events.doc?.(env.doc);
      return;
    }
    if (this.applyEnvelope(state, env.doc, env)) this.changed(env.doc, state);
    if (env.k === "s") this.compact(env.doc);
  }

  private changed(docId: DocId, state: DocState): void {
    if (docId === INDEX_DOC) this.events.index?.([...state.doc.getMap("files").keys()]);
    else this.events.doc?.(docId);
  }

  /** Decrypt and merge one envelope. Returns true if it changed the document. */
  private applyEnvelope(state: DocState, docId: DocId, env: UpdateEnvelope | SnapshotEnvelope): boolean {
    const key = this.keys.get(env.n);
    if (!key) {
      this.waiting.set(`${env.k}/${docId}/${env.author}/${env.k === "u" ? env.clock : env.seq}`, env);
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = openEnvelope(env, key);
    } catch {
      return false; // can't be decrypted with the committed key: ignore
    }
    const before = Y.encodeStateVector(state.doc);
    try {
      Y.applyUpdate(state.doc, bytes, REMOTE);
    } catch {
      return false; // not a valid Yjs update: ignore it rather than corrupt the document
    }
    // A snapshot's "covers" is only its author's claim: it never counts as applied updates here.
    if (env.k === "u") this.markApplied(state, env.author, env.clock);
    state.sinceSnapshot++;
    const after = Y.encodeStateVector(state.doc);
    return before.length !== after.length || before.some((byte, i) => byte !== after[i]);
  }

  /** Record that update `clock` of `author` is in the document (`upTo`: every update up to it is). */
  private markApplied(state: DocState, author: string, clock: number, upTo = false): void {
    const current = state.applied[author] ?? 0;
    if (clock === current + 1 || (upTo && clock > current)) state.applied[author] = clock;
    else if (clock > current) {
      let extra = state.extra.get(author);
      if (!extra) state.extra.set(author, (extra = new Set()));
      extra.add(clock);
    }
    const extra = state.extra.get(author);
    while (extra?.has((state.applied[author] ?? 0) + 1)) {
      const next = (state.applied[author] ?? 0) + 1;
      extra.delete(next);
      state.applied[author] = next;
    }
  }

  private retryWaiting(): void {
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    const touched = new Set<DocId>();
    for (const env of waiting) {
      const state = this.docs.get(env.doc);
      if (!state) continue;
      if (this.applyEnvelope(state, env.doc, env)) touched.add(env.doc);
    }
    for (const docId of touched) this.changed(docId, this.docs.get(docId)!);
  }

  private queueUnsent(docId: DocId, update: Uint8Array): void {
    this.unsent.set(docId, [...(this.unsent.get(docId) ?? []), update]);
  }

  private flushUnsent(): void {
    if (!this.sealEpoch()) return;
    for (const [docId, updates] of [...this.unsent]) {
      this.unsent.delete(docId);
      const merged = Y.mergeUpdates(updates);
      // Content taken back from the store may be missing from a document rebuilt since: put it in (a no-op otherwise).
      const state = this.loadDoc(docId);
      try {
        Y.applyUpdate(state.doc, merged, REMOTE);
        this.publishLocal(docId, merged);
      } catch (error) {
        this.events.localRefused?.(docId, error instanceof SecureError ? error.code : "error");
      }
    }
  }

  // ---- compaction ----

  /** The Yjs snapshot (state vector and deletions) of a held snapshot envelope, or null if it can't be read. */
  private contentsOf(snapshot: SnapshotEnvelope): Y.Snapshot | null {
    const key = this.keys.get(snapshot.n);
    if (!key) return null;
    const probe = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(probe, openEnvelope(snapshot, key));
      return Y.snapshot(probe);
    } catch {
      return null;
    } finally {
      probe.destroy();
    }
  }

  /**
   * Drop what a held snapshot provably contains. Each envelope a snapshot claims to cover is decrypted and checked
   * against the snapshot's own state; whatever isn't really in it stays. So a snapshot that lies about what it covers
   * can't take anything away from this device.
   */
  private compact(docId: DocId): void {
    if (!this.isComplete(docId)) return;
    const store = this.node.store;
    const { snapshots, updates } = store.envelopesOf(this.roomId, docId);
    if (snapshots.length === 0) return;
    const held = store.vv(this.roomId, docId);
    const remove = new Set<StoredEnvelope>();
    const marks: VersionVector = {};
    const reach = (s: SnapshotEnvelope) => Object.values(s.covers).reduce((sum, clock) => sum + clock, 0);
    const ordered = [...snapshots].sort((a, b) => reach(b) - reach(a) || (envelopeKey(a) < envelopeKey(b) ? -1 : 1));
    for (const snapshot of ordered) {
      if (remove.has(snapshot)) continue;
      const contents = this.contentsOf(snapshot);
      if (!contents) continue;
      const contains = (env: StoredEnvelope): boolean => {
        const key = this.keys.get(env.n);
        if (!key) return false;
        try {
          return Y.snapshotContainsUpdate(contents, openEnvelope(env, key));
        } catch {
          return false;
        }
      };
      for (const update of updates) {
        if (remove.has(update) || update.clock > (snapshot.covers[update.author] ?? 0) || update.clock > (held[update.author] ?? 0)) continue;
        if (!contains(update)) continue;
        remove.add(update);
        marks[update.author] = held[update.author]!;
      }
      for (const other of snapshots) if (other !== snapshot && !remove.has(other) && vvDominates(snapshot.covers, other.covers) && contains(other)) remove.add(other);
    }
    if (remove.size === 0) return;
    store.compact(this.roomId, docId, [...remove], marks);
    // Everything up to each mark is in the checked snapshot, which is in this document.
    const state = this.docs.get(docId);
    if (state) for (const [author, clock] of Object.entries(marks)) this.markApplied(state, author, clock, true);
  }

  // ---- outgoing ----

  private sealContext() {
    const epoch = this.sealEpoch();
    if (!epoch) fail("no_room_key");
    return { ws: this.node.workspaceId, room: this.roomId, n: epoch.n, key: epoch.key, author: this.me.sign };
  }

  private publishLocal(docId: DocId, update: Uint8Array): void {
    if (this.destroyed) return;
    if (!this.canWrite()) fail("read_only");
    const ctx = this.sealContext();
    const clock = this.node.store.maxClock(this.roomId, docId, this.node.deviceId) + 1;
    const env = sealUpdate(ctx, docId, clock, update);
    if (!this.node.publish(env)) fail("publish_refused");
    const state = this.docs.get(docId)!;
    this.markApplied(state, this.node.deviceId, clock);
    if (++state.sinceSnapshot >= SNAPSHOT_EVERY) this.snapshot(docId);
  }

  /** Change the index (create, rename, delete) as one local transaction. */
  editIndex(change: (files: Y.Map<FileEntry>) => void): EditResult {
    if (this.destroyed) fail("destroyed");
    if (!this.canWrite()) fail("read_only");
    return this.edit(INDEX_DOC, (doc) => change(doc.getMap<FileEntry>("files")));
  }

  /** Encrypt and publish a file version; returns the reference to put in the index. Throws "no_room_key" without the newest key. */
  putBlob(bytes: Uint8Array): BlobRef {
    if (this.destroyed) fail("destroyed");
    if (!this.canWrite()) fail("read_only");
    const ctx = this.sealContext();
    const env = sealBlob(ctx, bytes);
    if (!this.node.store.blob(this.roomId, this.node.deviceId, env.id)) {
      // The same file added back after its blob was cleaned up here: it is wanted again.
      this.node.store.undrop(this.roomId, blobKeyOf(this.node.deviceId, env.id));
      if (!this.node.publish(env)) fail("publish_refused");
    }
    return { by: this.node.deviceId, id: env.id, n: ctx.n, size: bytes.length };
  }

  /**
   * Compact a document: publish its full state, covering exactly the updates applied here. Skipped while Yjs still
   * holds updates whose dependencies haven't arrived, so a snapshot never drops anything.
   */
  snapshot(docId: DocId): SnapshotEnvelope | null {
    const state = this.docs.get(docId);
    if (!state || !this.canWrite() || !this.sealEpoch()) return null;
    const store = state.doc.store as unknown as { pendingStructs: unknown; pendingDs: unknown };
    if (store.pendingStructs || store.pendingDs) return null;
    if (Object.keys(state.applied).length === 0) return null;
    const seq = this.node.store.maxSnapshotSeq(this.roomId, docId, this.node.deviceId) + 1;
    let env: SnapshotEnvelope;
    try {
      env = sealSnapshot(this.sealContext(), docId, seq, { ...state.applied }, Y.encodeStateAsUpdate(state.doc));
    } catch {
      return null; // too large to snapshot: the updates stay
    }
    state.sinceSnapshot = 0;
    if (!this.node.publish(env)) return null;
    this.compact(docId);
    return env;
  }

  destroy(): void {
    this.destroyed = true;
    for (const state of this.docs.values()) state.doc.destroy();
    this.docs.clear();
  }
}
