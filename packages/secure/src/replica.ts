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
  /**
   * A whole-note save made here (see `edit`, `save`) and someone else's, made at the same moment, replaced the same text
   * (two values written over one, say). One of them is kept in the shared note, the same on every computer; `lost`:
   * this computer's wasn't, so the owner keeps it as a copy.
   */
  clash?(docId: string, lost: boolean): void;
}

/** A run of characters in a document by their Yjs ids. */
export interface IdRange {
  client: number;
  clock: number;
  length: number;
}

/** A whole-note save made here (when, ms): what it took out, and each run it put in with the text that run replaced. */
export interface FileSave {
  at: number;
  deleted: IdRange[];
  inserted: Array<IdRange & { replaces: IdRange[] }>;
}

const MAX_FILE_SAVES = 20;
/** Saves are remembered for this many notes at most, for this long (ms), across restarts too (see recentSaves). */
const MAX_SAVED_NOTES = 200;
const SAVE_KEPT_MS = 30 * 24 * 3600_000;
const MAX_SAVED_RANGES = 10_000;

function deletedRanges(update: Uint8Array): IdRange[] {
  const { ds } = Y.decodeUpdate(update) as unknown as { ds: { clients: Map<number, Array<{ clock: number; len: number }>> } };
  return [...ds.clients].flatMap(([client, items]) => items.map(({ clock, len }) => ({ client, clock, length: len })));
}

function insertedRanges(update: Uint8Array): IdRange[] {
  const { structs } = Y.decodeUpdate(update) as unknown as { structs: Array<{ id: Y.ID; length: number; content?: unknown }> };
  return structs.filter((struct) => struct.content !== undefined).map((struct) => ({ client: struct.id.client, clock: struct.id.clock, length: struct.length }));
}

function overlap(a: IdRange[], b: IdRange[]): IdRange[] {
  const out: IdRange[] = [];
  for (const x of a) {
    for (const y of b) {
      if (x.client !== y.client) continue;
      const from = Math.max(x.clock, y.clock);
      const to = Math.min(x.clock + x.length, y.clock + y.length);
      if (from < to) out.push({ client: x.client, clock: from, length: to - from });
    }
  }
  return out;
}

function validRanges(value: unknown): IdRange[] | null {
  if (!Array.isArray(value) || value.length > MAX_SAVED_RANGES) return null;
  const out: IdRange[] = [];
  for (const range of value) {
    const { client, clock, length } = (typeof range === "object" && range !== null ? range : {}) as Record<string, unknown>;
    if (![client, clock, length].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) return null;
    out.push({ client: client as number, clock: clock as number, length: length as number });
  }
  return out;
}

function validSave(value: unknown): FileSave | null {
  const { at, deleted, inserted } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const gone = validRanges(deleted);
  const added = validRanges(inserted);
  if (!Number.isSafeInteger(at) || !gone || !added) return null;
  const replaces = (inserted as Array<{ replaces?: unknown }>).map((item) => validRanges(item.replaces));
  if (replaces.some((ranges) => ranges === null)) return null;
  return { at: at as number, deleted: gone, inserted: added.map((range, i) => ({ ...range, replaces: replaces[i]! })) };
}

/** A Y.Text's items in document order, deleted ones too. */
type TextItem = { id: Y.ID; length: number; deleted: boolean; countable: boolean; right: TextItem | null };
function textItems(text: Y.Text): TextItem[] {
  const items: TextItem[] = [];
  for (let item = (text as unknown as { _start: TextItem | null })._start; item; item = item.right) items.push(item);
  return items;
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
  /** The edit under way is a whole-note save (see `edit`). */
  private saving = false;
  /** Recent whole-note saves made here, per note, to spot a clash with someone else's (see ReplicaEvents.clash). */
  private fileSaves = new Map<DocId, FileSave[]>();
  /** Documents this device passed on, with the work of former writers it covered then (see passOnOldWork). */
  private passedOn = new Map<DocId, Set<string>>();
  /** Files whose version by a former writer is being passed on (see passOnOldWork). */
  private passingOn = new Set<string>();
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
    if (this.saving) {
      const deleted = deletedRanges(update);
      this.rememberSave(docId, { at: Date.now(), deleted, inserted: this.replacedBy(docId, insertedRanges(update), deleted) });
    }
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
    try {
      state.doc.transact(() => change(state.doc));
    } finally {
      this.editing = false;
      this.saving = false;
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
    if (env.author !== this.node.deviceId && this.fileSaves.has(docId)) this.checkClash(docId, env, bytes);
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

  // ---- clashing saves ----

  /**
   * For each run of text a save put in: what the save took out right before it, the text that run replaced (a note saved
   * outside the editor is changed line by line, each new line put in where its old one was taken out).
   */
  private replacedBy(docId: DocId, inserted: IdRange[], deleted: IdRange[]): FileSave["inserted"] {
    const runs = inserted.map((range) => ({ ...range, replaces: [] as IdRange[] }));
    // A run starts an item of its own (one that starts inside another, right after this save's own text, replaced nothing).
    const starts = new Map(runs.map((run) => [`${run.client}:${run.clock}`, run]));
    const text = this.docs.get(docId)?.doc.getText("content");
    let gone: IdRange[] = [];
    for (const item of text ? textItems(text) : []) {
      const range = { client: item.id.client, clock: item.id.clock, length: item.length };
      if (item.deleted) {
        gone.push(...overlap([range], deleted));
        continue;
      }
      const run = starts.get(`${range.client}:${range.clock}`);
      if (run) run.replaces = gone;
      gone = [];
    }
    return runs;
  }

  private rememberSave(docId: DocId, save: FileSave): void {
    const saves = [...(this.fileSaves.get(docId) ?? []), save].slice(-MAX_FILE_SAVES);
    this.fileSaves.delete(docId);
    this.fileSaves.set(docId, saves);
    for (const oldest of this.fileSaves.keys()) {
      if (this.fileSaves.size <= MAX_SAVED_NOTES) break;
      this.fileSaves.delete(oldest);
    }
  }

  /** Whole-note saves made here lately, for the owner to keep across restarts (see restoreSaves). */
  recentSaves(): Record<DocId, FileSave[]> {
    const since = Date.now() - SAVE_KEPT_MS;
    const out: Record<DocId, FileSave[]> = {};
    for (const [docId, saves] of this.fileSaves) {
      const kept = saves.filter((save) => save.at >= since);
      if (kept.length > 0) out[docId] = kept;
    }
    return out;
  }

  /**
   * Saves made here in an earlier session (see recentSaves). Each is checked against what is already held of its note
   * too, so a clash with a change that came in while this computer was off, or before this call, still counts (one
   * found again changes nothing more).
   */
  restoreSaves(saved: unknown): void {
    if (typeof saved !== "object" || saved === null) return;
    const since = Date.now() - SAVE_KEPT_MS;
    for (const [docId, list] of Object.entries(saved).slice(-MAX_SAVED_NOTES)) {
      if (!isId(docId, "f") || !Array.isArray(list)) continue;
      const saves = list.slice(-MAX_FILE_SAVES).map(validSave).filter((save): save is FileSave => save !== null && save.at >= since);
      if (saves.length === 0) continue;
      this.fileSaves.set(docId, [...saves, ...(this.fileSaves.get(docId) ?? [])].slice(-MAX_FILE_SAVES));
      // A note not loaded yet is checked as it loads.
      if (!this.docs.has(docId)) continue;
      const { snapshots, updates } = this.node.store.envelopesOf(this.roomId, docId);
      for (const env of [...snapshots, ...updates]) {
        const key = this.keys.get(env.n);
        if (env.author === this.node.deviceId || !key) continue;
        try {
          this.checkClash(docId, env, openEnvelope(env, key));
        } catch {
          // can't be read: nothing to check
        }
      }
    }
  }

  /**
   * Did someone else's change, made at the same moment, take out text a whole-note save of ours took out too? Then both
   * replaced the same lines (a date changed to two different values, say), and keeping both would mix them. The save of
   * the computer with the lower device id is kept: the other computer takes its own new lines there out again (it knows
   * what each of them replaced), and keeps its version as a copy. Only an update made on one computer tells whose
   * change it is; against anything else (a snapshot, content passed on again) a save made here gives way, so two
   * computers never both keep theirs.
   */
  private checkClash(docId: DocId, env: UpdateEnvelope | SnapshotEnvelope, bytes: Uint8Array): void {
    let theirs: IdRange[];
    let theirInserted: IdRange[];
    try {
      theirs = deletedRanges(bytes);
      theirInserted = insertedRanges(bytes);
    } catch {
      return;
    }
    // How far it reaches per writer of the text it holds.
    const reach = new Map<number, number>();
    for (const t of theirInserted) reach.set(t.client, Math.max(reach.get(t.client) ?? 0, t.clock + t.length));
    const single = env.k === "u" && reach.size <= 1;
    const lost = !single || this.node.deviceId > env.author;
    const remove: IdRange[] = [];
    for (const save of this.fileSaves.get(docId) ?? []) {
      // It holds this save's new text, so it was made after the save. (Of a save that only took text out, nothing tells.)
      if (save.inserted.some((mine) => (reach.get(mine.client) ?? 0) >= mine.clock + mine.length)) continue;
      if (!single && save.inserted.length === 0) continue;
      const both = overlap(save.deleted, theirs);
      if (both.length === 0) continue;
      if (lost) remove.push(...save.inserted.filter((run) => overlap(run.replaces, both).length > 0));
      this.events.clash?.(docId, lost);
    }
    if (remove.length > 0) queueMicrotask(() => this.takeOut(docId, remove));
  }

  /** Take characters out of a note by their ids (those still there). */
  private takeOut(docId: DocId, ranges: IdRange[]): void {
    const state = this.docs.get(docId);
    if (!state || this.destroyed || !this.canWrite() || !this.sealEpoch()) return;
    const text = state.doc.getText("content");
    const spans: Array<[number, number]> = [];
    let index = 0;
    for (const item of textItems(text)) {
      if (item.deleted || !item.countable) continue;
      for (const r of ranges) {
        if (r.client !== item.id.client) continue;
        const from = Math.max(r.clock, item.id.clock);
        const to = Math.min(r.clock + r.length, item.id.clock + item.length);
        if (from < to) spans.push([index + from - item.id.clock, to - from]);
      }
      index += item.length;
    }
    if (spans.length === 0) return;
    this.edit(docId, () => {
      for (const [at, length] of spans.sort((x, y) => y[0] - x[0])) text.delete(at, length);
    });
  }

  // ---- passing on the work of former writers ----

  /**
   * Work peers no longer take from its authors (`writes(author)` false: revoked, removed, made readers), though they did
   * it while they could, is passed on as this device's own: a snapshot of each document holding some of it, and a copy
   * of each file version of theirs still in use. Without that, a computer that catches up later would never get it.
   * Call it now and then; once everything is passed on it does nothing.
   */
  passOnOldWork(writes: (author: string) => boolean): void {
    if (this.destroyed || !this.canWrite() || !this.sealEpoch()) return;
    const store = this.node.store;
    for (const docId of store.docs(this.roomId)) {
      const { updates, snapshots } = store.envelopesOf(this.roomId, docId);
      const old = [...updates, ...snapshots].filter((env) => !writes(env.author)).map((env) => envelopeKey(env));
      const done = this.passedOn.get(docId);
      if (old.length === 0 || (done && old.every((key) => done.has(key))) || !this.isComplete(docId)) continue;
      const mine = snapshots.filter((s) => s.author === this.node.deviceId).sort((a, b) => b.seq - a.seq)[0];
      const held = mine ? this.contentsOf(mine) : null;
      if ((held && Y.equalSnapshots(held, Y.snapshot(this.loadDoc(docId).doc))) || this.snapshot(docId, true)) this.passedOn.set(docId, new Set(old));
    }
    for (const [fileId, entry] of this.files()) {
      const blob = entry.blob;
      if (!blob || writes(blob.by) || this.passingOn.has(fileId)) continue;
      this.passingOn.add(fileId);
      void this.readBlob(blob)
        .then((bytes) => {
          if (!bytes || this.destroyed) return;
          const copy = this.putBlob(bytes);
          this.editIndex((files) => {
            const now = files.get(fileId);
            if (now?.blob?.by === blob.by && now.blob.id === blob.id) files.set(fileId, { ...now, blob: copy, base: blob.id });
          });
        })
        .catch(() => {
          // can't be passed on now (no room key, storage full): tried again next time
        })
        .finally(() => this.passingOn.delete(fileId));
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
  snapshot(docId: DocId, always = false): SnapshotEnvelope | null {
    const state = this.docs.get(docId);
    if (!state || !this.canWrite() || !this.sealEpoch()) return null;
    const store = state.doc.store as unknown as { pendingStructs: unknown; pendingDs: unknown };
    if (store.pendingStructs || store.pendingDs) return null;
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
