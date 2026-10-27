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
/** A writer that isn't the first to pass on a former writer's work steps in after this long (ms) if it is still there. */
const PASS_ON_STEP_IN_MS = 10 * 60_000;

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
   * A whole-note save made here (see `edit`, `save`) and someone else's, made at the same moment, replaced the same line
   * (two values written over one, say), and the other's is kept in the shared note. `version`: the note as this computer
   * had it, with its own line, for the owner to keep as a copy. Returning false (nowhere to keep it now, the room's folder
   * being away) leaves the line in the note: the clash is settled when the saves are restored again (see restoreSaves).
   */
  clash?(docId: string, version: string): boolean | void;
}

/** A run of characters in a document by their Yjs ids. */
export interface IdRange {
  client: number;
  clock: number;
  length: number;
}

/**
 * What to take out of a note, and the copies its owner keeps first: `copy`, one of the note without the lines found
 * competing (see settle); `versions`, ones already made.
 */
interface Pending {
  out: IdRange[];
  copy: boolean;
  versions: string[];
}

/** A run of text put in, and the character it was put in front of (for a changed line: the first of the old one). */
export interface InsertedRun extends IdRange {
  right: { client: number; clock: number } | null;
}

/** A whole-note save made here (when, ms): what it took out and what it put in. */
export interface FileSave {
  at: number;
  deleted: IdRange[];
  inserted: InsertedRun[];
}

const MAX_FILE_SAVES = 20;
/** Saves are remembered for this many notes at most, for this long (ms), across restarts too (see recentSaves). */
const MAX_SAVED_NOTES = 200;
const SAVE_KEPT_MS = 30 * 24 * 3600_000;
/** Larger saves (a whole note rewritten) aren't remembered: they would cost too much to keep and check. */
const MAX_SAVED_RANGES = 500;
/** All remembered saves together, at most (the oldest notes' are let go first). */
const MAX_SAVED_TOTAL = 20_000;
/** What is remembered of text typed here, per note (the newest), and for how many notes (see typedClash). */
const MAX_TYPED_RANGES = 2_000;
const MAX_TYPED_NOTES = 50;

function deletedRanges(update: Uint8Array): IdRange[] {
  const { ds } = Y.decodeUpdate(update) as unknown as { ds: { clients: Map<number, Array<{ clock: number; len: number }>> } };
  return [...ds.clients].flatMap(([client, items]) => items.map(({ clock, len }) => ({ client, clock, length: len })));
}

function insertedRuns(update: Uint8Array): InsertedRun[] {
  const { structs } = Y.decodeUpdate(update) as unknown as { structs: Array<{ id: Y.ID; length: number; rightOrigin?: Y.ID | null; content?: unknown }> };
  return structs
    .filter((struct) => struct.content !== undefined)
    .map((struct) => ({ client: struct.id.client, clock: struct.id.clock, length: struct.length, right: struct.rightOrigin ? { client: struct.rightOrigin.client, clock: struct.rightOrigin.clock } : null }));
}

/**
 * The runs of an update that may be whole lines, by `client:clock`: text ending with a line break, or text taken out
 * since (what it was can't be seen; whether a line took its place is seen in the note, see checkClash).
 */
function lineRuns(update: Uint8Array): Set<string> {
  const { structs } = Y.decodeUpdate(update) as unknown as { structs: Array<{ id: Y.ID; content?: { str?: string; len?: number } }> };
  return new Set(
    structs
      .filter((struct) => struct.content?.str?.endsWith("\n") || (struct.content !== undefined && struct.content.str === undefined && struct.content.len !== undefined))
      .map((struct) => `${struct.id.client}:${struct.id.clock}`)
  );
}

/** The parts of `a` also in `b`; `b` is a set of ranges without overlaps (a Yjs delete set, say). */
function overlap(a: IdRange[], b: IdRange[]): IdRange[] {
  const byClient = new Map<number, IdRange[]>();
  for (const y of b) byClient.set(y.client, [...(byClient.get(y.client) ?? []), y]);
  for (const list of byClient.values()) list.sort((x, y) => x.clock - y.clock);
  const out: IdRange[] = [];
  for (const x of a) {
    const list = byClient.get(x.client) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.clock + list[mid]!.length <= x.clock) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < list.length && list[i]!.clock < x.clock + x.length; i++) {
      const from = Math.max(x.clock, list[i]!.clock);
      const to = Math.min(x.clock + x.length, list[i]!.clock + list[i]!.length);
      if (from < to) out.push({ client: x.client, clock: from, length: to - from });
    }
  }
  return out;
}

function within(ranges: IdRange[], id: { client: number; clock: number }): boolean {
  return ranges.some((r) => r.client === id.client && id.clock >= r.clock && id.clock < r.clock + r.length);
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
  const rights = (inserted as Array<{ right?: unknown }>).map((run) => {
    if (run.right === null) return null;
    const { client, clock } = (typeof run.right === "object" && run.right !== null ? run.right : {}) as Record<string, unknown>;
    return [client, clock].every((n) => Number.isSafeInteger(n) && (n as number) >= 0) ? { client: client as number, clock: clock as number } : undefined;
  });
  if (rights.some((right) => right === undefined)) return null;
  return { at: at as number, deleted: gone, inserted: added.map((range, i) => ({ ...range, right: rights[i]! })) };
}

/** A Y.Text's items in document order, deleted ones too. */
type TextItem = { id: Y.ID; length: number; deleted: boolean; countable: boolean; right: TextItem | null };
function textItems(text: Y.Text): TextItem[] {
  const items: TextItem[] = [];
  for (let item = (text as unknown as { _start: TextItem | null })._start; item; item = item.right) items.push(item);
  return items;
}

/**
 * Where the characters of `ranges` still in a text are: [index, length] spans, last first. Each character counts once,
 * however often (or overlapping) the ranges name it, so taking the spans out never takes anything else.
 */
function spansOf(text: Y.Text, ranges: IdRange[]): Array<[number, number]> {
  const byClient = new Map<number, IdRange[]>();
  for (const r of ranges) byClient.set(r.client, [...(byClient.get(r.client) ?? []), r]);
  const spans: Array<[number, number]> = [];
  let index = 0;
  for (const item of textItems(text)) {
    if (item.deleted || !item.countable) continue;
    const parts: Array<[number, number]> = [];
    for (const r of byClient.get(item.id.client) ?? []) {
      const from = Math.max(r.clock, item.id.clock);
      const to = Math.min(r.clock + r.length, item.id.clock + item.length);
      if (from < to) parts.push([from - item.id.clock, to - item.id.clock]);
    }
    parts.sort((x, y) => x[0] - y[0]);
    let start = 0;
    let end = 0;
    for (const [from, to] of parts) {
      if (from > end) {
        if (end > start) spans.push([index + start, end - start]);
        start = from;
      }
      end = Math.max(end, to);
    }
    if (end > start) spans.push([index + start, end - start]);
    index += item.length;
  }
  return spans.sort((x, y) => y[0] - x[0]);
}

/**
 * `runs`, and what was put inside one of them since, in turn. For `lines` (runs that are whole lines), what was put in
 * front of a line's first character is before the line; with `replaced`, if the line is gone, it took the line's place
 * (the line changed again) and counts as a line too.
 */
function withInside(text: Y.Text, runs: IdRange[], lines: boolean, replaced = false): IdRange[] {
  const items = textItems(text) as Array<TextItem & { rightOrigin: Y.ID | null }>;
  const key = (id: { client: number; clock: number }) => `${id.client}:${id.clock}`;
  const gone = (range: IdRange) => !items.some((item) => !item.deleted && item.id.client === range.client && item.id.clock < range.clock + range.length && range.clock < item.id.clock + item.length);
  const out = [...runs];
  const starts = new Map<string, boolean>(lines ? runs.map((run) => [key(run), gone(run)]) : []);
  for (let grew = true; grew; ) {
    grew = false;
    // Right to left: what an item was put in front of is further right, so is decided first (one pass, in a chain).
    for (let k = items.length - 1; k >= 0; k--) {
      const item = items[k]!;
      const right = item.rightOrigin;
      if (!right || !within(out, right) || within(out, item.id)) continue;
      const start = starts.get(key(right));
      if (start !== undefined && !(replaced && start)) continue; // in front of a line: before it
      const range = { client: item.id.client, clock: item.id.clock, length: item.length };
      out.push(range);
      if (start === true) starts.set(key(range), gone(range));
      grew = true;
    }
  }
  return out;
}

/**
 * The characters of the lines that start with one of `starts` (ids), as the text has them now: from that first
 * character on, as long as the characters are `old` (the line's own text, as the other side took it out, and what was
 * typed here inside it), up to and with the line break that ends it (one of `breaks`). A character taken out here
 * counts as well, so a line whose break is already gone here still ends where it did.
 */
function linesFrom(text: Y.Text, starts: Set<string>, breaks: IdRange[], old: IdRange[]): IdRange[] {
  const startsBy = new Map<number, number[]>();
  for (const key of starts) {
    const [client, clock] = key.split(":").map(Number) as [number, number];
    startsBy.set(client, [...(startsBy.get(client) ?? []), clock]);
  }
  for (const list of startsBy.values()) list.sort((a, b) => a - b);
  const inOld = member(old);
  const isBreak = member(breaks);
  const out: IdRange[] = [];
  let open = false;
  for (const item of textItems(text) as Array<TextItem & { content: { str?: string } }>) {
    // Only items with a line start in them, or inside a line, are looked at character by character.
    const list = startsBy.get(item.id.client) ?? [];
    let k = firstAtLeast(list, item.id.clock);
    const end = item.id.clock + item.length;
    if (!open && !(k < list.length && list[k]! < end)) continue;
    const str = item.deleted ? undefined : item.content.str;
    let from = -1;
    const close = (to: number) => {
      if (from >= 0 && to > from) out.push({ client: item.id.client, clock: item.id.clock + from, length: to - from });
      open = false;
      from = -1;
    };
    for (let i = open ? 0 : list[k]! - item.id.clock; i < item.length; i++) {
      const id = { client: item.id.client, clock: item.id.clock + i };
      if (open && !inOld(id)) close(i);
      if (!open && starts.has(`${id.client}:${id.clock}`)) open = true;
      if (open && from < 0) from = i;
      if (open && str?.[i] === "\n" && isBreak(id)) close(i + 1);
      if (!open) {
        // On to the next line start in this item, if there is one.
        while (k < list.length && list[k]! <= id.clock) k++;
        if (k >= list.length || list[k]! >= end) break;
        i = list[k]! - item.id.clock - 1;
      }
    }
    if (open) close(item.length), (open = true);
  }
  return out;
}

/** The index of the first number in a sorted list that is at least `value` (the list's length if none is). */
function firstAtLeast(list: number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether an id is in `ranges`, by binary search over them merged per client. */
function member(ranges: IdRange[]): (id: { client: number; clock: number }) => boolean {
  const byClient = new Map<number, Array<[number, number]>>();
  for (const r of ranges) byClient.set(r.client, [...(byClient.get(r.client) ?? []), [r.clock, r.clock + r.length]]);
  const ends = new Map<number, { from: number[]; to: number[] }>();
  for (const [client, list] of byClient) {
    list.sort((x, y) => x[0] - y[0]);
    const merged: Array<[number, number]> = [];
    for (const [from, to] of list) {
      const last = merged[merged.length - 1];
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else merged.push([from, to]);
    }
    ends.set(client, { from: merged.map(([from]) => from), to: merged.map(([, to]) => to) });
  }
  return (id) => {
    const runs = ends.get(id.client);
    if (!runs) return false;
    const i = firstAtLeast(runs.to, id.clock + 1);
    return i < runs.from.length && runs.from[i]! <= id.clock;
  };
}

/** A note's text with the characters of `ranges` taken out (the note itself left as it is). */
function textWithout(doc: Y.Doc, ranges: IdRange[]): string {
  const probe = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc));
    const text = probe.getText("content");
    for (const [at, length] of spansOf(text, ranges)) text.delete(at, length);
    return text.toString();
  } finally {
    probe.destroy();
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
  /** Text typed here in this session (not whole-note saves), per note: what it took out and put in (see typedClash). */
  private typed = new Map<DocId, { deleted: IdRange[]; inserted: InsertedRun[] }>();
  /** What lost a clash, per note, to take out (see settle); `copy`: a line saved here lost, so the owner keeps a copy. */
  private takeOuts = new Map<DocId, Pending>();
  /** Take-outs waiting for the owner to be able to keep their copies (see ReplicaEvents.clash, restoreSaves). */
  private waitingTakeOuts = new Map<DocId, Pending>();
  /** Lines of others found competing with lines saved here, per note: left out of the copy kept (see settle). */
  private rivals = new Map<DocId, IdRange[]>();
  /** A take-out of what lost a clash is being made: not text typed here. */
  private settling = false;
  /** Notes where taking out what lost a clash was refused (no room left, say): not tried again in this session. */
  private unsettled = new Set<DocId>();
  /** Documents this device passed on, with the work of former writers it covered then (see passOnOldWork). */
  private passedOn = new Map<DocId, Set<string>>();
  /** Files whose version by a former writer is being passed on (see passOnOldWork). */
  private passingOn = new Set<string>();
  /** Former writers' work, by document or file version: when it was first seen here (see passOnOldWork). */
  private oldSince = new Map<string, number>();
  /** File versions that couldn't be passed on (no room left for them, say): not tried again in this session. */
  private cantPassOn = new Set<string>();
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
    const checks: Array<[UpdateEnvelope | SnapshotEnvelope, Uint8Array]> = [];
    for (const env of [...snapshots, ...updates]) this.applyEnvelope(state, docId, env, checks);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) this.localUpdate(docId, update);
    });
    if (updates.some((u) => snapshots.some((s) => u.clock <= (s.covers[u.author] ?? 0)))) this.compact(docId);
    // Clashes are looked for once the whole note is in (this computer's own saves too), and settled before it is read.
    for (const [env, bytes] of checks) this.checkClash(docId, env, bytes);
    this.settle(docId);
    return this.docs.get(docId) ?? state;
  }

  /** When this device last changed a document (ms), to tell a note being worked on here from one left alone. */
  lastLocalEdit(docId: DocId): number {
    return this.localEditAt.get(docId) ?? 0;
  }

  private localUpdate(docId: DocId, update: Uint8Array): void {
    this.localEditAt.set(docId, Date.now());
    if (this.saving) {
      const deleted = deletedRanges(update);
      const inserted = insertedRuns(update);
      if (deleted.length + inserted.length <= MAX_SAVED_RANGES) this.rememberSave(docId, { at: Date.now(), deleted, inserted });
    } else if (docId !== INDEX_DOC && !this.settling) {
      const typed = this.typed.get(docId) ?? { deleted: [], inserted: [] };
      this.typed.delete(docId);
      this.typed.set(docId, { deleted: [...typed.deleted, ...deletedRanges(update)].slice(-MAX_TYPED_RANGES), inserted: [...typed.inserted, ...insertedRuns(update)].slice(-MAX_TYPED_RANGES) });
      for (const oldest of this.typed.keys()) {
        if (this.typed.size <= MAX_TYPED_NOTES) break;
        this.typed.delete(oldest);
      }
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

  /** Decrypt and merge one envelope. Returns true if it changed the document. `checks`: clashes are looked for later. */
  private applyEnvelope(state: DocState, docId: DocId, env: UpdateEnvelope | SnapshotEnvelope, checks?: Array<[UpdateEnvelope | SnapshotEnvelope, Uint8Array]>): boolean {
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
    const typed = checks ? null : this.typedClash(state, docId, env, bytes);
    const before = Y.encodeStateVector(state.doc);
    try {
      Y.applyUpdate(state.doc, bytes, REMOTE);
    } catch {
      return false; // not a valid Yjs update: ignore it rather than corrupt the document
    }
    if (typed) {
      this.takeOut(docId, typed.strays, false, typed.version === textWithout(state.doc, typed.strays) ? [] : [typed.version]);
    }
    if (env.author !== this.node.deviceId && this.fileSaves.has(docId)) {
      if (checks) checks.push([env, bytes]);
      else this.checkClash(docId, env, bytes, Y.decodeStateVector(before));
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

  // ---- clashing saves ----

  private rememberSave(docId: DocId, save: FileSave): void {
    const saves = [...(this.fileSaves.get(docId) ?? []), save].slice(-MAX_FILE_SAVES);
    this.fileSaves.delete(docId);
    this.fileSaves.set(docId, saves);
    const size = (list: FileSave[]) => list.reduce((sum, one) => sum + one.deleted.length + one.inserted.length, 0);
    let total = [...this.fileSaves.values()].reduce((sum, list) => sum + size(list), 0);
    for (const [oldest, list] of this.fileSaves) {
      if (this.fileSaves.size <= MAX_SAVED_NOTES && total <= MAX_SAVED_TOTAL) break;
      total -= size(list);
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
    // Take-outs that waited for their copies to be kept go ahead (or wait again).
    for (const [docId, waiting] of [...this.waitingTakeOuts]) {
      this.waitingTakeOuts.delete(docId);
      this.takeOut(docId, waiting.out, waiting.copy, waiting.versions);
      this.settle(docId);
    }
    if (typeof saved !== "object" || saved === null) return;
    const since = Date.now() - SAVE_KEPT_MS;
    for (const [docId, list] of Object.entries(saved).slice(-MAX_SAVED_NOTES)) {
      if (!isId(docId, "f") || !Array.isArray(list)) continue;
      const held = this.fileSaves.get(docId) ?? [];
      const known = new Set(held.map((save) => JSON.stringify(save)));
      const saves = list.slice(-MAX_FILE_SAVES).map(validSave).filter((save): save is FileSave => save !== null && save.at >= since && !known.has(JSON.stringify(save)));
      if (saves.length > 0) this.fileSaves.set(docId, [...saves, ...held].slice(-MAX_FILE_SAVES));
      // A note not loaded yet is checked as it loads; one without saves has nothing to check.
      if (!this.docs.has(docId) || !this.fileSaves.has(docId)) continue;
      for (const env of this.node.store.envelopesOf(this.roomId, docId).updates) {
        const key = this.keys.get(env.n);
        if (env.author === this.node.deviceId || !key) continue;
        try {
          this.checkClash(docId, env, openEnvelope(env, key));
        } catch {
          // can't be read: nothing to check
        }
      }
      this.settle(docId);
    }
  }

  /**
   * Did someone else's save, made at the same moment, replace a line a whole-note save of ours replaced too (a date
   * changed to two different values, say)? Both took the old line out and put their own in front of it (see
   * reconcileYTextByLines), so keeping both would leave the line twice. The line put in by the lower Yjs client id is
   * kept: each computer can tell, from the two lines alone, and the other computer takes its own out again (with any
   * line it later put in its place, and whatever went inside it) and keeps its version as a copy. An update made on one
   * computer in one go holds only its own lines; anything else (a snapshot, content passed on) counts only for the lines
   * this computer didn't have before it came (`known`, its state then), never while a note loads. A line one side
   * changed only in part is merged as it is.
   */
  private checkClash(docId: DocId, env: UpdateEnvelope | SnapshotEnvelope, bytes: Uint8Array, known?: Map<number, number>): void {
    if (this.unsettled.has(docId)) return;
    let theirs: IdRange[];
    let theirRuns: InsertedRun[];
    try {
      theirs = deletedRanges(bytes);
      theirRuns = insertedRuns(bytes);
    } catch {
      return;
    }
    const single = env.k === "u" && new Set(theirRuns.map((run) => run.client)).size === 1;
    if (theirs.length === 0 || theirRuns.length === 0 || (!single && !known)) return;
    // The lines it brings that weren't here (from anything but an update made in one go: only whole lines).
    const lines = single ? null : lineRuns(bytes);
    const fresh = single ? theirRuns : theirRuns.filter((t) => t.clock >= (known!.get(t.client) ?? 0) && lines!.has(`${t.client}:${t.clock}`));
    const state = this.docs.get(docId);
    if (!state) return;
    const text = state.doc.getText("content");
    const lost: InsertedRun[] = [];
    const rivals: InsertedRun[] = [];
    const beaten: InsertedRun[] = [];
    const same = (a: IdRange, b: IdRange) => a.client === b.client && a.clock === b.clock;
    const saves = this.fileSaves.get(docId) ?? [];
    // How far it reaches per writer of the text it holds.
    const reach = new Map<number, number>();
    for (const t of theirRuns) reach.set(t.client, Math.max(reach.get(t.client) ?? 0, t.clock + t.length));
    for (const save of saves) {
      // It holds this save, so the old line may have been taken out by this save alone: a line put in front of it (typed
      // above it, say) can't be told from a rival there.
      if (!single && save.inserted.some((mine) => (reach.get(mine.client) ?? 0) >= mine.clock + mine.length)) continue;
      const both = overlap(save.deleted, theirs);
      if (both.length === 0) continue;
      for (const run of save.inserted) {
        if (!run.right || !within(both, run.right)) continue;
        const others = fresh.filter((t) => t.client !== run.client && t.right?.client === run.right!.client && t.right.clock === run.right!.clock);
        // Gives way only to a line still in the note (or one that took its place since): never to leave none.
        const loses = others.some((t) => t.client < run.client && spansOf(text, withInside(text, [t], true, true)).length > 0);
        // The lines a line of ours lost to count against the copy only if that clash isn't settled yet (see below).
        for (const other of others) if (!(loses ? beaten : rivals).some((r) => same(r, other))) (loses ? beaten : rivals).push(other);
        if (!loses || lost.some((l) => same(l, run))) continue;
        lost.push(run);
      }
    }
    this.noteRivals(docId, rivals);
    if (lost.length === 0) return;
    // Lines this computer put in place of a losing one later (with a save that took it out) go with it.
    for (let i = 0; i < lost.length; i++) {
      for (const save of saves) {
        if (overlap(save.deleted, [lost[i]!]).length === 0) continue;
        for (const run of save.inserted) if (run.right && within([lost[i]!], run.right) && !lost.some((l) => same(l, run))) lost.push(run);
      }
    }
    // A losing line goes with whatever went inside it (what was put in front of it since may be a line of its own).
    const out = withInside(text, lost, true);
    if (spansOf(text, out).length === 0) return; // settled before
    this.noteRivals(docId, beaten);
    this.takeOut(docId, out, true);
  }

  /** Lines of others found competing with lines saved here: left out of the copy (see settle), until it is made. */
  private noteRivals(docId: DocId, rivals: IdRange[]): void {
    if (rivals.length === 0) return;
    this.rivals.set(docId, [...(this.rivals.get(docId) ?? []), ...rivals]);
    queueMicrotask(() => {
      if (!this.takeOuts.has(docId)) this.rivals.delete(docId);
    });
  }

  private takeOut(docId: DocId, out: IdRange[], copy: boolean, versions: string[] = []): void {
    const pending = this.takeOuts.get(docId);
    this.takeOuts.set(docId, { out: [...(pending?.out ?? []), ...out], copy: copy || pending?.copy === true, versions: [...(pending?.versions ?? []), ...versions] });
    queueMicrotask(() => this.settle(docId));
  }

  /**
   * Before someone else's update goes in: did it replace a line (a whole-note save, see reconcileYTextByLines) that text
   * typed here at the same moment went into? Then the save's line is kept, the same on both computers (theirs finds no
   * line of its own to give way for): what was typed inside the old line (not in front of it: that is a line of its
   * own) is taken out again here, with whatever went inside that since, and the note as it was here is kept as a copy.
   * Only text typed in this session counts.
   */
  private typedClash(state: DocState, docId: DocId, env: UpdateEnvelope | SnapshotEnvelope, bytes: Uint8Array): { version: string; strays: IdRange[] } | null {
    const typed = this.typed.get(docId);
    if (!typed || env.k !== "u" || env.author === this.node.deviceId) return null;
    let theirs: IdRange[];
    let runs: InsertedRun[];
    try {
      theirs = deletedRanges(bytes);
      runs = insertedRuns(bytes);
    } catch {
      return null;
    }
    if (theirs.length === 0 || new Set(runs.map((run) => run.client)).size !== 1) return null;
    // The lines it replaced, as they are here: each starts with a character one of its lines was put in front of.
    const starts = new Set(runs.filter((run) => run.right && within(theirs, run.right)).map((run) => `${run.right!.client}:${run.right!.clock}`));
    if (starts.size === 0) return null;
    const text = state.doc.getText("content");
    const typedInside = withInside(text, typed.inserted.filter((run) => run.right && within(theirs, run.right)), false);
    const lines = linesFrom(text, starts, theirs, [...theirs, ...typedInside]);
    const inside = typed.inserted.filter((run) => run.right && within(lines, run.right) && !starts.has(`${run.right.client}:${run.right.clock}`) && overlap([run], theirs).length === 0);
    const strays = inside.length > 0 ? withInside(text, inside, false) : [];
    const live = spansOf(text, strays).length > 0;
    if (!live && overlap(overlap(typed.deleted, theirs), lines).length === 0) return null;
    // Settled here: not counted again for another save of the same line.
    typed.inserted = typed.inserted.filter((run) => !inside.includes(run));
    typed.deleted = typed.deleted.filter((range) => overlap([range], theirs).length === 0);
    return { version: text.toString(), strays: live ? strays : [] };
  }

  /** Take out what lost a clash in a note, now; for a line saved here, the owner first gets the note as it had it. */
  private settle(docId: DocId): void {
    const pending = this.takeOuts.get(docId);
    const state = this.docs.get(docId);
    if (!pending || !state) return;
    this.takeOuts.delete(docId);
    const rivals = this.rivals.get(docId) ?? [];
    this.rivals.delete(docId);
    const text = state.doc.getText("content");
    const versions = [...pending.versions];
    if (pending.copy) {
      const version = textWithout(state.doc, withInside(text, rivals, true, true));
      if (version !== textWithout(state.doc, pending.out)) versions.push(version);
    }
    for (let i = 0; i < versions.length; i++) {
      if (this.events.clash?.(docId, versions[i]!) !== false) continue;
      // Nowhere to keep it now: nothing is taken out until there is (see restoreSaves).
      const waiting = this.waitingTakeOuts.get(docId);
      this.waitingTakeOuts.set(docId, { out: [...(waiting?.out ?? []), ...pending.out], copy: false, versions: [...(waiting?.versions ?? []), ...versions.slice(i)] });
      return;
    }
    if (this.destroyed || !this.canWrite()) return;
    const spans = spansOf(text, pending.out);
    if (spans.length === 0) return;
    // Marked while it runs: a refused edit rebuilds the note, which must not find the same clash and try again.
    this.unsettled.add(docId);
    this.settling = true;
    let result: EditResult;
    try {
      result = this.edit(docId, () => {
        for (const [at, length] of spans) text.delete(at, length);
      });
    } finally {
      this.settling = false;
    }
    if (result !== "refused") this.unsettled.delete(docId);
  }

  // ---- passing on the work of former writers ----

  /**
   * Work peers no longer take from its authors (`writes(author)` false: revoked, removed, made readers), though they did
   * it while they could, is passed on as this device's own: a snapshot of each document holding some of it, and a copy
   * of each file version of theirs still in use. Without that, a computer that catches up later would never get it.
   * One writer does it (`lead`: the first of those online); any other steps in once the work has waited a while, so
   * nothing depends on one computer. Call it now and then; once everything is passed on it does nothing.
   */
  passOnOldWork(writes: (author: string) => boolean, lead = true): void {
    if (this.destroyed || !this.canWrite() || !this.sealEpoch()) return;
    const store = this.node.store;
    const now = Date.now();
    const seen = new Map<string, number>();
    const due = (key: string) => {
      const since = this.oldSince.get(key) ?? now;
      seen.set(key, since);
      return lead || now - since >= PASS_ON_STEP_IN_MS;
    };
    for (const docId of store.docs(this.roomId)) {
      const { updates, snapshots } = store.envelopesOf(this.roomId, docId);
      const old = [...updates, ...snapshots].filter((env) => !writes(env.author)).map((env) => envelopeKey(env));
      const done = this.passedOn.get(docId);
      if (old.length === 0 || (done && old.every((key) => done.has(key))) || !due(`doc/${docId}`) || !this.isComplete(docId)) continue;
      const mine = snapshots.filter((s) => s.author === this.node.deviceId).sort((a, b) => b.seq - a.seq)[0];
      const held = mine ? this.contentsOf(mine) : null;
      if ((held && Y.equalSnapshots(held, Y.snapshot(this.loadDoc(docId).doc))) || this.snapshot(docId, true)) this.passedOn.set(docId, new Set(old));
    }
    for (const [fileId, entry] of this.files()) {
      const blob = entry.blob;
      const version = `${fileId}/${blob?.id}`;
      if (!blob || writes(blob.by) || this.passingOn.has(fileId) || this.cantPassOn.has(version) || !due(`file/${version}`)) continue;
      this.passingOn.add(fileId);
      void this.readBlob(blob)
        .then((bytes) => {
          if (!bytes || this.destroyed) return;
          const copy = this.putBlob(bytes);
          this.editIndex((files) => {
            const current = files.get(fileId);
            if (current?.blob?.by === blob.by && current.blob.id === blob.id) files.set(fileId, { ...current, blob: copy, base: blob.id });
          });
        })
        .catch((error) => {
          // Without the room key yet: tried again next time. Anything else (no room left for it) isn't retried for now.
          if (!(error instanceof SecureError && error.code === "no_room_key")) this.cantPassOn.add(version);
        })
        .finally(() => this.passingOn.delete(fileId));
    }
    this.oldSince = seen;
  }

  // ---- compaction ----

  /** Whether peers take envelopes of this device in this room now (see verifyEnvelope). */
  private writes(deviceId: string): boolean {
    const state = this.node.effective();
    const device = activeDevice(state, deviceId);
    return device !== null && roleAtLeast(roleIn(state, this.roomId, device.user), "write");
  }

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
