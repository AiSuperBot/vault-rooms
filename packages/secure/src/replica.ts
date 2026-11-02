import * as Y from "yjs";
import { blobKeyOf, envelopeKey, INDEX_DOC, openEnvelope, sealBlob, sealSnapshot, sealUpdate, type DocId, type SnapshotEnvelope, type StoredEnvelope, type UpdateEnvelope } from "./envelope.js";
import { fail, SecureError } from "./errors.js";
import { Clashes, type FileSave, type Line } from "./clashes.js";
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
/** A writer that isn't the first to pass on a former writer's work steps in after this long (ms) if it is still there. */
const PASS_ON_STEP_IN_MS = 10 * 60_000;

interface DocState {
  doc: Y.Doc;
  pending: Map<string, { env: UpdateEnvelope | SnapshotEnvelope; bytes: Uint8Array; needs: Map<number, number> }>;
  /** Updates contained in `doc`, per author (contiguous), so a snapshot never claims more than it holds. */
  applied: VersionVector;
  /** Applied updates beyond a gap, per author. */
  extra: Map<string, Set<number>>;
  sinceSnapshot: number;
  /** The size of the newest snapshot seen of it: a large note is snapshotted less often (see publishLocal). */
  snapshotBytes: number;
  /** The store's count of envelopes added to it when it was loaded, and those taken in since (see syncedKey). */
  base: number;
  received: number;
  /**
   * Envelopes that couldn't be decrypted with the key held for their epoch (a key that lost a race to another, say):
   * tried again whenever keys arrive. While any is here the text may lack what they hold (see syncedKey).
   */
  undecryptable: Map<string, UpdateEnvelope | SnapshotEnvelope>;
}

export interface ReplicaEvents {
  /** The index changed: these file ids were added, changed or removed. */
  index?(fileIds: string[]): void;
  /** A note's text changed because of a remote update. */
  doc?(fileId: string): void;
  /** A local edit made outside `edit` (an editor) couldn't be shared ("read_only", "too_large", ...). */
  localRefused?(docId: string, code: string): void;
  /**
   * A whole-note save made here (see `edit`, `save`) and someone else's, made at the same moment, replaced the same line
   * (two values written over one, say), and the other's is kept in the shared note; or text typed here went into a line
   * such a save replaced. `version`: the note as this computer had it, for the owner to keep as a copy. What gave way is
   * taken out only once the copy is kept: return true if it is kept now, or false and call copyKept once it is (it may
   * be asked again meanwhile, and again after retryTakeOuts, as when the room's folder is back).
   */
  clash?(docId: string, version: string): boolean | void;
}

/** Whether Yjs holds updates of a document whose dependencies haven't arrived (a snapshot then would miss them). */
function waitsForDependencies(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null;
}

/**
 * What an update needs the document to hold before it goes in whole (Yjs would apply part of it, and an editor could
 * show a deletion without its insertion): per client, the clock the document's state must reach. Worked out once per
 * update; whether it is met is then a lookup per client (see ready).
 */
function dependencyNeeds(bytes: Uint8Array): Map<number, number> {
  const { structs, ds } = Y.decodeUpdate(bytes);
  const needs = new Map<number, number>();
  const need = (client: number, clock: number) => {
    if (clock > (needs.get(client) ?? 0)) needs.set(client, clock);
  };
  // Its own structs, per client: a run starting past what came before it in the update needs the document to reach it.
  const ends = new Map<number, number>();
  for (const struct of structs) {
    if (struct instanceof Y.Skip) continue;
    const { client, clock } = struct.id;
    const end = ends.get(client);
    if (end === undefined || clock > end) need(client, clock);
    ends.set(client, Math.max(end ?? 0, clock + struct.length));
  }
  const own = (client: number) => ends.get(client) ?? 0;
  // What its items are tied to, and what it deletes, unless the update holds that itself.
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    for (const ref of [struct.origin, struct.rightOrigin, struct.parent]) if (ref instanceof Y.ID && ref.clock >= own(ref.client)) need(ref.client, ref.clock + 1);
  }
  for (const [client, ranges] of ds.clients) for (const { clock, len } of ranges) if (clock + len > own(client)) need(client, clock + len);
  return needs;
}

function ready(doc: Y.Doc, needs: Map<number, number>): boolean {
  for (const [client, clock] of needs) if (Y.getState(doc.store, client) < clock) return false;
  return true;
}

/**
 * Clash handling (see Clashes) that can't be worked out leaves the note as it is (both lines stay): it never stops an
 * edit being shared, an update going in or a note loading.
 */
function quietly<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
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
  /** See docVersion. */
  private changes = new Map<DocId, number>();
  private waiting = new Map<string, UpdateEnvelope | SnapshotEnvelope>();
  /** The documents with something in `waiting` (it is only ever emptied whole). */
  private waitingDocs = new Set<DocId>();
  /** When each loaded document was last used (see releaseIdle). */
  private lastUsed = new Map<DocId, number>();
  /** This device's newest snapshot and what it holds (see snapshot): known without decrypting it. */
  private sealed: { env: SnapshotEnvelope; contents: Y.Snapshot } | null = null;
  /** See indexNow. */
  private indexCache: { version: number; entries: ReadonlyMap<string, FileEntry>; files: ReadonlyMap<string, FileEntry> } | null = null;
  /** Local edits made while this device lacked the room's newest key; published as soon as it arrives. */
  private unsent = new Map<DocId, Uint8Array[]>();
  /** Our own blobs sealed under a key the record no longer backs, to seal again once the right key is here. */
  private blobRescues: Array<{ oldId: string; bytes: Uint8Array }> = [];
  private localEditAt = new Map<DocId, number>();
  private editing = false;
  /** The edit under way is a whole-note save (see `edit`), and the note's lines before it (to tell lines it moves). */
  private saving = false;
  private linesBefore: Line[] | undefined;
  /** Saves of notes made here outside the editor, and what they clash with (see ReplicaEvents.clash). */
  private readonly clashes: Clashes;
  /** Documents this device passed on, with the work of former writers it covered then (see passOnOldWork). */
  private passedOn = new Map<DocId, Set<string>>();
  /** Former writers' file versions being passed on, one after another (see passOnOldWork). */
  private passingOn: Promise<void> | null = null;
  /** Former writers' work, by document or file version: when it was first seen here (see passOnOldWork). */
  private oldSince = new Map<string, number>();
  /** Documents and file versions that couldn't be passed on (too large, no room left): not tried again in this session. */
  private cantPassOn = new Set<string>();
  private refusal: string | null = null;
  private destroyed = false;

  constructor(
    private readonly node: MeshNode,
    readonly roomId: string,
    private readonly me: { sign: KeyPair; agree: KeyPair },
    private readonly events: ReplicaEvents = {}
  ) {
    this.clashes = new Clashes({
      deviceId: node.deviceId,
      text: (docId) => this.docs.get(docId)?.doc.getText("content"),
      heldUpdates: (docId) => this.heldUpdates(docId),
      mayEdit: () => !this.destroyed && this.canWrite(),
      edit: (docId, change) => this.edit(docId, change),
      clash: (docId, version) => this.events.clash?.(docId, version)
    });
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
    const env = await this.node.store.loadBlob(this.roomId, meta.author, meta.id).catch(() => null);
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
  entries(): ReadonlyMap<string, FileEntry> {
    return this.indexNow().entries;
  }

  /** The index checked once per change of it (callers only read; a room can hold tens of thousands of files). */
  private indexNow(): { entries: ReadonlyMap<string, FileEntry>; files: ReadonlyMap<string, FileEntry> } {
    const version = this.docVersion(INDEX_DOC);
    if (this.indexCache?.version === version) return this.indexCache;
    const entries = new Map<string, FileEntry>();
    const files = new Map<string, FileEntry>();
    for (const fileId of this.index.keys()) {
      const entry = this.entry(fileId);
      if (!entry) continue;
      // Shared by every caller until the index changes: frozen, so none can change it for the others.
      if (entry.blob) Object.freeze(entry.blob);
      entries.set(fileId, Object.freeze(entry));
      if (!entry.deleted) files.set(fileId, entry);
    }
    this.indexCache = { version, entries, files };
    return this.indexCache;
  }

  /** One validated index entry, without rebuilding the whole index. Deleted entries are included. */
  entry(fileId: string): FileEntry | undefined {
    const entry = this.index.get(fileId);
    if (!isId(fileId, "f") || typeof entry !== "object" || entry === null) return;
    const path = safeRoomPath(entry.path);
    if (path === null || (entry.kind !== "md" && entry.kind !== "bin")) return;
    const blob = entry.kind === "bin" ? validBlobRef(entry.blob) : undefined;
    return { path, kind: entry.kind, ...(blob ? { blob } : {}), ...(isHash(entry.base) ? { base: entry.base } : {}), ...(entry.deleted === true ? { deleted: true as const } : {}) };
  }

  /**
   * What is held of a note, as a short fingerprint (see EnvelopeStore.fingerprint), without loading it: the same, and
   * nothing of ours waiting to be sent, means the same text as when it was taken.
   */
  contentKey(docId: DocId): string {
    return this.node.store.fingerprint(this.roomId, docId);
  }

  /**
   * The content key of a note whose text now is exactly what its held envelopes make: loaded, every envelope the store
   * added since taken in, none waiting for a key or for what it builds on. Otherwise undefined (its text may lag).
   */
  syncedKey(docId: DocId): string | undefined {
    const state = this.docs.get(docId);
    if (!state || state.pending.size > 0 || state.undecryptable.size > 0 || this.waitingDocs.has(docId) || this.unsent.has(docId) || this.clashes.busy(docId)) return undefined;
    if (state.base + state.received !== this.node.store.addsOf(this.roomId, docId)) return undefined;
    return this.contentKey(docId);
  }

  /**
   * Let go of notes not used for `idleMs` (memory: a room can hold tens of thousands): each is loaded again from the
   * store when next needed. Not a note `keep` says is in use (open in an editor), nor one with anything held only in
   * memory: updates waiting for what they build on or for a key, edits waiting to be sent, a clash being worked out.
   */
  releaseIdle(idleMs: number, keep: (docId: DocId) => boolean): void {
    if (this.passingOn) return;
    const now = Date.now();
    for (const [docId, state] of [...this.docs]) {
      if (docId === INDEX_DOC || now - (this.lastUsed.get(docId) ?? 0) < idleMs) continue;
      if (state.pending.size > 0 || this.unsent.has(docId) || this.waitingDocs.has(docId) || this.clashes.busy(docId) || keep(docId)) continue;
      state.doc.destroy();
      this.docs.delete(docId);
      this.lastUsed.delete(docId);
    }
  }

  /** Changes whenever a document may have (local or remote, deletions included, or rebuilt): a key for caches of it. */
  docVersion(docId: DocId): number {
    this.loadDoc(docId);
    return this.changes.get(docId) ?? 0;
  }

  /** Live index entries with a safe path. */
  files(): ReadonlyMap<string, FileEntry> {
    return this.indexNow().files;
  }

  /** The note document for a file (loaded and decrypted on first use). */
  noteDoc(fileId: string): Y.Doc {
    return this.loadDoc(fileId).doc;
  }

  noteText(fileId: string): string {
    return this.noteDoc(fileId).getText("content").toString();
  }

  /**
   * Nothing waits for a key or a disk read, and no update is half applied. Updates waiting for their Yjs dependencies
   * (see DocState.pending) are held whole, so what is applied is whole edits only: safe to write, bind and merge with.
   */
  isComplete(docId: DocId): boolean {
    if (this.node.store.isUnreadable(this.roomId, docId)) return false;
    if (waitsForDependencies(this.loadDoc(docId).doc)) return false;
    if (this.waitingDocs.has(docId)) return false;
    return true;
  }

  /** Whether part of a document waits for a room key this device doesn't have (yet). */
  waitsForKey(docId: DocId): boolean {
    return this.waitingDocs.has(docId) || (this.docs.get(docId)?.undecryptable.size ?? 0) > 0;
  }

  /** Whether local edits of a document are waiting for the room's newest key. */
  hasUnsent(docId: DocId): boolean {
    return this.unsent.has(docId);
  }

  /** Whether something this device made isn't safely stored yet: any edit of these documents, or these envelopes (by key). */
  hasUnstored(docs: DocId[], keys: string[] = []): boolean {
    return docs.some((doc) => this.node.hasUnpersisted(`${this.roomId}/${doc}/`)) || keys.some((key) => this.node.isUnpersisted(key));
  }

  /** Whether something received for these documents isn't safely stored here yet. */
  hasUnstoredReceived(docs: DocId[]): boolean {
    return docs.some((doc) => this.node.hasUnstoredReceived(`${this.roomId}/${doc}/`));
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
    // Not here yet (its arrival wakes the folder), or damaged (loadBlob dropped it and asked the peers again).
    if (!env || env.n !== ref.n) return null;
    try {
      return openEnvelope(env, key);
    } catch {
      this.node.store.invalidateBlob(this.roomId, ref.by, ref.id);
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
    this.lastUsed.set(docId, Date.now());
    let state = this.docs.get(docId);
    if (state) return state;
    const store = this.node.store;
    const doc = new Y.Doc({ gc: true });
    // Marks: updates folded into a snapshot this device checked (and applied, below).
    state = { doc, pending: new Map(), applied: { ...store.marksOf(this.roomId, docId).marks }, extra: new Map(), sinceSnapshot: 0, snapshotBytes: 0, base: store.addsOf(this.roomId, docId), received: 0, undecryptable: new Map() };
    this.docs.set(docId, state);
    const { snapshots, updates } = store.envelopesOf(this.roomId, docId);
    const checks: Array<[UpdateEnvelope | SnapshotEnvelope, Uint8Array]> = [];
    for (const env of [...snapshots, ...updates]) this.applyEnvelope(state, docId, env, checks);
    for (const snapshot of snapshots) state.snapshotBytes = Math.max(state.snapshotBytes, snapshot.ct.length);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.changes.set(docId, (this.changes.get(docId) ?? 0) + 1);
      if (origin !== REMOTE) this.localUpdate(docId, update);
    });
    this.changes.set(docId, (this.changes.get(docId) ?? 0) + 1);
    if (updates.some((u) => snapshots.some((s) => u.clock <= (s.covers[u.author] ?? 0)))) this.compact(docId);
    // Clashes are looked for once the whole note is in (this computer's own saves too), and settled before it is read.
    for (const [env, bytes] of checks) quietly(() => this.clashes.check(docId, env, bytes));
    quietly(() => this.clashes.settle(docId));
    return this.docs.get(docId) ?? state;
  }

  /** When this device last changed a document (ms), to tell a note being worked on here from one left alone. */
  lastLocalEdit(docId: DocId): number {
    return this.localEditAt.get(docId) ?? 0;
  }

  private localUpdate(docId: DocId, update: Uint8Array): void {
    // Taking out what lost a clash is no work on the note here (see lastLocalEdit).
    if (!this.clashes.takingOut) this.localEditAt.set(docId, Date.now());
    quietly(() => this.clashes.recordLocal(docId, update, this.saving, this.linesBefore));
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
   * the room's storage limit), and the document was rebuilt without it. `save`: it is a whole-note save made outside an
   * editor (a file written by another program or plugin), which may clash with someone else's (see ReplicaEvents.clash).
   */
  edit(docId: DocId, change: (doc: Y.Doc) => void, save = false): EditResult {
    if (this.destroyed) fail("destroyed");
    const state = this.loadDoc(docId);
    this.refusal = null;
    this.editing = true;
    this.saving = save;
    this.linesBefore = save ? quietly(() => this.clashes.linesBefore(docId)) : undefined;
    try {
      state.doc.transact(() => change(state.doc));
    } finally {
      this.editing = false;
      this.saving = false;
      this.linesBefore = undefined;
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
    if (state) {
      this.lastUsed.set(env.doc, Date.now());
      state.received++;
    }
    // Notes not loaded yet are decrypted when they are first opened; only tell the owner something changed.
    if (!state) {
      this.events.doc?.(env.doc);
      return;
    }
    // Our own new snapshot coming back as it is stored: the note holds it already (it was made from it just now).
    if (env !== this.sealed?.env && this.applyEnvelope(state, env.doc, env)) this.changed(env.doc, state);
    if (env.k === "s") {
      // A writer's snapshot does the job of ours: one per note, not one per person typing in it.
      if (this.writes(env.author)) {
        state.sinceSnapshot = 0;
        state.snapshotBytes = env.ct.length;
      }
      this.compact(env.doc);
    }
  }

  private changed(docId: DocId, state: DocState): void {
    if (docId === INDEX_DOC) this.events.index?.([...state.doc.getMap("files").keys()]);
    else this.events.doc?.(docId);
  }

  /** Decrypt and merge one envelope. Returns true if it changed the document. `checks`: clashes are looked for later. */
  private applyEnvelope(state: DocState, docId: DocId, env: UpdateEnvelope | SnapshotEnvelope, checks?: Array<[UpdateEnvelope | SnapshotEnvelope, Uint8Array]>): boolean {
    const key = this.keys.get(env.n);
    if (!key) {
      this.waiting.set(`${env.k}/${docId}/${env.author}/${env.k === "u" ? env.clock : env.seq}`, env);
      this.waitingDocs.add(docId);
      return false;
    }
    let bytes: Uint8Array;
    try {
      bytes = openEnvelope(env, key);
    } catch {
      // Not with the key held now: tried again when keys change (ours may have lost a race, see checkKeys).
      state.undecryptable.set(envelopeKey(env), env);
      return false;
    }
    try {
      // Held whole until what it builds on is in (Yjs would apply part of it). Only what depends on a missing update
      // waits: anything else goes in at once.
      // shortcut: held updates stay in memory only (their envelopes are stored), bound them if a room ever piles them up.
      const needs = dependencyNeeds(bytes);
      if (!ready(state.doc, needs)) {
        state.pending.set(envelopeKey(env), { env, bytes, needs });
        return false;
      }
      const before = Y.encodeStateVector(state.doc);
      type Held = { env: UpdateEnvelope | SnapshotEnvelope; bytes: Uint8Array };
      const applied: Array<Held & { typed: ReturnType<Clashes["typedClash"]> | null | undefined }> = [];
      // One transaction: an editor sees the held updates arrive together with what they waited for.
      state.doc.transact(() => {
        let next: Held | undefined = { env, bytes };
        while (next) {
          const item: Held = next;
          applied.push({ ...item, typed: checks ? null : quietly(() => this.clashes.typedClash(docId, item.env, item.bytes)) });
          Y.applyUpdate(state.doc, item.bytes, REMOTE);
          next = undefined;
          for (const [key, held] of state.pending) {
            if (!ready(state.doc, held.needs)) continue;
            state.pending.delete(key);
            next = held;
            break;
          }
        }
      }, REMOTE);
      // Clash removals stay outside the remote transaction so they are published as local edits.
      for (const item of applied) {
        if (item.typed) quietly(() => this.clashes.takeOutTyped(docId, item.typed!));
        if (this.clashes.hasSaves(docId)) {
          if (checks) checks.push([item.env, item.bytes]);
          else quietly(() => this.clashes.check(docId, item.env, item.bytes, Y.decodeStateVector(before)));
        }
        // A snapshot's "covers" is only its author's claim: it never counts as applied updates here.
        if (item.env.k === "u") this.markApplied(state, item.env.author, item.env.clock);
      }
      const after = Y.encodeStateVector(state.doc);
      const changed = before.length !== after.length || before.some((byte, i) => byte !== after[i]);
      // Our own edits come back here once stored: already counted when made (see publishLocal).
      if (changed) state.sinceSnapshot += applied.length;
      return changed;
    } catch {
      return false; // not a valid Yjs update
    }
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
    this.waitingDocs.clear();
    const touched = new Set<DocId>();
    for (const env of waiting) {
      const state = this.docs.get(env.doc);
      if (!state) continue;
      if (this.applyEnvelope(state, env.doc, env)) touched.add(env.doc);
    }
    for (const [docId, state] of this.docs) {
      const failed = [...state.undecryptable.values()];
      state.undecryptable.clear();
      for (const env of failed) if (this.applyEnvelope(state, docId, env)) touched.add(docId);
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

  // ---- clashing saves (see Clashes) ----

  /** Whole-note saves made here lately, for the owner to keep across restarts (see restoreSaves, savesChanged). */
  recentSaves(): Record<DocId, FileSave[]> {
    return this.clashes.recentSaves();
  }

  /** Changes whenever what recentSaves gives changes: it needs storing again only then. */
  get savesChanged(): number {
    return this.clashes.savesChanged;
  }

  /**
   * Saves made here in an earlier session (see recentSaves). Each is checked against what is already held of its note
   * too, so a clash with a change that came in while this computer was off, or before this call, still counts. What
   * waits for copies is asked for them again (see ReplicaEvents.clash).
   */
  restoreSaves(saved: unknown): void {
    quietly(() => this.clashes.restoreSaves(saved));
  }

  /** The owner kept a copy it was asked for (see ReplicaEvents.clash): what waited for it goes, once its copies are kept. */
  copyKept(docId: DocId, version: string): void {
    quietly(() => this.clashes.copyKept(docId, version));
  }

  /** What waits for copies is asked for them again, or goes ahead (see ReplicaEvents.clash). */
  retryTakeOuts(): void {
    quietly(() => this.clashes.retryTakeOuts());
  }

  /** The updates held for a note, decrypted (those that can be). */
  private *heldUpdates(docId: DocId): Generator<[UpdateEnvelope, Uint8Array]> {
    for (const env of this.node.store.envelopesOf(this.roomId, docId).updates) {
      const key = this.keys.get(env.n);
      if (!key) continue;
      let bytes: Uint8Array;
      try {
        bytes = openEnvelope(env, key);
      } catch {
        continue; // can't be read: nothing to check
      }
      yield [env, bytes];
    }
  }

  // ---- passing on the work of former writers ----

  /**
   * Work peers no longer take from its authors (`writes(author)` false: revoked, removed, made readers), though they did
   * it while they could, is passed on as this device's own: a snapshot of each document holding some of it, and a copy
   * of each file version of theirs still in use. Without that, a computer that catches up later would never get it.
   * One writer does it (`lead`: the first of those online); any other steps in once the work has waited a while, so
   * nothing depends on one computer. One document and one file at a time, with a turn for the app in between, so a lot of
   * such work doesn't hold this computer up. Call it now and then; once everything is passed on it does nothing.
   * Resolves once what was due is passed on.
   */
  passOnOldWork(lead: boolean, writes: (author: string) => boolean = (author) => this.writes(author)): Promise<void> {
    if (this.destroyed || !this.canWrite() || !this.sealEpoch()) return this.passingOn ?? Promise.resolve();
    const store = this.node.store;
    const now = Date.now();
    const seen = new Map<string, number>();
    const due = (key: string) => {
      const since = this.oldSince.get(key) ?? now;
      seen.set(key, since);
      return lead || now - since >= PASS_ON_STEP_IN_MS;
    };
    // Each author asked once while listing (the record can't change meanwhile): not once per document of 30,000.
    const asked = new Map<string, boolean>();
    const writer = (author: string) => {
      let answer = asked.get(author);
      if (answer === undefined) asked.set(author, (answer = writes(author)));
      return answer;
    };
    // Told by their authors alone, without going through their envelopes: most documents hold no such work.
    const docs = store.docs(this.roomId).filter((docId) => !store.authorsOf(this.roomId, docId).every(writer) && !this.cantPassOn.has(docId) && due(`doc/${docId}`));
    const files: Array<[string, BlobRef]> = [];
    for (const [fileId, entry] of this.files()) {
      const blob = entry.blob;
      if (blob && !writer(blob.by) && !this.cantPassOn.has(`${fileId}/${blob.id}`) && due(`file/${fileId}/${blob.id}`)) files.push([fileId, blob]);
    }
    this.oldSince = seen;
    if (!this.passingOn && docs.length + files.length > 0) this.passingOn = this.passOn(docs, files, writes).finally(() => (this.passingOn = null));
    return this.passingOn ?? Promise.resolve();
  }

  private async passOn(docs: DocId[], files: Array<[string, BlobRef]>, writes: (author: string) => boolean): Promise<void> {
    const store = this.node.store;
    const going = () => !this.destroyed && this.canWrite() && this.sealEpoch() !== null;
    for (const docId of docs) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!going()) return;
      const { updates, snapshots } = store.envelopesOf(this.roomId, docId);
      const old = [...updates, ...snapshots].filter((env) => !writes(env.author)).map((env) => envelopeKey(env));
      const done = this.passedOn.get(docId);
      if (old.length === 0 || (done && old.every((key) => done.has(key))) || !this.isComplete(docId)) continue;
      const { doc, pending } = this.loadDoc(docId);
      // A snapshot now would leave out what still waits for its dependencies.
      if (pending.size > 0) continue;
      const mine = snapshots.filter((s) => s.author === this.node.deviceId).sort((a, b) => b.seq - a.seq)[0];
      const held = mine ? this.contentsOf(mine) : null;
      if ((held && Y.equalSnapshots(held, Y.snapshot(doc))) || this.snapshot(docId, true)) this.passedOn.set(docId, new Set(old));
      // Too large to snapshot, or no room left for it: not tried again in this session.
      else this.cantPassOn.add(docId);
    }
    for (const [fileId, blob] of files) {
      const version = `${fileId}/${blob.id}`;
      try {
        // Passed on (or changed) since it was listed: nothing to do.
        if (this.index.get(fileId)?.blob?.id !== blob.id || !going()) continue;
        const bytes = await this.readBlob(blob);
        if (!bytes || !going()) continue;
        const copy = this.putBlob(bytes);
        const result = this.editIndex((all) => {
          const current = all.get(fileId);
          if (current?.blob?.by === blob.by && current.blob.id === blob.id) all.set(fileId, { ...current, blob: copy, base: blob.id });
        });
        // No room left for it, say: not tried again in this session.
        if (result === "refused") this.cantPassOn.add(version);
      } catch (error) {
        // Without the room key yet: tried again next time. Anything else (no room left for it) isn't retried for now.
        if (!(error instanceof SecureError && error.code === "no_room_key")) this.cantPassOn.add(version);
      }
    }
  }

  // ---- compaction ----

  /** Whether peers take envelopes of this device in this room now (see verifyEnvelope). */
  writes(deviceId: string): boolean {
    const state = this.node.effective();
    const device = activeDevice(state, deviceId);
    return device !== null && roleAtLeast(roleIn(state, this.roomId, device.user), "write");
  }

  /** The Yjs snapshot (state vector and deletions) of a held snapshot envelope, or null if it can't be read. */
  private contentsOf(snapshot: SnapshotEnvelope): Y.Snapshot | null {
    if (snapshot === this.sealed?.env) return this.sealed.contents;
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
    const reach = (s: SnapshotEnvelope) => Object.values(s.covers).reduce((sum, clock) => sum + clock, 0);
    const ordered = [...snapshots].sort((a, b) => reach(b) - reach(a) || (envelopeKey(a) < envelopeKey(b) ? -1 : 1));
    for (const snapshot of ordered) {
      // One by someone who may no longer write never takes another's place: peers catching up would refuse it.
      if (remove.has(snapshot) || !this.writes(snapshot.author)) continue;
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
        if (contains(update)) remove.add(update);
      }
      for (const other of snapshots) if (other !== snapshot && !remove.has(other) && vvDominates(snapshot.covers, other.covers) && contains(other)) remove.add(other);
    }
    // A mark says every update up to it is in a snapshot (a later one is refused as a duplicate, and never asked for
    // again). So per author it only covers the updates taken out up to the first one kept, and only those go.
    const marks: VersionVector = {};
    const kept = new Set<string>();
    for (const update of updates) {
      if (update.clock > (held[update.author] ?? 0)) continue;
      if (remove.has(update) && !kept.has(update.author)) marks[update.author] = update.clock;
      else {
        kept.add(update.author);
        remove.delete(update);
      }
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
    // Every 200 edits, or for a large note one per 4 KB of its last snapshot (a 6 MB note: about 1,500 edits).
    if (++state.sinceSnapshot >= Math.max(SNAPSHOT_EVERY, state.snapshotBytes / 4096)) this.snapshot(docId);
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
  snapshot(docId: DocId, always = false): SnapshotEnvelope | null {
    const state = this.docs.get(docId);
    if (!state || !this.canWrite() || !this.sealEpoch()) return null;
    if (state.pending.size > 0 || waitsForDependencies(state.doc)) return null;
    // `always`: even a document held as snapshots only (nothing applied here), as when passing work on.
    if (!always && Object.keys(state.applied).length === 0) return null;
    const seq = this.node.store.maxSnapshotSeq(this.roomId, docId, this.node.deviceId) + 1;
    let env: SnapshotEnvelope;
    try {
      env = sealSnapshot(this.sealContext(), docId, seq, { ...state.applied }, Y.encodeStateAsUpdate(state.doc));
    } catch {
      return null; // too large to snapshot: the updates stay
    }
    state.sinceSnapshot = 0;
    state.snapshotBytes = env.ct.length;
    // What it holds is what the note holds now: its echo and compaction needn't decrypt it (a large note's is MBs).
    this.sealed = { env, contents: Y.snapshot(state.doc) };
    try {
      if (!this.node.publish(env)) return null;
      this.compact(docId);
      return env;
    } finally {
      // Only its echo and this compaction need it: not kept (a large note's is MBs).
      this.sealed = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const state of this.docs.values()) state.doc.destroy();
    this.docs.clear();
  }
}
