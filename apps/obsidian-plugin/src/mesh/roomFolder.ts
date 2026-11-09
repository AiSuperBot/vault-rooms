import { INDEX_DOC, isMarkdownPath, MAX_BYTES, MAX_NOTE_BYTES, pathKey, randomId, safeRoomPath, SecureError, type FileEntry, type RoomReplica } from "@vault-rooms/secure";
import { isScratch, isShareable, normalizeNote, sha, suffixed } from "./roomPaths.js";
import { reconcileYTextByLines } from "../crdtReconcile.js";

/**
 * Keeps one room's folder in the vault and the room's shared state in step.
 *
 * Shared -> disk: notes are written from their documents, attachments from their blobs, renames and deletions
 * follow the room index. Disk -> shared: new, changed, renamed and deleted files become index and document edits.
 * Rules that protect data, in order of importance:
 *  - Every path comes through safeRoomPath, so nothing is ever written outside the folder or into dot-folders, and only
 *    file types that can't run anything are written at all (SHARED_EXTENSIONS).
 *  - A file is only ever removed because the index says it was deleted, never because something is missing (a key
 *    that hasn't arrived, a half-loaded index), and nothing is written from a document that is only partly readable.
 *  - A file changed both here and remotely since the last sync is never overwritten silently: the local version is
 *    kept as a conflict copy next to it. For attachments that includes two versions made from the same one.
 *  - A remote deletion trashes a file only if it is unchanged here and not being worked on; otherwise it is shared again.
 *  - Only what was actually shared is remembered as synced, so a change that couldn't be shared is never overwritten.
 *  - In a room this user may only read, local changes are put back, with a copy kept, and the user is told.
 * Notes open in an editor are owned by the editor binding (live co-editing); this class doesn't write them.
 */

export interface FileStat {
  size: number;
  mtime: number;
}

export interface VaultLike {
  stat(path: string): FileStat | null;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  /** With `expected`, writes only if the current text passes it; returns whether it wrote. */
  writeText(path: string, text: string, expected?: (current: string) => boolean): Promise<boolean>;
  /** With `expected`, writes only if the current content passes it (and didn't change while it was read). */
  writeBytes(path: string, bytes: Uint8Array, expected?: (current: Uint8Array) => boolean): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  /** To a trash (never deleted outright). */
  trash(path: string): Promise<void>;
  /** Vault paths of every file under `folder`, recursively. */
  listFiles(folder: string): string[];
  folderExists(path: string): boolean;
}

/**
 * What this computer made for a file that may not be stored yet: edits of these notes (`docs`), these envelopes
 * (`keys`), or its own index changes so far (`index`), for an entry made here (`created`).
 */
interface Pending {
  docs: Set<string>;
  keys: Set<string>;
  index: boolean;
  created: boolean;
}

interface Known extends FileStat {
  path: string;
  hash: string;
  /** For attachments: the blob the local file is a copy of. */
  blob?: string;
  /** That blob was made on this computer (so another version made from an older one means a real clash). */
  mine?: true;
  /**
   * Remembered while what this computer made for it wasn't safely stored yet ("entry": its new index entry, which no one
   * else has then), or only what it received ("received": a note's edits; for an attachment, the room's index, which names
   * its version). If Obsidian stopped before it was, the shared state here may lack it: such a file isn't taken as
   * "unchanged here" until the shared version matches it, and a new entry that never got stored is made again.
   */
  unstored?: true | "entry" | "received";
  /**
   * For notes: what the shared note held when `hash` was taken from it (see RoomReplica.contentKey). While it is the
   * same and the file untouched, the note isn't loaded at all: after a restart too.
   */
  content?: string;
}

export interface RoomFolderState {
  known: Record<string, Known>;
  /** Saves of notes made here outside the editor, as stored here before 0.3.2 (now apart, see RoomFolderOptions.saveSaves). */
  saves?: unknown;
  /** Copies kept on this computer only (a reader's own versions): never shared. Plain paths as stored by 9c24618. */
  localOnly?: Array<LocalOnly | string>;
  /** Which whole state this is: changes stored on top of it name it (see RoomFolderOptions.saveStateChanges). */
  gen?: number;
  /** Changes to `localOnly` stored on top of it, in order (folded in by start, see localOnlyKey). */
  localOnlyEdits?: unknown[];
}

/** Entries changed since the state was stored whole (null: gone), and copies kept here only changed (by localOnlyKey), on top of `gen`. */
export interface RoomFolderChanges {
  gen: number;
  known: Record<string, Known | null>;
  localOnlyEdits?: Array<[string, LocalOnly | null]>;
}

/** A copy kept on this computer only: where, and its content's hash (so it is known again under another name). */
export interface LocalOnly {
  path: string;
  hash?: string;
  /** Its size: only a file of that size is read to compare (see claimedLocalOnly). */
  size?: number;
  /** When it was first found missing (ms): forgotten after LOCAL_ONLY_MISSING_MS. */
  missing?: number;
  /** Its time when the hash was taken: not read again while size and time stay (see noteLocalOnlyContent). */
  mtime?: number;
}

/** Which entry of the stored list a change is about: one still here by name, one missing by its content. */
function localOnlyKey(entry: LocalOnly): string {
  return entry.missing !== undefined ? `#${entry.hash}` : pathKey(entry.path);
}

/** See RoomFolder.health. */
export interface RoomHealth {
  /** Why the folder doesn't sync at all, if it doesn't. */
  stopped: string | null;
  /** Files whose writing, reading or trashing here failed and is being tried again (in use, a full disk). */
  failing: string[];
  /** Files whose version here couldn't be shared (too large, the room's storage full): kept as they are here. */
  heldBack: string[];
  rejected?: Array<{ path: string; reason: string }>;
  /** Files still to be written here, or whose shared content hasn't all arrived yet (0 when in step). */
  syncing: number;
}

export interface RoomFolderOptions {
  folder: string;
  replica: RoomReplica;
  vault: VaultLike;
  deviceName: string;
  /** True while an editor is bound to this note. */
  isBound(fileId: string): boolean;
  /** Paths that belong to another room's folder (never this room's). */
  inOtherRoom?(vaultPath: string): boolean;
  /** The folder itself was deleted here: stop syncing it (nothing is deleted for anyone else). */
  folderGone?(): void;
  /** A note stopped (or started) being held back: editors may be bound to it again (or not). */
  heldBackChanged?(): void;
  /** A pass over the shared state is done: notes may have become ready for an editor (keys arrived, doubts settled). */
  passed?(): void;
  /** What health() says changed: files started or stopped failing, or the folder stopped syncing. */
  healthChanged?(): void;
  loadState(): Promise<RoomFolderState | null>;
  saveState(state: RoomFolderState): Promise<void>;
  /**
   * Store only what changed, on top of the state last stored whole: loadState gives them folded in (and drops those of
   * an older whole state). Without it, every save stores the whole state.
   */
  saveStateChanges?(changes: RoomFolderChanges): Promise<void>;
  /**
   * Many files of the folder were deleted here at once while the folder is still there: whether to delete them for
   * everyone (true), or put them back (false: a move or deletion of the whole folder, say). Without it, put back.
   */
  confirmDeletions?(count: number): Promise<boolean>;
  /**
   * Recent saves of notes made here outside the editor (see RoomReplica.recentSaves), so a clash is noticed after a
   * restart too. Stored apart from the state: they change seldom.
   */
  loadSaves(): Promise<unknown>;
  saveSaves(saves: unknown): Promise<void>;
  notify(message: string): void;
  log(message: string): void;
  now?: () => Date;
}

const DELETED = "\u0000deleted";
/** Work on files that failed (a file in use, a full disk) is tried again after this, doubling up to the maximum. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 300_000;
/** A note not used for this long is unloaded (see RoomReplica.releaseIdle). */
const IDLE_NOTE_MS = 5 * 60_000;
/**
 * Deletions of the folder's files are taken as such once none has come for this long: Explorer deletes a folder file by
 * file (moving it to another drive, Shift+Delete, one too large for the Recycle Bin), and the folder itself last, which
 * makes them a hidden room, not deletions for everyone.
 */
const DELETE_QUIET_MS = 2_000;
/** Entries stored as changes on top of the whole state before it is stored whole again (see saveNow). */
const MAX_JOURNALED = 2_000;
/** A copy kept here only that went missing is known by its content this long (see LocalOnly.missing). */
const LOCAL_ONLY_MISSING_MS = 30 * 86_400_000;
/** As many as this at once, the folder still there: shared only once the user says so (see flushDeletions). */
const MASS_DELETE = 20;
/** Files taken in at once whose entries go into the file list as one change (see RoomFolder.adding). */
const ADD_AT_ONCE = 200;
/** A note changed here this recently counts as being worked on: a deletion by someone else doesn't take it away. */
const RECENT_EDIT_MS = 10 * 60_000;
/**
 * A note someone else is typing in, not open here, is written at most this often: each write is the whole file, and
 * Obsidian indexes it again. Only the file waits; the shared note here is current all along.
 */
const NOTE_WRITE_GAP_MS = 1_500;
/** A pass with at least this many files to go shows its progress (see RoomHealth.syncing). */
const SHOWN_PASS = 50;

/** Two index entries a pass writes alike (the same name, kind and attachment version). */
function sameEntry(a: FileEntry | undefined, b: FileEntry): boolean {
  return a !== undefined && a.path === b.path && a.kind === b.kind && a.blob?.id === b.blob?.id && a.blob?.by === b.blob?.by;
}

/** Told when a reader adds a file. */
const staysHere = (path: string) => `You can only read this room: "${path}" stays on this computer and isn't shared.`;

function code(error: unknown): string {
  return error instanceof SecureError ? error.code : "error";
}

/** A move of the folder's own, from one vault path to another (both, so another move from the same file can't take its place). */
function movingMark(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

export class RoomFolder {
  private known = new Map<string, Known>();
  private knownPaths = new Map<string, string>();
  /** Tracked ids by pathKey (see idAt). */
  private knownKeys = new Map<string, string>();
  /** Which files use each attachment version, for the index version it was built from (see blobUsers). */
  private blobFiles: { version: number; users: Map<string, string[]> } | null = null;
  /** Attachment versions that arrived since the last pass (see blobArrived). */
  private blobsArrived = new Set<string>();
  /** The last desired() and the index version it was built from (see materializeNow). */
  private desiredCache: { version: number; desired: Map<string, FileEntry> } | null = null;
  /** The clash renames desired() last asked for. */
  private renamesTried = "";
  /** A change made here waited for the room's file list to be read (see indexUnread): tried again once it is. */
  private waitingForIndex = false;
  /** Deletions made here meanwhile, id -> path: shared once it is read, and nothing of them written back before. */
  private unreadDeletions = new Map<string, string>();
  /** `known` changed since it was last saved (see saveNow), or only files' sizes and times did (saved at stop). */
  private stateChanged = false;
  private statChanged = false;
  /**
   * Entries changed since the last save (see saveNow), the generation of the state last stored whole, how many entries
   * were stored as changes on top of it, and whether the next save must be whole (the first of a session, and after
   * any save that failed: what is on disk is then not known for sure).
   */
  private changedIds = new Set<string>();
  private stateGen = 0;
  private journaled = 0;
  private wholeNext = true;
  private expected = new Map<string, string>();
  /** Moves this folder makes (see move and movingMark), each until its rename event comes. */
  private moving = new Set<string>();
  /**
   * Where a file stood (vault path -> id) when its rename was to be put back but it had moved on (renamed again, or
   * deleted, before the folder got to it): the event for that, which comes next, is taken for the same file.
   */
  private movedOn = new Map<string, string>();
  /** Renames the vault reported and this folder hasn't handled yet, counted by the paths they touch (see onLocalRename). */
  private renaming = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private materializeTimer: ReturnType<typeof setTimeout> | null = null;
  /** A pass is queued and hasn't started: it will see every change made until it does. */
  private passQueued = false;
  /**
   * What the next pass looks at: the notes changed since the last one (`dirty`), or every file (`everything`: at the
   * start, and when the index, a key or an attachment came in). Each change to a note reaches remoteChanged with it.
   */
  private dirty = new Set<string>();
  private everything = true;
  /** A pass that will try again what failed (see retrySoon), how long the next one waits, and what it tries again. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryIn = RETRY_FIRST_MS;
  private retryIds = new Set<string>();
  /** A removal or rename failed: the retry is a full pass. Taking in local files failed: the retry tries again. */
  private retryAll = false;
  /** The next pass is a retry's (see retrySoon). */
  private retrying = false;
  private retryWrites = new Set<string>();
  private rejected = new Map<string, string>();
  /** Versions of files kept as conflict copies since they were last synced, by path key: kept once (see keepAside). */
  private keptAside = new Map<string, { hash: string; name: string }>();
  /** Work that failed and isn't done yet (by file path, or "renames"): what went wrong. See health. */
  private failing = new Map<string, string>();
  /** Why the folder doesn't sync at all (what it last synced couldn't be read), if so. */
  private loadProblem: string | null = null;
  /**
   * The folder's files by path key (room-relative names), for untrackedCaseVariant: listed once per pass when first
   * needed, and kept up to date from the vault's events meanwhile.
   */
  private localNames: Map<string, Set<string>> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private deleteTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Deletions made here, waiting for DELETE_QUIET_MS (see onLocalDelete), counted by path: a name deleted twice before
   * the folder gets to them (another file renamed onto it in between, then deleted too) is two deletions, each taken by
   * the rename that followed it (see onLocalRename), or by the flush.
   */
  private deletions = new Map<string, number>();
  /** The same by path key (see pathKey): asked for every file a pass goes over while deletions are pending. */
  private deletedKeys = new Map<string, number>();
  /** Of those, how many a rename onto the name reported after them, and not handled yet, takes (see onLocalRename). */
  private claimedDeletions = new Map<string, number>();
  /**
   * Entries of files being taken in, to be added to the room's file list together (see adoptLocalFiles): one change,
   * sealed and signed once, for many files. Null when each file's entry goes alone (a file saved while running).
   */
  private adding: Array<{ id: string; entry: FileEntry; then: (added: ReturnType<RoomReplica["editIndex"]>) => void }> | null = null;
  /** The user is being asked whether many deletions go out (see askAboutDeletions). */
  private askingAboutDeletions = false;
  /**
   * Files missing here not written back while deletions, or renames, are pending: a folder being moved away isn't
   * refilled, a file renamed away isn't put back next to itself (see resumeWrites).
   */
  private waitingForDeletions = new Set<string>();
  /** The folder was moved, and this folder is stopping (see movedAway). */
  private movedAway = false;
  /** Local versions that couldn't be shared (too large, refused), by file id: their hash. */
  private heldBack = new Map<string, string>();
  /** Attachments changed here, by file id: when. */
  private binEdits = new Map<string, number>();
  /** Copies this device made of a reader's own changes, by room path: on this computer only, never shared (see markLocalOnly). */
  private localOnly = new Map<string, LocalOnly>();
  /**
   * Of those, ones not found where they were when the folder started (renamed while Obsidian was closed, or before the
   * folder started), by hash: a file not tracked yet with that content is taken for it, never shared (see createEntry).
   */
  private localOnlyMissing = new Map<string, LocalOnly>();
  /** Its changes since the state was stored (see saveNow), by localOnlyKey (null: gone). */
  private localOnlyEdits = new Map<string, LocalOnly | null>();

  /** By name as the disk compares names (a copy renamed by case only on Windows is the same file). */
  private isLocalOnly(vaultPath: string): boolean {
    return vaultPath.startsWith(this.prefix) && this.localOnly.has(pathKey(vaultPath.slice(this.prefix.length)));
  }

  private setLocalOnly(relative: string, hash?: string, size?: number, mtime?: number): void {
    const entry = { path: relative, ...(hash ? { hash } : {}), ...(size !== undefined ? { size } : {}), ...(hash && mtime !== undefined ? { mtime } : {}) };
    this.localOnly.set(pathKey(relative), entry);
    this.localOnlyEdits.set(pathKey(relative), entry);
    this.stateChanged = true;
  }

  private dropLocalOnly(relative: string): LocalOnly | undefined {
    const entry = this.localOnly.get(pathKey(relative));
    if (entry && this.localOnly.delete(pathKey(relative))) {
      this.localOnlyEdits.set(pathKey(relative), null);
      this.stateChanged = true;
    }
    return entry;
  }

  /** A reader's own new file: kept on this computer only, as they are told, also once they may write. */
  private async keepHere(relative: string): Promise<void> {
    this.setLocalOnly(relative);
    await this.noteLocalOnlyContent(this.vaultPath(relative));
    await this.saveNow();
    this.quietNotice(staysHere(relative));
  }

  /** A copy kept here only, edited: known by its content now if renamed while Obsidian is closed (see claimedLocalOnly). */
  private async noteLocalOnlyContent(vaultPath: string): Promise<void> {
    const relative = vaultPath.slice(this.prefix.length);
    const entry = this.localOnly.get(pathKey(relative));
    if (!entry) return;
    const stat = this.o.vault.stat(vaultPath);
    const size = stat?.size ?? 0;
    // Not changed since its hash was taken: not read again (every start looks at every copy).
    if (entry.hash && entry.size === size && entry.mtime !== undefined && entry.mtime === stat?.mtime) return;
    // A larger one is never shared whatever it holds (too large), so it isn't read.
    const bytes = size > 0 && size <= MAX_BYTES.b ? await this.o.vault.readBytes(vaultPath) : undefined;
    // Size and hash of the same read. Emptied or too large: known by name only, no old content to claim another file by.
    const [hash, length] = bytes?.length ? [sha(bytes), bytes.length] : [undefined, undefined];
    if (entry.hash === hash && entry.size === length && entry.mtime === (hash ? stat?.mtime : undefined)) return;
    this.setLocalOnly(relative, hash, length, stat?.mtime);
    this.saveSoon();
  }

  private localOnlyList(): LocalOnly[] {
    return [...this.localOnly.values(), ...this.localOnlyMissing.values()];
  }

  /** A file not tracked yet that is a copy kept here only under another name: it stays so (see localOnlyMissing). */
  private async claimedLocalOnly(relative: string): Promise<boolean> {
    if (this.localOnlyMissing.size === 0) return false;
    // Read only a file of a missing copy's size (never an empty one): no large file is read for nothing.
    const size = this.o.vault.stat(this.vaultPath(relative))?.size;
    if (!size || ![...this.localOnlyMissing.values()].some((entry) => entry.size === size)) return false;
    const hash = sha(await this.o.vault.readBytes(this.vaultPath(relative)));
    if (this.localOnlyMissing.get(hash)?.size !== size || !this.localOnlyMissing.delete(hash)) return false;
    this.localOnlyEdits.set(`#${hash}`, null);
    this.setLocalOnly(relative, hash, size);
    this.saveSoon();
    return true;
  }

  /**
   * A copy about to be written on this computer only: stored with the state first, so it stays unshared after a
   * restart, or once this user may write. If that can't be stored, the copy isn't written (the file it keeps stays as
   * it is, and is looked at again), rather than written unmarked.
   */
  private async markLocalOnly(relative: string, content: string | Uint8Array): Promise<void> {
    this.setLocalOnly(relative, sha(content), typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length);
    await this.saveNow();
  }
  private told = new Set<string>();
  /** Files remembered in this session while something made here for them was still being stored: what to check. */
  private unstoredNow = new Map<string, Pending>();
  /** Notes whose new entry had to wait for the room key, by file id: their path. Remembered (when shared) as entries made here. */
  private queuedEntries = new Map<string, string>();
  private queuedPaths = new Map<string, string>();
  /** The text a note waiting for the room key last had here (by hash): once it is out, what the shared text and the file are judged against. */
  private queuedHashes = new Map<string, string>();
  private needsAdopt = false;
  /** What was last synced is loaded: decisions can be made. */
  private started = false;
  /** The first pass after starting is done: editors may be bound. */
  private ready = false;
  private quietNoticeAt = 0;
  private stopped = false;
  /** Clash copies to keep, by file id (see noteClashed): written by the next pass, before the note itself. */
  private toKeep = new Map<string, string[]>();
  /** Notes written from the shared state, by file id: when, by performance.now() (see NOTE_WRITE_GAP_MS). */
  private noteWrites = new Map<string, number>();
  /** Notes whose writing waits for NOTE_WRITE_GAP_MS, and the pass that writes them. */
  private later = new Set<string>();
  private laterTimer: ReturnType<typeof setTimeout> | null = null;
  /** The next pass writes notes without waiting for the gap (see settled). */
  private writeNow = false;
  /** The room index changed: the next pass looks at what changed in it, and at removals and renames. */
  private indexChanged = false;
  /** Files whose shared content isn't all here yet (part of a note can't be read, an attachment hasn't arrived). */
  private incomplete = new Set<string>();
  /** Files a long pass still has to look at, and what the panel was last told (see reportProgress). */
  private left = 0;
  private reported = 0;
  private reportedAt = 0;
  /** What RoomReplica.savesChanged was when the saves were last stored. */
  private savesStored = -1;
  /** The stored saves couldn't be read when the folder started: read again before they are stored, never written over. */
  private savesUnread = false;

  constructor(private readonly o: RoomFolderOptions) {
    if (safeRoomPath(o.folder) === null) throw new Error(`"${o.folder}" can't hold a room.`);
  }

  // ---- paths ----

  private get prefix(): string {
    return `${this.o.folder}/`;
  }

  /** Room-relative path for a vault path inside the folder (null if outside, in another room's folder, or unsafe). */
  relative(vaultPath: string): string | null {
    if (!vaultPath.startsWith(this.prefix) || (!this.movedAway && this.o.inOtherRoom?.(vaultPath))) return null;
    const relative = vaultPath.slice(this.prefix.length);
    return safeRoomPath(relative) === null ? null : relative;
  }

  /** Inside the folder, but under a name that can't be shared. */
  private unsafeInside(vaultPath: string): boolean {
    return vaultPath.startsWith(this.prefix) && !this.o.inOtherRoom?.(vaultPath) && safeRoomPath(vaultPath.slice(this.prefix.length)) === null;
  }

  private vaultPath(relative: string): string {
    return `${this.o.folder}/${relative}`;
  }

  private idAt(relative: string): string | undefined {
    const exact = this.knownPaths.get(relative);
    if (exact !== undefined) return exact;
    // The same file spelled otherwise here (Windows keeps a folder's old case on disk, or another Unicode form), unless
    // the tracked spelling is a file of its own (where case counts).
    const id = this.knownKeys.get(pathKey(relative));
    return id !== undefined && !this.exactLocalPath(this.known.get(id)!.path) ? id : undefined;
  }

  private setKnown(id: string, known: Known): void {
    const old = this.known.get(id);
    if (!old || JSON.stringify({ ...old, size: 0, mtime: 0 }) !== JSON.stringify({ ...known, size: 0, mtime: 0 })) {
      this.stateChanged = true;
      this.changedIds.add(id);
    }
    else if (old.size !== known.size || old.mtime !== known.mtime) this.statChanged = true;
    this.unindex(id);
    this.known.set(id, known);
    this.knownPaths.set(known.path, id);
    this.knownKeys.set(pathKey(known.path), id);
  }

  private unindex(id: string): void {
    const old = this.known.get(id);
    if (!old) return;
    if (this.knownPaths.get(old.path) === id) this.knownPaths.delete(old.path);
    if (this.knownKeys.get(pathKey(old.path)) === id) this.knownKeys.delete(pathKey(old.path));
  }

  /** The file id of a note at a vault path, for the editor binding (none before the first pass, or while its local version is held back or in doubt). */
  noteIdAt(vaultPath: string): string | null {
    const relative = this.relative(vaultPath);
    if (relative === null || !this.ready) return null;
    const id = this.idAt(relative);
    const entry = id ? this.o.replica.entry(id) : undefined;
    return id && entry?.kind === "md" && !entry.deleted && !this.heldBack.has(id) && !this.doubtful(id) ? id : null;
  }

  /** Stop tracking a file (gone, or no longer the room's), and whatever was held back of it. */
  private forget(id: string): void {
    this.dropQueued(id);
    this.unindex(id);
    this.incomplete.delete(id);
    this.noteWrites.delete(id);
    this.queuedHashes.delete(id);
    if (this.known.delete(id)) {
      this.stateChanged = true;
      this.changedIds.add(id);
    }
    // An editor tied to it is tied again (to the copy shared under a new id, say), not left feeding a deleted note.
    const bound = this.o.isBound(id);
    if (this.heldBack.delete(id) || bound) this.o.heldBackChanged?.();
  }

  /** A new note's entry waiting for the room key (see queuedEntries) no longer stands for a file here. */
  private dropQueued(id: string): void {
    const path = this.queuedEntries.get(id);
    if (path === undefined) return;
    this.queuedEntries.delete(id);
    // (The name may be another entry's by now: a new one made there as this one was forgotten.)
    if (this.queuedPaths.get(path) === id) this.queuedPaths.delete(path);
  }

  /** Remembered in an earlier session before what was made here got stored: settled by the next pass, not by an editor. */
  private doubtful(id: string): boolean {
    return this.known.get(id)?.unstored !== undefined && !this.unstoredNow.has(id);
  }

  /** Whether a file's content (by hash) came from the shared state: what was last synced, or what is being written now. */
  fromShared(fileId: string, hash: string): boolean {
    const known = this.known.get(fileId);
    return known !== undefined && (known.hash === hash || this.expected.get(this.vaultPath(known.path)) === hash);
  }

  // ---- running ----

  /** Tasks run one at a time. Once the room's replica is gone, nothing more is done here but the final save (`last`). */
  private run(task: () => Promise<void>, last = false): Promise<void> {
    const step = () => (this.o.replica.isDestroyed && !last ? Promise.resolve() : task());
    const next = this.queue.then(step, step).catch((error: Error) => this.o.log(`room folder: ${error.stack ?? error.message}`));
    this.queue = next;
    return next;
  }

  private async readNote(path: string): Promise<string> {
    return normalizeNote(await this.o.vault.readText(path));
  }

  /** A file as a note (its text) or as bytes, by what it is shared as. */
  private readAs(path: string, asNote: boolean): Promise<string | Uint8Array> {
    return asNote ? this.readNote(path) : this.o.vault.readBytes(path);
  }

  /** One file's trouble (locked, a folder in the way, ...) mustn't stop the others. */
  private async safely(what: string, task: () => Promise<void>): Promise<boolean> {
    try {
      await task();
      if (this.failing.delete(what)) this.o.healthChanged?.();
      return true;
    } catch (error) {
      this.o.log(`room folder, ${what}: ${(error as Error).message}`);
      if (!this.failing.has(what)) this.o.healthChanged?.();
      this.failing.set(what, (error as Error).message);
      return false;
    }
  }

  /** How the folder's syncing goes, from its own work: for the panel, so trouble stays visible after a notice is gone. */
  health(): RoomHealth {
    const pathOf = (id: string) => this.known.get(id)?.path ?? this.queuedEntries.get(id) ?? id;
    return { stopped: this.loadProblem, failing: [...this.failing.keys()], heldBack: [...new Set([...this.heldBack.keys()].map(pathOf).concat([...this.rejected.keys()]))], ...(this.rejected.size ? { rejected: [...this.rejected].map(([path, reason]) => ({ path, reason })) } : {}), syncing: this.syncing() };
  }

  private syncing(): number {
    return this.incomplete.size + (this.left >= SHOWN_PASS ? this.left : 0);
  }

  /** Tell the panel how many files are left (see RoomHealth.syncing): at once when that starts or ends, else once a second. */
  private reportProgress(final = false): void {
    const syncing = this.syncing();
    if (syncing === this.reported || (!final && this.reported !== 0 && syncing !== 0 && Date.now() - this.reportedAt < 1_000)) return;
    this.reported = syncing;
    this.reportedAt = Date.now();
    this.o.healthChanged?.();
  }

  /** Try again now what failed (rather than when its next retry is due). */
  retryNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryIn = RETRY_FIRST_MS;
    this.retryIds.clear();
    this.renamesTried = "";
    if (this.rejected.size) this.needsAdopt = true;
    this.retryAll = false;
    this.everything = true;
    // Held-back files too: looked at afresh (shared now if they can be, held back again if not).
    if (this.heldBack.size > 0) {
      this.heldBack.clear();
      this.o.heldBackChanged?.();
    }
    if (this.started && !this.stopped) this.queuePass();
  }

  /**
   * Load what was last synced, then take in local files and the shared state. Nothing is decided before that: without
   * it every file would look new (and be kept as a conflict copy, or shared twice).
   */
  start(): Promise<void> {
    return this.run(async () => {
      let saved: RoomFolderState | null;
      try {
        saved = await this.o.loadState();
      } catch (error) {
        // Without it every file would look new: better not to sync this folder at all than to guess.
        this.loadProblem = `what was last synced here couldn't be read (${(error as Error).message})`;
        this.o.healthChanged?.();
        this.o.notify(`"${this.o.folder}" isn't syncing: ${this.loadProblem}. Try again from the Vault Rooms panel, or restart Obsidian.`);
        throw error;
      }
      for (const [id, known] of Object.entries(saved?.known ?? {})) this.setKnown(id, known);
      this.stateGen = typeof saved?.gen === "number" ? saved.gen : 0;
      // Copies kept on this computer only: where they still are (in any case), else known by their content later.
      const found: string[] = [];
      const listed = new Map<string, LocalOnly>();
      for (const raw of Array.isArray(saved?.localOnly) ? saved.localOnly : []) {
        const entry: LocalOnly | null = typeof raw === "string" ? { path: raw } : raw && typeof raw.path === "string" ? raw : null;
        if (entry) listed.set(localOnlyKey(entry), entry);
      }
      for (const edit of Array.isArray(saved?.localOnlyEdits) ? saved.localOnlyEdits : []) {
        if (!Array.isArray(edit) || typeof edit[0] !== "string") continue;
        const [key, entry] = edit as [string, LocalOnly | null];
        if (entry && typeof entry.path === "string") listed.set(key, entry);
        else listed.delete(key);
      }
      for (const entry of listed.values()) {
        // One found missing before is known by its content only: a file that took its name since isn't it.
        const here = entry.missing === undefined ? [...(this.localNamesNow().get(pathKey(entry.path)) ?? [])][0] : undefined;
        if (here !== undefined) {
          this.setLocalOnly(here, entry.hash, entry.size, entry.mtime);
          found.push(here);
        }
        // Missing: known by its content for a while (renamed while Obsidian was closed), not for good.
        else if (entry.hash && entry.size && Date.now() - (entry.missing ?? Date.now()) < LOCAL_ONLY_MISSING_MS) this.localOnlyMissing.set(entry.hash, { ...entry, missing: entry.missing ?? Date.now() });
      }
      // Edited while Obsidian was closed: known by what they hold now, should they be renamed later.
      for (const here of found) {
        try {
          await this.noteLocalOnlyContent(this.vaultPath(here));
        } catch {
          // Not readable now (in use): known by the content stored before, as until now, and read again at its next edit.
        }
      }
      // Stored with the state before 0.3.2, apart since. Saves that can't be read only miss a clash, never lose anything.
      this.o.replica.restoreSaves(saved?.saves);
      try {
        this.o.replica.restoreSaves(await this.o.loadSaves());
      } catch {
        this.savesUnread = true;
      }
      this.started = true;
      if (!(await this.adoptLocalFiles())) this.needsAdopt = true;
      await this.materializeNow();
      this.ready = true;
      this.o.passed?.();
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.materializeTimer, this.saveTimer, this.deleteTimer, this.retryTimer, this.laterTimer]) if (timer) clearTimeout(timer);
    this.materializeTimer = this.saveTimer = this.deleteTimer = this.retryTimer = this.laterTimer = null;
    return this.run(async () => {
      // Never loaded: the saved state stays as it was.
      if (!this.started) return;
      // Deletions made just before stopping still count, also when the folder was moved, but not when it was deleted
      // (its files went with it), nor the room. A reader's would only be put back, by the next start.
      const moved = this.movedAway && this.o.replica.canWrite();
      if (this.deletions.size > 0 && !this.o.replica.isDestroyed && (moved || this.o.vault.folderExists(this.o.folder))) await this.flushDeletions(true);
      // What this computer made is stored before the state that counts on it is saved (a stuck disk isn't waited for long).
      await Promise.race([this.o.replica.stored(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      await this.saveNow();
    }, true);
  }

  /** The folder was moved (it is stopped next, and started at its new place): deletions made just before still count. */
  folderMoved(): void {
    this.movedAway = true;
  }

  /**
   * An attachment version arrived (or was stored): the files that use it are written, by the next pass (which looks
   * them up once for every version that came meanwhile). Should none use it yet (it came before the index entry naming
   * it), the entry's arrival brings a whole pass.
   */
  blobArrived(blob: string): void {
    this.blobsArrived.add(blob);
    this.passSoon();
  }

  /** Which files use each attachment version, built again only once the index changed. */
  private blobUsers(): Map<string, string[]> {
    const version = this.o.replica.docVersion(INDEX_DOC);
    if (this.blobFiles?.version !== version) {
      const users = new Map<string, string[]>();
      for (const [id, entry] of this.o.replica.files()) {
        if (!entry.blob) continue;
        const key = `${entry.blob.by}/${entry.blob.id}`;
        const list = users.get(key);
        if (list) list.push(id);
        else users.set(key, [id]);
      }
      this.blobFiles = { version, users };
    }
    return this.blobFiles.users;
  }

  /** Call when the room index or a note (`docId`: only that one) changed remotely, or a key arrived. */
  remoteChanged(docId?: string): void {
    if (docId === INDEX_DOC) this.indexChanged = true;
    else if (docId !== undefined) this.dirty.add(docId);
    else this.everything = true;
    this.passSoon();
  }

  /** A pass in a moment: one for a burst of changes. */
  private passSoon(): void {
    if (this.stopped || this.materializeTimer) return;
    this.materializeTimer = setTimeout(() => {
      this.materializeTimer = null;
      this.queuePass();
    }, 150);
  }

  /** At most one pass waits at a time (while one runs), so a burst of changes doesn't queue a pass for each. */
  private queuePass(): void {
    if (this.passQueued) return;
    this.passQueued = true;
    void this.run(async () => {
      this.passQueued = false;
      await this.materializeNow();
    });
  }

  /**
   * Wait until everything queued so far has run (tests), notes waiting for NOTE_WRITE_GAP_MS included. Rounds are
   * capped: work that keeps making more (a bug) ends the wait rather than hanging it.
   */
  async settled(): Promise<void> {
    for (let round = 0; round < 20; round++) {
      if (this.materializeTimer) {
        clearTimeout(this.materializeTimer);
        this.materializeTimer = null;
        this.queuePass();
      }
      // Notes waiting for the gap are written now, by a pass that doesn't make them wait again (when each was written
      // is kept: the next change waits as it would).
      if (this.laterTimer) {
        clearTimeout(this.laterTimer);
        this.laterTimer = null;
        this.writeLaterNow(true);
      }
      if (this.deleteTimer) {
        clearTimeout(this.deleteTimer);
        this.deleteTimer = null;
        void this.run(() => this.flushDeletions());
      }
      await this.queue;
      if (!this.materializeTimer && !this.laterTimer && !this.deleteTimer) return;
    }
  }

  /** A note to write once NOTE_WRITE_GAP_MS has passed since it was last written (`wait` from now). */
  private writeLater(id: string, wait: number): void {
    this.later.add(id);
    if (this.laterTimer || this.stopped) return;
    this.laterTimer = setTimeout(() => {
      this.laterTimer = null;
      this.writeLaterNow();
    }, wait);
  }

  private writeLaterNow(now = false): void {
    this.writeNow ||= now;
    for (const id of this.later) this.dirty.add(id);
    this.later.clear();
    this.queuePass();
  }

  /**
   * A save of a note made here outside the editor and someone else's, made at the same moment, changed the same line,
   * and the other's was kept, or text typed here went into a line such a save replaced (see RoomReplica): `version`, the
   * note as it was here, is kept as a copy by the next pass, whether or not the note is open in an editor, and the
   * replica told then (RoomReplica.copyKept). What gave way is taken out of the note only once the copy is written, so
   * the version made here is never lost; a copy that can't be written yet is tried again by every pass.
   */
  noteClashed(fileId: string, version: string): boolean {
    if (this.stopped) return false;
    const versions = this.toKeep.get(fileId) ?? [];
    if (!versions.includes(version)) this.toKeep.set(fileId, [...versions, version]);
    this.remoteChanged(fileId);
    return false;
  }

  /**
   * Clash copies asked for (see noteClashed) are written, and the replica told, so what gave way can go. Returns whether every copy that could be written was (one that failed is tried again, see retrySoon).
   */
  private async keepClashCopies(): Promise<boolean> {
    let done = true;
    for (const [id, versions] of [...this.toKeep]) {
      const entry = this.o.replica.entry(id);
      // A note deleted meanwhile needs no copy, and nothing is taken out of it (asked again if it comes back).
      if (entry?.deleted) {
        this.toKeep.delete(id);
        continue;
      }
      // One this folder doesn't write (not in the index here yet, or under a name it doesn't share, which a copy would
      // keep) waits, both lines staying in the note.
      if (entry?.kind !== "md" || !this.writesHere(entry.path)) continue;
      for (const version of versions) {
        done =
          (await this.safely(entry.path, async () => {
            await this.keepAside(entry.path, version);
            const left = (this.toKeep.get(id) ?? []).filter((one) => one !== version);
            if (left.length > 0) this.toKeep.set(id, left);
            else this.toKeep.delete(id);
            this.o.replica.copyKept(id, version);
          })) && done;
      }
    }
    return done;
  }

  /** An editor's change to a note couldn't be shared: leave the note as it is here until its file can be shared again. */
  holdBackNote(fileId: string): void {
    this.heldBack.set(fileId, "");
  }

  private saveSoon(): void {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.run(() => this.saveNow());
    }, 500);
  }

  private async saveNow(): Promise<void> {
    // Stored meanwhile: no longer in doubt, or less (only what it received).
    for (const [id, pending] of this.unstoredNow) {
      const unstored = this.unstored(pending);
      if (!unstored) this.unstoredNow.delete(id);
      const known = this.known.get(id);
      if (known && known.unstored !== unstored) {
        this.stateChanged = true;
        this.changedIds.add(id);
      }
      if (known && unstored) known.unstored = unstored;
      else if (known) delete known.unstored;
    }
    // Written only when it changed: a room of 30,000 files is several MB of it. Sizes and times alone wait for stop: a
    // stale one only makes the next start read that file again.
    if (this.stateChanged || (this.stopped && (this.statChanged || this.journaled > 0))) {
      const [state, stat, changed, edits] = [this.stateChanged, this.statChanged, this.changedIds, this.localOnlyEdits];
      this.stateChanged = this.statChanged = false;
      this.changedIds = new Set();
      this.localOnlyEdits = new Map();
      try {
        // While someone types, only what changed is stored (a few hundred bytes, not MBs every couple of seconds); whole
        // again at stop, after a failure, and once the changes add up.
        if (this.o.saveStateChanges && !this.wholeNext && !this.stopped && this.journaled + changed.size + edits.size <= MAX_JOURNALED) {
          await this.o.saveStateChanges({ gen: this.stateGen, known: Object.fromEntries([...changed].map((id) => [id, this.known.get(id) ?? null])), ...(edits.size ? { localOnlyEdits: [...edits] } : {}) });
          this.journaled += changed.size + edits.size;
        } else {
          // A new generation: changes of the one before, still on disk, no longer count. Never one an older state had (a
          // state lost or unreadable starts again from the clock).
          this.stateGen = Math.max(this.stateGen + 1, Date.now());
          const localOnly = this.localOnlyList();
          await this.o.saveState({ gen: this.stateGen, known: Object.fromEntries(this.known), ...(localOnly.length ? { localOnly } : {}) });
          this.journaled = 0;
          this.wholeNext = false;
        }
      } catch (error) {
        this.stateChanged = state;
        this.statChanged = stat;
        for (const [key, entry] of edits) if (!this.localOnlyEdits.has(key)) this.localOnlyEdits.set(key, entry);
        for (const id of changed) this.changedIds.add(id);
        this.wholeNext = true;
        throw error;
      }
    }
    await this.storeSaves();
  }

  /**
   * The saves (see RoomReplica.recentSaves), stored apart and only when they changed; never over stored ones that
   * couldn't be read (they are read first). Saves not stored only miss a clash after a restart: a failure here never
   * stops the state being stored.
   */
  private async storeSaves(): Promise<void> {
    try {
      if (this.savesUnread) {
        this.o.replica.restoreSaves(await this.o.loadSaves());
        this.savesUnread = false;
      }
      const saves = this.o.replica.savesChanged;
      if (saves === this.savesStored) return;
      await this.o.saveSaves(this.o.replica.recentSaves());
      this.savesStored = saves;
    } catch (error) {
      this.o.log(`room folder, saves: ${(error as Error).message}`);
    }
  }

  /**
   * Remember a file as synced. What this computer made for it counts only once stored: edits of its note, and `made`,
   * the envelopes (by key) it just made for the file's entry (`created`: a new entry); and so does what it received for
   * its note. Until then the file is marked (see Known.unstored), and the mark is checked again whenever state is saved.
   * `content`: for a note whose `hash` is of the shared text, what the shared note held then (see Known.content).
   */
  private remember(id: string, path: string, hash: string, blob?: { id: string; by: string }, made: Array<string | null> = [], created = false, content?: string): void {
    const replica = this.o.replica;
    this.keptAside.delete(pathKey(path));
    // What is there is the shared file now (its content is the shared one): not one kept here only any more.
    this.dropLocalOnly(path);
    const stat = this.o.vault.stat(this.vaultPath(path));
    const pending = this.unstoredNow.get(id) ?? { docs: new Set<string>(), keys: new Set<string>(), index: false, created: false };
    // A note's text counts as to be stored also when remembered under another kind of name (left there by a refused
    // rename, see stayPut).
    if (isMarkdownPath(path) || replica.entry(id)?.kind === "md") pending.docs.add(id);
    for (const key of made) if (key) pending.keys.add(key);
    pending.created ||= created;
    const queuedPath = this.queuedEntries.get(id);
    if (this.queuedEntries.delete(id)) {
      if (queuedPath !== undefined) this.queuedPaths.delete(queuedPath);
      this.queuedHashes.delete(id);
      pending.index = pending.created = true;
    }
    const unstored = this.unstored(pending);
    if (unstored) this.unstoredNow.set(id, pending);
    else this.unstoredNow.delete(id);
    this.setKnown(id, {
      path,
      hash,
      size: stat?.size ?? -1,
      mtime: stat?.mtime ?? -1,
      ...(blob ? { blob: blob.id, ...(blob.by === replica.deviceId ? { mine: true as const } : {}) } : {}),
      ...(unstored ? { unstored } : {}),
      ...(content ? { content } : {})
    });
    if (this.rejected.delete(path)) this.o.healthChanged?.();
    // Shared again: told again should it be held back later (once per time, not per save while it is).
    this.told.delete(`held:${id}`);
    if (this.heldBack.delete(id)) this.o.heldBackChanged?.();
    this.saveSoon();
  }

  /** The file's mark while something for it isn't safely stored yet (see Known.unstored), else undefined. */
  private unstored(pending: Pending): Known["unstored"] {
    const replica = this.o.replica;
    const docs = [...pending.docs];
    const keys = [...pending.keys];
    if (pending.index) keys.push(replica.ownUpdateKey(INDEX_DOC) ?? "");
    if (replica.hasUnstored(docs, keys) || (pending.index && replica.hasUnsent(INDEX_DOC))) return pending.created ? "entry" : true;
    // A note's content is its own document; an attachment's version is named in the room's index.
    return replica.hasUnstoredReceived(docs.length > 0 ? docs : [INDEX_DOC]) ? "received" : undefined;
  }

  /** Tell the user once about something (per subject). */
  private tellOnce(subject: string, message: string): void {
    if (this.told.has(subject)) return;
    this.told.add(subject);
    this.o.notify(message);
  }

  private quietNotice(message: string): void {
    if (Date.now() - this.quietNoticeAt < 10_000) return;
    this.quietNoticeAt = Date.now();
    this.o.notify(message);
  }

  private notShared(relative: string, why: "type" | "size" | "name"): void {
    if (isScratch(relative)) return;
    const reason = {
      type: "files of this type aren't shared in rooms",
      size: `it is too large to share (notes over ${MAX_NOTE_BYTES >> 20} MB, other files over ${(MAX_BYTES.b >> 20) - 1} MB)`,
      name: "its name can't be used on every computer (too long, or with characters some systems refuse)"
    }[why];
    this.rejectLocal(relative, reason);
    // Once per kind: a folder of office files would stack a notice per file. The panel lists every one.
    this.tellOnce(`not shared:${why}`, `"${relative}" stays on this computer only: ${reason}. Others like it are listed under the room in the Vault Rooms panel.`);
  }

  private rejectLocal(path: string, reason: string): void {
    const changed = this.rejected.get(path) !== reason;
    this.rejected.set(path, reason);
    if (changed) this.o.healthChanged?.();
  }

  /** CRLF can at most double a note's bytes; keep the post-read check for growth and normalization. */
  private async fitsBeforeRead(relative: string, asNote: boolean, id?: string): Promise<boolean> {
    const stat = this.o.vault.stat(this.vaultPath(relative));
    if (!stat || (asNote ? stat.size <= 2 * MAX_NOTE_BYTES : stat.size + 16 <= MAX_BYTES.b)) return true;
    // The version last synced here (the folder's own write of a note typed past the limit, say): the room's, not a change.
    const known = id === undefined ? undefined : this.known.get(id);
    if (known?.path === relative && known.size === stat.size && known.mtime === stat.mtime) return true;
    // Nor an editor's save of a note open in it: its text went out through the editor, or is the room's (a reader's).
    if (asNote && id !== undefined && this.o.isBound(id)) return true;
    if (!id) this.notShared(relative, "size");
    else if (this.o.replica.canWrite()) this.holdBack(id, relative, `size:${stat.size}:${stat.mtime}`);
    else {
      // A reader's version: kept next to it on this computer only (moved, not read: it may be huge), as any change a
      // reader makes, and the room's version written back. Marked first, so it stays unshared after a restart too.
      const copy = this.copyName(relative, "your copy");
      this.setLocalOnly(copy, undefined, stat.size);
      await this.saveNow();
      await this.move(relative, copy);
      this.remoteChanged(id);
      this.quietNotice(`You can only read this room, so "${relative}" was put back. Your version is kept as "${copy}" on this computer only.`);
    }
    return false;
  }

  // ---- writing to disk (ours, so the resulting vault events are ignored) ----

  /** Do something to a file that its vault event will report: `mark` says what to expect, dropped if it doesn't happen. */
  private async expecting<T>(path: string, mark: string, act: () => Promise<T>, happened: (result: T) => boolean = () => true): Promise<T> {
    this.expected.set(path, mark);
    try {
      const result = await act();
      if (!happened(result)) this.expected.delete(path);
      return result;
    } catch (error) {
      // Failed (in use, a full disk): a later change by someone else isn't taken for ours.
      this.expected.delete(path);
      throw error;
    }
  }

  /**
   * Write shared content as ours, only if what is there now has the hash `basedOn` (when given) and `unless` doesn't
   * hold (checked as it is written). Returns whether it wrote. `hash`: the content's, which the caller has already (a
   * large file isn't hashed twice).
   */
  private writeShared(relative: string, content: string | Uint8Array, hash: string, basedOn?: string, unless?: () => boolean): Promise<boolean> {
    const path = this.vaultPath(relative);
    const write = () =>
      typeof content === "string"
        ? this.o.vault.writeText(path, content, (current) => !unless?.() && (basedOn === undefined || sha(normalizeNote(current)) === basedOn))
        : this.o.vault.writeBytes(path, content, (current) => !unless?.() && (basedOn === undefined || sha(current) === basedOn));
    return this.expecting(path, hash, write, (wrote) => wrote);
  }

  /** A copy kept next to a file (not marked as ours: the vault event shares it, or localOnly keeps it here). */
  private writeCopy(vaultPath: string, content: string | Uint8Array): Promise<boolean> {
    return typeof content === "string" ? this.o.vault.writeText(vaultPath, content) : this.o.vault.writeBytes(vaultPath, content);
  }

  private trash(relative: string): Promise<void> {
    const path = this.vaultPath(relative);
    return this.expecting(path, DELETED, () => this.o.vault.trash(path));
  }

  /** A file gone from this name: its marks (kept here only, not shared) go with it. */
  private dropMarks(vaultPath: string): void {
    if (!vaultPath.startsWith(this.prefix)) return;
    this.dropLocalOnly(vaultPath.slice(this.prefix.length));
    if (this.rejected.delete(vaultPath.slice(this.prefix.length))) this.o.healthChanged?.();
  }

  /**
   * Move a file, its rename event marked as ours apart from the marks of writes: a new file written at the old name in
   * the same pass must not make this move look like the user's (and the new file be renamed for everyone).
   */
  private async move(from: string, to: string): Promise<void> {
    const [oldPath, newPath] = [this.vaultPath(from), this.vaultPath(to)];
    const mark = movingMark(oldPath, newPath);
    this.moving.add(mark);
    try {
      await this.o.vault.rename(oldPath, newPath);
    } catch (error) {
      this.moving.delete(mark);
      throw error;
    }
  }

  /** A free name next to `relative` for a copy of a file that would otherwise be lost (one safe path segment). */
  private copyName(relative: string, label: string): string {
    // In this computer's time, as people read clocks here.
    const at = this.o.now?.() ?? new Date();
    const two = (n: number) => String(n).padStart(2, "0");
    const stamp = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}${two(at.getMinutes())}`;
    const device = this.o.deviceName.replace(/[\\/:*?"<>|.]/g, "").trim().slice(0, 40) || "this computer";
    for (let i = 1; ; i++) {
      const candidate = suffixed(relative, `${label} ${device} ${stamp}${i > 1 ? ` ${i}` : ""}`);
      if (!candidate) throw new Error("No safe name for a recovery copy");
      if (!this.o.vault.stat(this.vaultPath(candidate)) && !this.o.vault.folderExists(this.vaultPath(candidate)) && !this.localNamesNow().get(pathKey(candidate))?.size) return candidate;
    }
  }

  private async keepAside(relative: string, content: string | Uint8Array): Promise<string> {
    // This very version is kept already (by a try that failed after it, say), and the copy is still there: not again.
    const hash = sha(content);
    const kept = this.keptAside.get(pathKey(relative));
    if (kept?.hash === hash && this.o.vault.stat(this.vaultPath(kept.name))) return kept.name;
    const name = this.copyName(relative, "conflict");
    // Writers share the copy as a local addition; readers keep it on this computer, and so does anyone for a copy of a
    // file that was itself kept on this computer only.
    const here = !this.o.replica.canWrite() || this.isLocalOnly(this.vaultPath(relative));
    if (here) await this.markLocalOnly(name, content);
    await this.writeCopy(this.vaultPath(name), content);
    this.keptAside.set(pathKey(relative), { hash, name });
    this.o.notify(`"${relative}" was changed here and by someone else at the same time. Your version is kept as "${name}"${here ? " on this computer only" : ", which the others get too"}: compare the two, and delete the one you don't need.`);
    return name;
  }

  /** An untracked file in a shared one's way: moved to a conflict name, not read (it may be huge), then shared as a new file or kept here. */
  private async moveAside(relative: string): Promise<void> {
    const name = this.copyName(relative, "conflict");
    const here = !this.o.replica.canWrite() || this.isLocalOnly(this.vaultPath(relative));
    if (here) {
      const entry = this.localOnly.get(pathKey(relative));
      this.setLocalOnly(name, entry?.hash, entry?.size, entry?.mtime);
      await this.saveNow();
    }
    await this.move(relative, name);
    this.dropMarks(this.vaultPath(relative));
    // Shared as a new file; one that can't be taken in now is tried again, as a failed save is (see retryWrites).
    if (!here && !(await this.safely(name, () => this.createEntry(name)))) {
      this.retryWrites.add(this.vaultPath(name));
      this.retrySoon();
    }
    const shared = !here && (this.idAt(name) ?? this.queuedPaths.get(name)) !== undefined;
    this.o.notify(`"${relative}" was changed here and by someone else at the same time. Your version is kept as "${name}"${here ? " on this computer only" : shared ? ", which the others get too" : ""}: compare the two, and delete the one you don't need.`);
  }

  // ---- shared -> disk ----

  /** The paths files should have here: index paths, with deterministic suffixes when two entries collide. */
  private desired(): Map<string, FileEntry> {
    const groups = new Map<string, Array<[string, FileEntry]>>();
    for (const [id, entry] of this.o.replica.files()) {
      if (!this.writesHere(entry.path) || this.unreadDeletions.has(id)) continue;
      const key = pathKey(entry.path);
      groups.set(key, [...(groups.get(key) ?? []), [id, entry]]);
    }
    const out = new Map<string, FileEntry>();
    const renames: Array<[string, FileEntry, string]> = [];
    // A new name fits every limit and is no other file's (nor one given just before): with the id's start, longer if
    // that is taken. Groups go in a fixed order, so every device names them alike.
    const taken = new Set(groups.keys());
    const clashing: string[] = [];
    for (const [key, group] of groups) {
      if (group.length === 1) out.set(group[0]![0], group[0]![1]);
      else clashing.push(key);
    }
    for (const key of clashing.sort()) {
      const group = groups.get(key)!.sort(([a], [b]) => (a < b ? -1 : 1));
      group.forEach(([id, entry], index) => {
        if (index === 0) return out.set(id, entry);
        const path = [id.slice(1, 5), id.slice(1, 9), id.slice(1)].map((tag) => suffixed(entry.path, tag)).find((name) => name !== null && !taken.has(pathKey(name)));
        // No name fits (its folders already fill the path): not written here, rather than over the other file.
        if (!path) return;
        taken.add(pathKey(path));
        out.set(id, { ...entry, path });
        renames.push([id, entry, path]);
      });
    }
    // Writers settle the clash for everyone, the same way on every device. The same renames aren't asked again (a
    // refused edit rebuilds the whole index; one waiting for the key would be queued twice), until Try again, or
    // until a clash comes back once settled.
    const tried = JSON.stringify(renames.map(([id, , path]) => [id, path]));
    if (renames.length === 0) this.renamesTried = "";
    else if (this.o.replica.canWrite() && tried !== this.renamesTried) {
      this.renamesTried = tried;
      this.o.replica.editIndex((files) => {
        for (const [id, entry, path] of renames) files.set(id, { ...entry, path });
      });
    }
    return out;
  }

  /** Whether this folder writes a file at a room path: one of a type rooms share, not in another room's folder. */
  private writesHere(relative: string): boolean {
    return isShareable(relative) && !this.o.inOtherRoom?.(this.vaultPath(relative));
  }

  private async materializeNow(): Promise<void> {
    if (this.stopped || !this.started) return;
    // The room's file list has been read since a change here waited for it: what waited goes ahead, in a whole pass.
    if (this.waitingForIndex && !this.o.replica.historyUnread(INDEX_DOC)) {
      this.waitingForIndex = false;
      const deletions = [...this.unreadDeletions];
      this.unreadDeletions.clear();
      for (const [id, relative] of deletions) this.shareDeletion(id, relative);
      // This pass goes over everything (it reads the flags below): files turned away and clash renames refused meanwhile.
      this.everything = true;
      this.renamesTried = "";
      if (this.rejected.size) this.needsAdopt = true;
    }
    const { everything, dirty, retrying } = this;
    const tidy = everything || this.indexChanged;
    const writeNow = this.writeNow;
    this.writeNow = false;
    this.everything = this.retrying = this.indexChanged = false;
    this.dirty = new Set();
    if (this.blobsArrived.size > 0) {
      const users = this.blobUsers();
      for (const blob of this.blobsArrived) for (const id of users.get(blob) ?? []) dirty.add(id);
      this.blobsArrived.clear();
    }
    if (everything) this.localNames = null;
    // Clash copies first: a note waiting for its copy is written once it is kept (and what gave way is gone).
    let done = await this.keepClashCopies();
    for (const path of [...this.retryWrites]) {
      this.retryWrites.delete(path);
      if (!(await this.safely(path.slice(this.prefix.length), () => this.localWrite(path)))) this.retryWrites.add(path);
      // Failed, or put back to wait (see localWrite): not done, so the retries keep backing off.
      if (this.retryWrites.has(path)) done = false;
    }
    // Entries that waited for the room key and are gone from the file list (reloaded after a refused change), or
    // deleted by someone else before any text of ours was in them: their files are taken in again, as new ones. One
    // deleted after our text went out but before it was remembered here (held back, say) is removed as a known one is:
    // trashed if unchanged, kept and shared anew if worked on here, tried again if that fails (it stays tracked).
    if (tidy) {
      for (const id of [...this.queuedEntries.keys()]) {
        const entry = this.o.replica.entry(id);
        const anew = () => { this.forget(id); this.needsAdopt = true; };
        if (!entry) anew();
        else if (entry.deleted) {
          if (this.o.replica.ownUpdateKey(id) === null) anew();
          else {
            const path = this.queuedEntries.get(id)!;
            if (!(await this.safely(path, () => this.applyRemoval(id, { path, hash: this.queuedHashes.get(id) ?? "", size: -1, mtime: -1 })))) {
              this.retryAll = true;
              done = false;
            }
          }
        }
      }
    }
    const replica = this.o.replica;
    // Built anew by a whole pass, and whenever the index changed: a pass for one note doesn't go over every file.
    const version = replica.docVersion(INDEX_DOC);
    const previous = this.desiredCache;
    const desired = everything || previous?.version !== version ? this.desired() : previous.desired;
    this.desiredCache = { version, desired };
    // Removals and renames only from a fully readable index: a gap there is never taken for a deletion.
    // Files a tidy pass moves are looked at by it too: their content may have changed while they waited for the move.
    const moved: string[] = [];
    if (tidy && replica.isComplete(INDEX_DOC)) {
      for (const [id, entry] of desired) if (this.known.has(id) && this.known.get(id)!.path !== entry.path) moved.push(id);
      const entries = replica.entries();
      let whole = true;
      for (const [id, known] of [...this.known]) {
        if (entries.get(id)?.deleted) whole = (await this.safely(known.path, () => this.applyRemoval(id, known))) && whole;
        else if (!entries.has(id) && this.doubtful(id) && known.unstored === "entry") {
          // Shared in a session that ended before its new entry was stored, so no one has it: shared again.
          this.forget(id);
          this.needsAdopt = true;
        }
      }
      whole = (await this.safely("renames", () => this.applyRenames(desired))) && whole;
      // What failed (a file in use, say) is looked at again by the full pass of the next retry (see retrySoon).
      if (!whole) {
        this.retryAll = true;
        done = false;
      }
    }
    // Whose each local name is, once the renames are done: a file still tracked as another's (whose rename or removal
    // is still to come, a file in the way being in use) is never taken for this one, nor written over.
    const owners = tidy ? new Map([...this.known].map(([id, known]) => [pathKey(known.path), id] as const)) : this.knownKeys;
    // Files waiting for the room key stand where the user left them (see stayPut): theirs too, by key.
    const queuedKeys = new Map([...this.queuedPaths].map(([path, id]) => [pathKey(path), id] as const));
    // A pass for some notes goes over those only, and one for a change of the index over the files it changed (desired
    // is compared with the one before, not each file looked at).
    const some = new Set([...dirty, ...this.toKeep.keys(), ...moved]);
    // Files no longer to be written here (deleted, moved to another room) aren't waited for.
    for (const id of this.incomplete) if (!desired.has(id)) this.incomplete.delete(id);
    if (!everything && previous && previous.desired !== desired) for (const [id, entry] of desired) if (!sameEntry(previous.desired.get(id), entry)) some.add(id);
    const ids = everything || !previous ? [...desired.keys()] : [...some].filter((id) => desired.has(id));
    // A steady clock: setting the computer's clock back mustn't make a note wait for hours.
    const now = performance.now();
    this.left = ids.length;
    for (const id of ids) {
      // Stopped meanwhile (moved, deleted, the plugin updated): nothing more is written, least of all at the old path.
      if (this.stopped) break;
      this.left--;
      this.reportProgress();
      const entry = desired.get(id)!;
      const wait = (this.noteWrites.get(id) ?? -Infinity) + NOTE_WRITE_GAP_MS - now;
      if (wait > 0 && !writeNow && dirty.has(id) && !moved.includes(id) && entry.kind === "md" && !this.toKeep.has(id)) {
        this.writeLater(id, wait);
        continue;
      }
      // The file at its name may be another's: known there, or waiting for the room key there.
      const owner = owners.get(pathKey(entry.path)) ?? queuedKeys.get(pathKey(entry.path));
      // One that failed (a file in use, say), or must wait for another, is tried again by the next retry.
      if ((owner !== undefined && owner !== id) || !(await this.safely(entry.path, () => this.applyContent(id, entry)))) {
        this.retryIds.add(id);
        done = false;
      }
    }
    if (this.needsAdopt && replica.canWrite()) {
      this.needsAdopt = false;
      done = (await this.adoptLocalFiles()) && done;
    }
    // Work that failed is tried again by itself, soon at first and less often while it keeps failing: back to the first
    // delay only when a retry's own pass goes fine (other passes may well go fine meanwhile).
    if (!done) this.retrySoon();
    else if (retrying) this.retryIn = RETRY_FIRST_MS;
    // A whole pass without trouble: whatever failed before (for a file gone since, say) isn't failing any more.
    if (done && everything && this.failing.size > 0) {
      this.failing.clear();
      this.o.healthChanged?.();
    }
    this.left = 0;
    this.reportProgress(true);
    if (this.noteWrites.size > 1_000) for (const [id, at] of this.noteWrites) if (now - at >= NOTE_WRITE_GAP_MS) this.noteWrites.delete(id);
    this.saveSoon();
    // Notes untouched for a while are let go (memory): loaded again when they change or are opened.
    this.o.replica.releaseIdle(IDLE_NOTE_MS, (id) => this.o.isBound(id) || this.toKeep.has(id));
    if (this.ready) this.o.passed?.();
  }

  /** What failed is tried again by a pass of its own, on this schedule only (passes for other changes stay small). */
  private retrySoon(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retrying = true;
      for (const id of this.retryIds) this.dirty.add(id);
      this.retryIds.clear();
      if (this.retryAll) this.everything = true;
      this.retryAll = false;
      this.queuePass();
    }, this.retryIn);
    this.retryIn = Math.min(this.retryIn * 2, RETRY_MAX_MS);
  }

  private async applyRenames(desired: Map<string, FileEntry>): Promise<void> {
    const moves = new Map<string, { from: string; to: string }>();
    for (const [id, entry] of desired) {
      const known = this.known.get(id);
      if (!known || known.path === entry.path || !this.o.vault.stat(this.vaultPath(known.path))) continue;
      // Not onto a name whose deletion here is pending, nor from or onto one the user is renaming: what stands at those
      // names is in flux, and the deletion or rename must find the file it was made on. The move waits (see resumeWrites).
      if (this.deletionPendingAt(entry.path) || this.renaming.has(this.vaultPath(entry.path)) || this.renaming.has(this.vaultPath(known.path))) this.waitingForDeletions.add(id);
      else moves.set(id, { from: known.path, to: entry.path });
    }
    while (moves.size > 0 && !this.stopped) {
      let progressed = false;
      for (const [id, { from, to }] of moves) {
        if (this.stopped) return;
        // Taken as the disk compares names (Windows refuses a name another file has in another case): by the folder's
        // names, the file itself aside (a move that only changes its case).
        if ([...(this.localNamesNow().get(pathKey(to)) ?? [])].some((name) => name !== from)) continue;
        await this.move(from, to);
        this.setKnown(id, { ...this.known.get(id)!, path: to });
        moves.delete(id);
        progressed = true;
      }
      if (progressed) continue;
      // Every target is taken: a swap or a file in the way. Move one aside under a visible temporary name.
      const [, move] = moves.entries().next().value as [string, { from: string; to: string }];
      // The name in the way as it is here (another case, on Windows), not as the move spells it.
      const inWay = [...(this.localNamesNow().get(pathKey(move.to)) ?? [])].find((name) => name !== move.from) ?? move.to;
      // A file waiting for the room key is tracked there too (see queuedPaths): the renames wait for it as well.
      const occupant = this.idAt(inWay) ?? this.queuedPaths.get(inWay);
      if (occupant && moves.has(occupant)) {
        const from = moves.get(occupant)!.from;
        const temporary = this.copyName(from, `moving ${occupant.slice(1, 5)}`);
        await this.move(from, temporary);
        this.setKnown(occupant, { ...this.known.get(occupant)!, path: temporary });
        moves.set(occupant, { from: temporary, to: moves.get(occupant)!.to });
      } else if (occupant) {
        // Another file is still tracked there (its removal to come: in use, say): the renames wait for it (retried).
        throw new Error(`"${move.to}" is still another file's here`);
      } else {
        // An untracked local file is in the way: keep it under a conflict name.
        await this.moveAside(inWay);
      }
    }
  }

  /** Local names by pathKey: listed once per pass, then kept current by vault events (see noteLocal). */
  private localNamesNow(): Map<string, Set<string>> {
    if (!this.localNames) {
      this.localNames = new Map();
      for (const path of this.o.vault.listFiles(this.o.folder)) this.noteLocal(path, true);
    }
    return this.localNames;
  }

  /** A file here whose name differs from `relative` only in case (the same file on Windows and macOS), if untracked (nor waiting for the room key there). */
  private untrackedCaseVariant(relative: string): string | null {
    for (const other of this.localNamesNow().get(pathKey(relative)) ?? []) if (other !== relative && !this.idAt(other) && !this.queuedPaths.has(other) && this.o.vault.stat(this.vaultPath(other))) return other;
    return null;
  }

  private exactLocalPath(relative: string): boolean {
    return this.localNamesNow().get(pathKey(relative))?.has(relative) ?? false;
  }

  /** Keep localNames (when listed) in step with a file of the folder appearing or going away. */
  private noteLocal(vaultPath: string, present: boolean): void {
    const relative = this.localNames ? this.relative(vaultPath) : null;
    if (relative === null) return;
    const key = pathKey(relative);
    const names = this.localNames!.get(key) ?? new Set<string>();
    if (present) this.localNames!.set(key, names.add(relative));
    else names.delete(relative);
  }

  private async applyContent(id: string, entry: FileEntry): Promise<void> {
    const replica = this.o.replica;
    this.incomplete.delete(id);
    const path = this.vaultPath(entry.path);
    const known = this.known.get(id);
    if (entry.kind === "md" && this.o.isBound(id)) return;
    // A local version that couldn't be shared stays as it is, never written over (see holdBack).
    if (this.heldBack.has(id)) return;
    // Deleted here moments ago, and something at its name again already (another file renamed onto it, or saved again
    // by deleting and writing): what that is settles with the deletion (see onLocalRename, applyLocalDelete), not here.
    if (this.o.vault.stat(path) && this.deletionPendingAt(entry.path)) {
      this.waitingForDeletions.add(id);
      return;
    }
    // Not under its new name here yet (another file in the way couldn't be moved or trashed): what is at the new name
    // isn't this file, and is never taken for it. The renames are tried again.
    if (known && known.path !== entry.path && this.o.vault.stat(this.vaultPath(known.path))) return;
    // Its own file is on the move (a rename of it still to be handled, see inFlight): what stands at its name, if
    // anything, is another file. Waits with the work held for pending deletions, resumed once that rename placed it.
    if (this.inFlight(id, path)) {
      this.waitingForDeletions.add(id);
      return;
    }
    // The same file spelled otherwise here (see idAt): given the shared spelling first, so it is read and written as
    // itself, not kept aside as someone else's or written again next to itself.
    if (!this.o.vault.stat(path)) {
      const here = [...(this.localNamesNow().get(pathKey(entry.path)) ?? [])].find((other) => other !== entry.path && this.idAt(other) === id);
      if (here) await this.move(here, entry.path);
    }
    // Left from a session that may have ended before what it made was stored: proven only by a matching shared copy.
    const doubtful = this.doubtful(id);
    /** The file is as it was when last synced (by its size and time). */
    const unchanged = (stat: FileStat | null) => stat !== null && !doubtful && known?.path === entry.path && known.size === stat.size && known.mtime === stat.mtime;
    let remote: string | Uint8Array | null;
    let content: string | undefined;
    if (entry.kind === "md") {
      // The shared note holds what it held when last synced, and the file is untouched since: nothing to do, without
      // even loading it (tens of thousands of notes after a restart).
      content = replica.contentKey(id);
      if (known?.content === content && !replica.hasUnsent(id) && !this.toKeep.has(id) && unchanged(this.o.vault.stat(path))) return;
      // Part of the note can't be read yet, or our own edit is waiting for the room key: nothing to decide on yet.
      if (!replica.isComplete(id)) {
        // Waiting for a room key isn't counted as to go: the panel says the room waits for a key.
        if (!replica.waitsForKey(id)) this.incomplete.add(id);
        return;
      }
      if (replica.hasUnsent(id)) return;
      remote = normalizeNote(replica.noteText(id));
      // Remembered with the text only when the text is all of what the store holds (it may lag a moment behind).
      content = replica.syncedKey(id);
      // A clash copy to keep first (asked for as the note loaded, maybe): never written with both lines meanwhile.
      if (this.toKeep.has(id)) return;
    } else {
      // The same version as last synced, and the file untouched since: nothing to read (attachments can be large).
      if (known?.blob === entry.blob?.id && unchanged(this.o.vault.stat(path))) return;
      remote = entry.blob ? await replica.readBlob(entry.blob) : null;
    }
    // The attachment hasn't arrived yet: its arrival brings a pass.
    if (remote === null) {
      this.incomplete.add(id);
      return;
    }
    const remoteHash = sha(remote);
    const stat = this.o.vault.stat(path);
    if (stat && !(await this.fitsBeforeRead(entry.path, entry.kind === "md", id))) return;
    if (!stat) {
      // Deletions are pending here (Explorer moving the folder away, file by file, say): nothing is put back into it
      // meanwhile, so the folder can go; looked at again once they are settled (see resumeWrites).
      if (this.deletions.size > 0 || this.askingAboutDeletions) {
        this.waitingForDeletions.add(id);
        return;
      }
      const variant = this.untrackedCaseVariant(entry.path);
      if (variant) await this.moveAside(variant);
      // Its file stands where the user left it while its entry waited for the room key (see stayPut): moved to its
      // shared name rather than written anew beside it, and looked at there by the next pass (below: a differing file
      // is the user's version, unless the shared text moved on).
      const at = this.queuedEntries.get(id);
      if (at !== undefined && at !== entry.path && this.o.vault.stat(this.vaultPath(at))) {
        await this.move(at, entry.path);
        this.dropQueued(id);
        this.queuedEntries.set(id, entry.path);
        this.queuedPaths.set(entry.path, id);
        return this.remoteChanged(id);
      }
      return this.write(id, entry, remote, remoteHash, undefined, content);
    }
    const unchangedHere = known !== undefined && unchanged(stat);
    if (unchangedHere) {
      if (remoteHash === known.hash) {
        // The same bytes in another blob (a writer passing on someone else's file, say): remembered, so it isn't read again.
        if (entry.blob && entry.blob.id !== known.blob) this.remember(id, entry.path, remoteHash, { id: entry.blob.id, by: known.mine ? replica.deviceId : "" });
        // The same text as remembered: from now on known without loading it (see Known.content).
        else if (content !== undefined && known.content !== content) this.setKnown(id, { ...known, content });
        return;
      }
      // Another version of an attachment made from an older one than the version this computer made (two people
      // changed it at once): keep ours. A version of someone else's that we merely had is just older.
      if (entry.kind === "bin" && known.mine && entry.blob && entry.blob.id !== known.blob && entry.base !== known.blob) await this.keepAside(entry.path, await this.o.vault.readBytes(path));
      return this.write(id, entry, remote, remoteHash, known.hash, content);
    }
    const local = await this.readAs(path, entry.kind === "md");
    // Deleted while being read (and something else there now, maybe): as above.
    if (this.deletionPendingAt(entry.path)) {
      this.waitingForDeletions.add(id);
      return;
    }
    // The shared note moved on while the file was read (someone's edit came in): what was taken for the shared text is
    // stale, and a change made here would be put over their edit. Decided again on what the note holds now.
    if (entry.kind === "md" && sha(normalizeNote(replica.noteText(id))) !== remoteHash) return this.remoteChanged(id);
    const localHash = sha(local);
    if (localHash === remoteHash) return this.remember(id, entry.path, remoteHash, entry.blob, [], false, content);
    // A differing file at a key-waiting note's own name (moved there from where a refused rename left it, see above) is
    // the user's version of it, unless the shared text moved on since the note was queued (someone's edit came in):
    // then, as for any file changed on both sides, theirs wins and the user's version is kept aside.
    if (!known && this.queuedEntries.get(id) === entry.path) {
      // Judged against the baseline only once this computer's own text is out. Before that (its first publish refused,
      // say, and the note reloaded empty), whatever the note holds is someone else's: an empty note takes the file,
      // text in it wins and the file is kept aside.
      const base = this.queuedHashes.get(id);
      const out = replica.ownUpdateKey(id) !== null;
      if (base === undefined || remoteHash === base || (!out && remote.length === 0)) return this.localChanged(id, entry, local, localHash);
      if (!out ? local.length > 0 : localHash !== base) await this.keepAside(entry.path, local);
      return this.write(id, entry, remote, remoteHash, localHash, content);
    }
    if (!known || (localHash === known.hash && !doubtful)) {
      // Nothing changed here since the last sync (or a file we never tracked sits at this path): the shared copy wins,
      // but an untracked file with content is kept aside first.
      if (!known && local.length > 0) await this.keepAside(entry.path, local);
      return this.write(id, entry, remote, remoteHash, localHash, content);
    }
    if (remoteHash === known.hash && !doubtful) {
      // Only changed here (e.g. while Obsidian was closed): share the local version, unless it is already held back.
      if (this.heldBack.get(id) === localHash) return;
      return this.localChanged(id, entry, local, localHash);
    }
    // Changed on both sides since the last sync.
    await this.keepAside(entry.path, local);
    await this.write(id, entry, remote, remoteHash, localHash, content);
  }

  /**
   * Write the shared version, only if the file is still what the decision was based on (checked as it is written).
   * `content`: the note's content key, when `remote` is all of what its store holds (see RoomReplica.syncedKey).
   */
  private async write(id: string, entry: FileEntry, remote: string | Uint8Array, remoteHash: string, basedOn?: string, content?: string): Promise<void> {
    // Changed meanwhile (saved again while its copy was being kept, say), or an editor bound meanwhile (which owns the
    // note now): left as it is and looked at again next time.
    const wrote = await this.writeShared(entry.path, remote, remoteHash, basedOn, () => this.o.isBound(id));
    if (wrote && entry.kind === "md") this.noteWrites.set(id, performance.now());
    // The shared file is there now, not a copy kept here only (that was kept aside first, see keepAside).
    if (wrote) this.dropLocalOnly(entry.path);
    if (wrote) this.remember(id, entry.path, remoteHash, entry.blob, [], false, content);
    else if (!this.o.isBound(id)) {
      const known = this.known.get(id);
      if (known) this.setKnown(id, { ...known, mtime: -1 });
      throw new Error("The file changed while syncing; retrying with its current content.");
    }
  }

  private lastEdit(id: string, entry: FileEntry): number {
    return entry.kind === "md" ? this.o.replica.lastLocalEdit(id) : (this.binEdits.get(id) ?? 0);
  }

  private async applyRemoval(id: string, known: Known): Promise<void> {
    const path = this.vaultPath(known.path);
    const stat = this.o.vault.stat(path);
    const entry = this.o.replica.entry(id);
    // Whether the others ever had this version is in doubt (see Known.unstored): it counts as a change made here. One
    // only received was theirs.
    const busy = (this.doubtful(id) && known.unstored !== "received") || (entry !== undefined && Date.now() - this.lastEdit(id, entry) < RECENT_EDIT_MS);
    // Forgotten only once the file is dealt with: one that can't be read or trashed now (in use, say) stays tracked, and
    // is tried again, rather than being left behind untracked and shared again as a new file. Nor is one renamed away
    // by a rename not handled yet forgotten: that tracks it under its new name, and the removal is looked at again.
    if (!stat && this.inFlight(id, path)) {
      this.waitingForDeletions.add(id);
      return;
    }
    if (!stat) return this.forget(id);
    const current = await this.readAs(path, entry ? entry.kind === "md" : isMarkdownPath(known.path));
    // Deleted here moments ago (before or while being read), and something there now: what that is settles with the
    // deletion (see applyContent); the removal is looked at again then.
    if (this.deletionPendingAt(known.path)) {
      this.waitingForDeletions.add(id);
      return;
    }
    const unchanged = !busy && sha(current) === known.hash;
    if (unchanged) {
      await this.trash(known.path);
      this.forget(id);
      return;
    }
    // Changed here after someone else removed it, or being worked on here: keep it, and share it again as a new file.
    this.forget(id);
    if (!this.o.replica.canWrite()) return;
    await this.createEntry(known.path);
    this.o.notify(`"${known.path}" was deleted by someone else while you were working on it here. Your copy stays, and is shared again.`);
  }

  // ---- disk -> shared ----

  /**
   * Files in the folder that aren't tracked yet become shared files (when this user may write). Returns whether every
   * file was taken in that could be (one that failed, unreadable say, is tried again).
   */
  private async adoptLocalFiles(): Promise<boolean> {
    // A reader's files not shared: kept here by name (their content is read at their next edit, or the next start).
    const reader = !this.o.replica.canWrite();
    // Paths shared or tracked here, by key: looked up per file, so built once (not a scan per file).
    const tracked = new Map<string, Set<string>>();
    const track = (path: string) => tracked.set(pathKey(path), (tracked.get(pathKey(path)) ?? new Set<string>()).add(path));
    for (const file of [...this.o.replica.files().values(), ...this.known.values()]) track(file.path);
    for (const path of this.queuedEntries.values()) track(path);
    const paths = this.o.vault.listFiles(this.o.folder);
    const present = new Set(paths.map((path) => path.slice(this.prefix.length)));
    for (const path of this.rejected.keys()) if (!present.has(path)) { this.rejected.delete(path); this.o.healthChanged?.(); }
    let done = true;
    this.left = paths.length;
    // The entries of the files taken in go into the file list a batch at a time (see adding): sharing a folder of
    // thousands of notes is one sealed, signed change per batch rather than per note.
    const adding: NonNullable<typeof this.adding> = (this.adding = []);
    try {
      for (const path of paths) {
        if (this.stopped) break;
        this.left--;
        this.reportProgress();
        // One that came by a rename not handled yet is tracked by that (under its new name, or put back), not as new.
        if (this.o.inOtherRoom?.(path) || this.isLocalOnly(path) || this.renaming.has(path)) continue;
        const relative = this.relative(path);
        if (relative === null) {
          if (this.unsafeInside(path)) this.notShared(path.slice(this.prefix.length), "name");
          continue;
        }
        // Tracked under this name, or under another spelling that isn't a file of its own here (the same file then).
        const spellings = tracked.get(pathKey(relative));
        if (spellings && (spellings.has(relative) || ![...spellings].some((other) => present.has(other)))) continue;
        if (reader) {
          this.setLocalOnly(relative);
          continue;
        }
        const before = this.known.size + adding.length;
        // One that can't be taken in now (in use) is tried again with every pass, as a failed save is (see retryWrites).
        if (!(await this.safely(relative, () => this.createEntry(relative)))) {
          this.retryWrites.add(path);
          done = false;
        }
        if (this.known.size + adding.length > before) track(relative);
        if (adding.length >= ADD_AT_ONCE && !(await this.safely("files", async () => this.flushAdding()))) done = false;
      }
    } finally {
      // Stopped meanwhile too (the replica outlives the folder): what was taken in gets its entries, or its notes would
      // stay in the room without any. Guarded as each file is: a refusal here (this user made a reader meanwhile) is
      // tried again, not the end of the start.
      if (!this.o.replica.isDestroyed && !(await this.safely("files", async () => this.flushAdding()))) done = false;
      this.adding = null;
    }
    this.left = 0;
    this.reportProgress(true);
    if (reader && this.localOnlyEdits.size > 0) await this.saveNow();
    return done;
  }

  /** `gone`: whether the file was deleted since the event this came from (what is read may then be another file's). */
  private async createEntry(relative: string, gone?: () => boolean): Promise<void> {
    if (!isShareable(relative)) return this.notShared(relative, "type");
    if (this.indexUnread()) return this.rejectLocal(relative, "This computer hasn't read the room's file list yet (another program has it open). It is shared once it has.");
    const replica = this.o.replica;
    const path = this.vaultPath(relative);
    // Too large to share whatever it holds: not even read (it may be huge). A note's line endings can halve it at most.
    if (!(await this.fitsBeforeRead(relative, isMarkdownPath(relative)))) return;
    if (await this.claimedLocalOnly(relative)) return;
    const id = randomId("f");
    if (isMarkdownPath(relative)) {
      const text = await this.readNote(path);
      if (gone?.()) return;
      if (Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES) return this.notShared(relative, "size");
      // No live file entry until its content is accepted: a full room may refuse the cleanup too.
      const filled = text ? replica.edit(id, (doc) => doc.getText("content").insert(0, text)) : "published";
      const full = "The room's storage is full or the change was refused. Try again after space is available.";
      if (filled === "refused") return this.rejectLocal(relative, full);
      this.addEntry(id, { path: relative, kind: "md" }, (added) => {
        if (added === "refused") return this.rejectLocal(relative, full);
        const entryKey = replica.ownUpdateKey(INDEX_DOC);
        // Remembered only once actually shared (a missing key leaves it to the next pass).
        // With what the shared note holds now: the pass after it needn't read the note again.
        if (added === "published" && filled === "published") this.remember(id, relative, sha(text), undefined, [entryKey], true, replica.syncedKey(id));
        else { this.queuedEntries.set(id, relative); this.queuedPaths.set(relative, id); this.queuedHashes.set(id, sha(text)); }
      });
      return;
    }
    const bytes = await this.o.vault.readBytes(path);
    if (gone?.()) return;
    if (bytes.length + 16 > MAX_BYTES.b) return this.notShared(relative, "size");
    let blob;
    try {
      blob = replica.putBlob(bytes);
    } catch (error) {
      // Without the room's newest key yet: shared on a later pass.
      if (code(error) === "no_room_key") this.needsAdopt = true;
      else this.rejectLocal(relative, `Couldn't share this file (${code(error)}). Try again after space is available.`);
      return;
    }
    this.addEntry(id, { path: relative, kind: "bin", blob }, (added) => {
      if (added === "published") this.remember(id, relative, sha(bytes), blob, [replica.ownUpdateKey(INDEX_DOC), replica.ownBlobKey(blob.id)], true);
      else this.rejectLocal(relative, "Waiting to share the file's entry (a key is missing or the room's storage is full).");
    });
  }

  /** Add a file's entry to the room's file list: now, or with the others being taken in (see adding), then finish. */
  private addEntry(id: string, entry: FileEntry, then: (added: ReturnType<RoomReplica["editIndex"]>) => void): void {
    if (this.adding) this.adding.push({ id, entry, then });
    else then(this.o.replica.editIndex((files) => files.set(id, entry)));
  }

  /** Add the entries being taken in as one change of the file list, and finish each file's sharing. */
  private flushAdding(): void {
    const items = this.adding?.splice(0) ?? [];
    if (items.length === 0) return;
    const replica = this.o.replica;
    const added = replica.editIndex((files) => {
      for (const { id, entry } of items) files.set(id, entry);
    });
    if (added !== "refused") {
      for (const { then } of items) then(added);
      return;
    }
    // Refused together (the room's storage nearly full, say): one by one, as far as it takes them, as when each goes alone.
    for (const { id, entry, then } of items) then(replica.editIndex((files) => files.set(id, entry)));
  }

  /** Content changed here: put it into the shared state, or put the shared version back in a read-only room. */
  private async localChanged(id: string, entry: FileEntry, local: string | Uint8Array, localHash: string): Promise<void> {
    const replica = this.o.replica;
    // Part of the shared note can't be read yet: nothing to merge with or put back (a pass does once it can).
    if (entry.kind === "md" && !replica.isComplete(id)) return;
    if (!replica.canWrite()) {
      const remote = entry.kind === "md" ? normalizeNote(replica.noteText(id)) : entry.blob ? await replica.readBlob(entry.blob) : null;
      if (remote === null) return;
      const remoteHash = sha(remote);
      if (remoteHash !== localHash) {
        // Nothing of the reader's is lost: their version stays next to the shared one, on this computer only.
        const copy = this.copyName(entry.path, "your copy");
        await this.markLocalOnly(copy, local);
        await this.writeCopy(this.vaultPath(copy), local);
        const wrote = await this.writeShared(entry.path, remote, remoteHash, localHash);
        if (!wrote) return; // changed again meanwhile: looked at again next time
        this.quietNotice(`You can only read this room, so "${entry.path}" was put back. Your version is kept as "${copy}" on this computer only.`);
      }
      this.remember(id, entry.path, remoteHash, entry.blob);
      return;
    }
    if (entry.kind === "md" && typeof local === "string") {
      if (Buffer.byteLength(local, "utf8") > MAX_NOTE_BYTES) return this.holdBack(id, entry.path, localHash);
      const result = replica.edit(id, (doc) => reconcileYTextByLines(doc.getText("content"), local, "disk"), true);
      if (result === "refused") return this.holdBack(id, entry.path, localHash);
      if (result === "queued") return void this.queuedHashes.set(id, localHash);
      this.remember(id, entry.path, localHash);
      return;
    }
    if (!(local instanceof Uint8Array)) return;
    if (local.length + 16 > MAX_BYTES.b) return this.holdBack(id, entry.path, localHash);
    // Its new version needs a change of the file list: shared by the pass once that can go out (see indexUnread).
    if (this.indexUnread()) return this.quietNotice(`Your change to "${entry.path}" is shared once this computer has read the room's file list (another program has it open).`);
    this.binEdits.set(id, Date.now());
    let blob;
    try {
      blob = replica.putBlob(local);
    } catch (error) {
      if (code(error) !== "no_room_key") this.holdBack(id, entry.path, localHash);
      return;
    }
    const result = replica.editIndex((files) => files.set(id, { ...entry, blob, ...(entry.blob ? { base: entry.blob.id } : {}) }));
    if (result === "published") this.remember(id, entry.path, localHash, blob, [replica.ownUpdateKey(INDEX_DOC), replica.ownBlobKey(blob.id)]);
    else if (result === "refused") this.holdBack(id, entry.path, localHash);
  }

  /** Whether the shared version of a file differs from what was last synced here (our own unsent edits aside). */
  private async sharedMovedOn(id: string, entry: FileEntry, known: Known): Promise<boolean> {
    const replica = this.o.replica;
    if (entry.kind === "md") return !replica.hasUnsent(id) && (!replica.isComplete(id) || sha(normalizeNote(replica.noteText(id))) !== known.hash);
    if (!entry.blob || entry.blob.id === known.blob) return false;
    const remote = await replica.readBlob(entry.blob);
    return remote === null || sha(remote) !== known.hash;
  }

  /** A local version that can't be shared: kept as it is, never overwritten, and the user told once. */
  private holdBack(id: string, path: string, localHash: string): void {
    if (!this.heldBack.has(id)) this.o.heldBackChanged?.();
    this.heldBack.set(id, localHash);
    this.tellOnce(`held:${id}`, `Your change to "${path}" couldn't be shared (it may be too large, or the room's storage is full). It stays on this computer, and isn't overwritten.`);
  }

  /** Was this vault event caused by our own write? Consumes the expectation. */
  private isEcho(path: string, hash: string): boolean {
    const expected = this.expected.get(path);
    if (expected === undefined) return false;
    this.expected.delete(path);
    return expected === hash;
  }

  onLocalWrite(vaultPath: string): Promise<void> {
    this.noteLocal(vaultPath, true);
    // Deleted after this write, before the folder got to it (a deletion pending now, not then): the file written is
    // gone, and one with its name now came by a later event (renamed onto it, say), which takes it in.
    const gone = this.deletions.has(vaultPath) ? undefined : () => this.deletions.has(vaultPath);
    return this.run(() => this.tryLocalWrite(vaultPath, gone));
  }

  private async tryLocalWrite(vaultPath: string, gone?: () => boolean): Promise<void> {
    // Taken off the retries first: one that can't be handled yet puts itself back (see localWrite).
    this.retryWrites.delete(vaultPath);
    if (!(await this.safely(vaultPath.slice(this.prefix.length), () => this.localWrite(vaultPath, gone)))) { this.retryWrites.add(vaultPath); this.retrySoon(); }
  }

  private async localWrite(vaultPath: string, gone?: () => boolean): Promise<void> {
    if (!this.started) return; // taken in by start
    if (gone?.()) return;
    if (this.isLocalOnly(vaultPath)) return this.noteLocalOnlyContent(vaultPath);
    const relative = this.relative(vaultPath);
    if (relative === null) {
      if (this.unsafeInside(vaultPath)) this.notShared(vaultPath.slice(this.prefix.length), "name");
      return;
    }
    // A rename touching this name isn't handled yet: the file here now may be another one, and the one this save was
    // about is placed by that rename. It is looked at again then, wherever it is.
    if (this.renaming.has(vaultPath)) {
      const moving = this.movedOn.get(vaultPath) ?? this.idAt(relative) ?? this.queuedPaths.get(relative);
      if (moving !== undefined) this.remoteChanged(moving);
      return;
    }
    if (!this.o.vault.stat(vaultPath)) return;
    // A file there now is another one (see movedOn): the one that was here is looked at again, to be written back where
    // it belongs if nothing else places it.
    const moved = this.movedOnFrom(vaultPath);
    if (moved !== undefined) this.remoteChanged(moved);
    const id = this.idAt(relative) ?? this.queuedPaths.get(relative);
    // Its own file is on the move (a rename of it still to be handled, see inFlight): what stands at its name here is
    // another file. Looked at again once that rename has placed it.
    if (id !== undefined && this.inFlight(id, vaultPath)) {
      this.retryWrites.add(vaultPath);
      return this.retrySoon();
    }
    const indexed = id ? this.o.replica.entry(id) : undefined;
    const entry = indexed?.deleted ? undefined : indexed;
    // A new file here, nothing of ours: taken in, which checks its size before reading it (it may be huge). One that
    // can't be read yet (in use) is told of, and taken in by a retry.
    if (!id && !this.expected.has(vaultPath)) {
      if (!this.o.replica.canWrite()) return this.keepHere(relative);
      await this.createEntry(relative, gone);
      return;
    }
    // Still under its old name here (its rename is blocked by a file in the way): the change waits for the rename,
    // and is taken in from the new name by the pass after it, which decides by size, time and content (so a mark of
    // our own write here is dropped). An editor's save is remembered as ever (under the name it has here).
    if (id && entry && this.known.has(id) && this.known.get(id)!.path !== entry.path && !(entry.kind === "md" && this.o.isBound(id))) {
      this.expected.delete(vaultPath);
      return this.remoteChanged(id);
    }
    // Read as what the shared file is (a note or another file), even under a name that says otherwise (renamed so by
    // an earlier version): a note's text never goes out as an attachment, nor the reverse.
    const asNote = entry ? entry.kind === "md" : isMarkdownPath(relative);
    if (!(await this.fitsBeforeRead(relative, asNote, id))) return;
    const content = await this.readAs(vaultPath, asNote);
    // Deleted while being read: what was read may be another file's, renamed onto its name since (see gone).
    if (gone?.()) return;
    const hash = sha(content);
    if (this.isEcho(vaultPath, hash)) return;
    // Someone else deleted it, and it couldn't be trashed here yet: the removal, tried again, settles it (sharing it
    // again once, if it was changed here).
    if (id && indexed?.deleted) return this.remoteChanged();
    if (!id || !entry) {
      if (this.o.replica.canWrite()) return this.createEntry(relative, gone);
      return this.keepHere(relative);
    }
    // In doubt whether the others ever had what was made here last time: a pass settles it with the shared copy.
    if (this.doubtful(id)) return;
    const known = this.known.get(id);
    // Changed again after it was held back: looked at afresh.
    const held = this.heldBack.get(id);
    if (held !== undefined && held !== hash && this.heldBack.delete(id)) this.o.heldBackChanged?.();
    // A new note whose entry still waits for the room key: the edit waits with it.
    if (!known) {
      // Its entry waits for the room key, the file where a refused rename left it (see stayPut): remembered there,
      // and a pass moves it to its shared name.
      const where = relative === entry.path ? entry : { ...entry, path: relative };
      // The shared text moved on since the note was queued here (someone's edit came in): a pass decides on both.
      const base = this.queuedHashes.get(id);
      const replica = this.o.replica;
      if (base !== undefined && !replica.hasUnsent(id) && (!replica.isComplete(id) || sha(normalizeNote(replica.noteText(id))) !== base)) return this.remoteChanged(id);
      await this.localChanged(id, where, content, hash);
      if (where !== entry) this.remoteChanged(INDEX_DOC);
      return;
    }
    if (hash === known.hash) return this.remember(id, relative, hash, known.blob ? { id: known.blob, by: known.mine ? this.o.replica.deviceId : "" } : undefined);
    // An editor owns the note while bound (its edits already went into the shared text): remember what is on disk. Not
    // while its edits wait for the room's newest key (held in memory only, and maybe refused then): they still count as
    // changed here, should Obsidian stop before they are shared.
    if (entry.kind === "md" && this.o.isBound(id) && this.o.replica.canWrite()) {
      if (!this.o.replica.hasUnsent(id)) this.remember(id, relative, hash);
      return;
    }
    // The shared version moved on since the last sync and isn't here yet: taking this change in now would undo it, so
    // the next pass settles it like any change made on both sides (keeping a copy).
    if (this.o.replica.canWrite() && (await this.sharedMovedOn(id, entry, known))) return this.remoteChanged(id);
    await this.localChanged(id, entry, content, hash);
  }

  /** Deletions wait a moment: if the room's whole folder went, that is an unmount here, not deletions for everyone. */
  onLocalDelete(vaultPath: string): Promise<void> {
    this.noteLocal(vaultPath, false);
    if (this.stopped) return Promise.resolve();
    // This folder's own trashing (of what someone else deleted): not a deletion made here.
    if (this.expected.get(vaultPath) === DELETED) {
      this.expected.delete(vaultPath);
      return Promise.resolve();
    }
    this.countDeletion(vaultPath, 1);
    // Counted from the last one: a deletion still coming keeps the others waiting.
    this.waitForDeletions(DELETE_QUIET_MS);
    return Promise.resolve();
  }

  private waitForDeletions(ms: number): void {
    if (this.deleteTimer) clearTimeout(this.deleteTimer);
    this.deleteTimer = setTimeout(() => {
      this.deleteTimer = null;
      void this.run(() => this.flushDeletions());
    }, ms);
  }

  /** `final`: stopping, nothing waits any more (the folder's own deletion included, see stop). */
  private async flushDeletions(final = false): Promise<void> {
    if (!this.started) return;
    if (!this.movedAway && !this.o.vault.folderExists(this.o.folder)) {
      this.clearDeletions();
      this.o.folderGone?.();
      return;
    }
    // The user is being asked about them (see askAboutDeletions): their answer settles them, and any that come meanwhile.
    if (this.askingAboutDeletions) return;
    // Many at once, the folder still there: maybe a move or deletion of the whole folder, under way (Explorer pauses
    // for a dialog, or a file in use). Never shared on a guess: the user is asked; stopping puts them back.
    if (this.sharedAmong(this.deletions.keys()) >= MASS_DELETE && this.o.replica.canWrite()) {
      if (final) this.clearDeletions();
      else this.askAboutDeletions();
      return this.resumeWrites();
    }
    for (const vaultPath of [...this.deletions.keys()]) {
      // A rename to or from the name not handled yet: the deletion is of the file there before it, which that rename
      // takes (see onLocalRename), or of the one it brings, found there once it is handled. Left until then.
      if (this.renaming.has(vaultPath)) continue;
      this.countDeletion(vaultPath, -(this.deletions.get(vaultPath) ?? 0));
      await this.safely(vaultPath, () => this.applyLocalDelete(vaultPath));
    }
    this.resumeWrites();
  }

  /** How many of these were shared: files never shared aren't deleted for anyone. */
  private sharedAmong(vaultPaths: Iterable<string>): number {
    let count = 0;
    for (const vaultPath of vaultPaths) {
      const relative = this.relative(vaultPath);
      if (relative !== null && (this.idAt(relative) ?? this.queuedPaths.get(relative)) !== undefined) count++;
    }
    return count;
  }

  private askAboutDeletions(): void {
    this.askingAboutDeletions = true;
    // The answer is about these: any deleted after the question was shown are asked about on their own.
    const asked = [...this.deletions.keys()];
    const answer = this.o.confirmDeletions?.(this.sharedAmong(asked)) ?? Promise.resolve(false);
    void answer.then(
      (share) => this.settleDeletions(share, asked),
      () => this.settleDeletions(false, asked)
    );
  }

  private settleDeletions(share: boolean, asked: string[]): Promise<void> {
    return this.run(async () => {
      this.askingAboutDeletions = false;
      if (this.stopped) {
        if (share) this.o.notify(`The ${asked.length} files deleted from "${this.o.folder}" weren't deleted for everyone: the room's folder was moved or closed meanwhile. They come back there.`);
        return;
      }
      if (!this.movedAway && !this.o.vault.folderExists(this.o.folder)) {
        this.clearDeletions();
        this.o.folderGone?.();
        return;
      }
      if (share) {
        for (const vaultPath of asked) {
          // Left to a rename not handled yet, as in flushDeletions.
          if (this.renaming.has(vaultPath)) continue;
          this.countDeletion(vaultPath, -(this.deletions.get(vaultPath) ?? 0));
          await this.safely(vaultPath, () => this.applyLocalDelete(vaultPath));
        }
        // Deleted meanwhile: settled on their own (asked about again if they are many).
        if (this.deletions.size > 0) this.waitForDeletions(DELETE_QUIET_MS);
      } else {
        // Not shared, nor those deleted meanwhile (the same move, most likely): written back from the shared state.
        // Those not shared are gone for good (a copy kept here only): their marks go with them.
        for (const path of this.deletions.keys()) if (!this.o.vault.stat(path)) this.dropMarks(path);
        this.clearDeletions();
        this.remoteChanged();
      }
      this.resumeWrites();
    });
  }

  /** Notes and files missing here that waited while deletions were pending (see applyContent): looked at now. */
  private resumeWrites(): void {
    if (this.deletions.size > 0 || this.askingAboutDeletions || this.waitingForDeletions.size === 0) return;
    const entries = this.o.replica.entries();
    for (const id of this.waitingForDeletions) {
      this.dirty.add(id);
      // A removal, or a move held off a name being deleted (see applyRenames), that waited is made by a pass over the
      // file list (see materializeNow).
      const entry = entries.get(id);
      const known = this.known.get(id);
      if (!entry || entry.deleted || (known && known.path !== entry.path)) this.indexChanged = true;
    }
    this.waitingForDeletions.clear();
    this.queuePass();
  }

  /** Whether a deletion of the file at this room path is still pending (see onLocalDelete): what is there is in flux. */
  private deletionPendingAt(relative: string): boolean {
    return this.deletedKeys.size > 0 && this.deletedKeys.has(pathKey(relative));
  }

  /** Count `by` deletions of a path in (or out, negative): see deletions. */
  private countDeletion(vaultPath: string, by: number): void {
    const count = (this.deletions.get(vaultPath) ?? 0) + by;
    if (count > 0) this.deletions.set(vaultPath, count);
    else this.deletions.delete(vaultPath);
    if (!vaultPath.startsWith(this.prefix)) return;
    const key = pathKey(vaultPath.slice(this.prefix.length));
    const keyed = (this.deletedKeys.get(key) ?? 0) + by;
    if (keyed > 0) this.deletedKeys.set(key, keyed);
    else this.deletedKeys.delete(key);
  }

  private clearDeletions(): void {
    this.deletions.clear();
    this.deletedKeys.clear();
  }

  /**
   * Whether a file missing at its tracked path is on the move: a rename the folder hasn't handled yet touches the path,
   * or the file moved on before an earlier rename of it could be put back (see movedOn). Its next event places it.
   */
  private inFlight(id: string, vaultPath: string): boolean {
    if (this.renaming.has(vaultPath)) return true;
    // Renamed away from the name it is tracked under here (known, or waiting for the room key there), by the user,
    // while its shared name is another (a rename elsewhere not applied here yet): the user's rename places it.
    const at = this.known.get(id)?.path ?? this.queuedEntries.get(id);
    if (at !== undefined && this.renaming.has(this.vaultPath(at))) return true;
    for (const [at, moved] of this.movedOn) {
      // A link outlives its event when that never comes (deletions put back unapplied, say): dropped, or the file
      // would wait for ever.
      if (!this.renaming.has(at) && !this.deletions.has(at)) this.movedOn.delete(at);
      else if (moved === id) return true;
    }
    return false;
  }

  /** Take one pending deletion of this path (see deletions): whether there was one. */
  private takeDeletion(vaultPath: string): boolean {
    if (!this.deletions.has(vaultPath)) return false;
    this.countDeletion(vaultPath, -1);
    return true;
  }

  /** `replaced`: another file took its name since (a rename), so its being there isn't the file come back. */
  private async applyLocalDelete(vaultPath: string, replaced = false): Promise<void> {
    if (this.expected.get(vaultPath) === DELETED) {
      this.expected.delete(vaultPath);
      return;
    }
    // Back already (saved by deleting and writing again, say): it keeps its marks, a copy kept here only stays so.
    if (!replaced && this.o.vault.stat(vaultPath)) return;
    this.dropMarks(vaultPath);
    const relative = this.relative(vaultPath);
    if (relative === null) return;
    this.retryWrites.delete(vaultPath);
    const movedOn = this.movedOnFrom(vaultPath);
    const id = this.idAt(relative) ?? this.queuedPaths.get(relative) ?? movedOn;
    if (!id) return;
    this.forget(id);
    this.dropQueued(id);
    if (!this.o.replica.canWrite()) {
      this.quietNotice(`You can only read this room, so "${relative}" was put back.`);
      return this.remoteChanged(id);
    }
    return this.shareDeletion(id, relative);
  }

  /**
   * A file deleted here, or moved out of the room: deleted for everyone. Refused (the room's storage full, say), the
   * shared version is written back and the user told, rather than the file coming back unannounced at a later pass.
   * Written back by a pass queued after this, not run now: a rename onto its name may be half done (see onLocalRename).
   * While the room's file list isn't read here, it waits for it (see indexUnread).
   */
  // shortcut: a deletion waiting for the file list is kept in memory only, so one pending as Obsidian stops comes back
  // after a restart (as a refused one would); keep it with the folder's state if journals are often held at start.
  private shareDeletion(id: string, relative: string): void {
    if (this.indexUnread()) {
      this.unreadDeletions.set(id, relative);
      this.desiredCache = null;
      this.quietNotice(`"${relative}" is deleted for everyone once this computer has read the room's file list (another program has it open).`);
      return;
    }
    const entry = this.o.replica.entry(id);
    if (entry && !entry.deleted && this.o.replica.editIndex((files) => files.set(id, { ...entry, deleted: true })) === "refused") {
      this.quietNotice(`"${relative}" couldn't be taken out of the room for everyone (its storage may be full), so it was put back.`);
      return this.remoteChanged(id);
    }
    this.saveSoon();
  }

  /**
   * Whether the room's file list isn't all read here yet (another program held its journal as Obsidian started): no
   * change of it can go out until it is, and what waits for it is tried again then (see materializeNow).
   */
  private indexUnread(): boolean {
    if (!this.o.replica.historyUnread(INDEX_DOC)) return false;
    this.waitingForIndex = true;
    return true;
  }

  /** The file that stood at `vaultPath` when its rename was to be put back (see movedOn), taken once. */
  private movedOnFrom(vaultPath: string): string | undefined {
    const id = this.movedOn.get(vaultPath);
    this.movedOn.delete(vaultPath);
    return id;
  }

  onLocalRename(oldVaultPath: string, newVaultPath: string): Promise<void> {
    this.noteLocal(oldVaultPath, false);
    this.noteLocal(newVaultPath, true);
    // A deletion made before this rename, of a file at the name it takes (see below), looked for now: one made after it,
    // while the folder was busy, is of the renamed file itself.
    const key = newVaultPath.startsWith(this.prefix) ? pathKey(newVaultPath.slice(this.prefix.length)) : null;
    const replacing = key === null ? undefined : [...this.deletions.keys()].find((path) => path.startsWith(this.prefix) && pathKey(path.slice(this.prefix.length)) === key);
    if (replacing !== undefined) this.claimedDeletions.set(replacing, (this.claimedDeletions.get(replacing) ?? 0) + 1);
    // A deletion of the old name pending that no rename onto it takes: the file renamed now came there after it, so it
    // isn't the one an earlier put-back of that name left a link for (see movedOn). That deletion takes the link.
    const deletedBefore = (this.deletions.get(oldVaultPath) ?? 0) > (this.claimedDeletions.get(oldVaultPath) ?? 0);
    // Counted until handled: a pass meanwhile leaves both paths alone (see applyContent, adoptLocalFiles), and another
    // file renamed onto this one's new name by a later event is seen by this one (see back). Not the folder's own moves
    // (see moving): they place a file the folder knows, nothing is pending about them.
    const own = this.moving.has(movingMark(oldVaultPath, newVaultPath));
    if (!own) for (const touched of [oldVaultPath, newVaultPath]) this.renaming.set(touched, (this.renaming.get(touched) ?? 0) + 1);
    const handle = async () => {
      if (!own) {
        for (const touched of [oldVaultPath, newVaultPath]) {
          const later = (this.renaming.get(touched) ?? 1) - 1;
          if (later > 0) this.renaming.set(touched, later);
          else this.renaming.delete(touched);
        }
      }
      if (replacing !== undefined) {
        const claims = (this.claimedDeletions.get(replacing) ?? 1) - 1;
        if (claims > 0) this.claimedDeletions.set(replacing, claims);
        else this.claimedDeletions.delete(replacing);
      }
      if (!this.started) return; // taken in by start
      if (this.moving.delete(movingMark(oldVaultPath, newVaultPath))) return;
      const from = this.relative(oldVaultPath);
      const to = this.relative(newVaultPath);
      const movedOn = deletedBefore ? undefined : this.movedOnFrom(oldVaultPath);
      // A file deleted here moments ago (in any case), its name now taken by a tracked file or a copy kept here only:
      // that deletion first, not taken for the file come back. An untracked file renamed onto it (a program saving
      // through a temporary file) is that file's new content: the deletion is left to settle as such.
      if (to !== null && from !== null && (this.isLocalOnly(oldVaultPath) || this.idAt(from) !== undefined || this.queuedPaths.has(from) || movedOn !== undefined)) {
        if (replacing !== undefined && this.takeDeletion(replacing)) await this.safely(replacing, () => this.applyLocalDelete(replacing, true));
      }
      // A copy on this computer only stays so under its new name (and leaves the list if it leaves the room).
      if (this.isLocalOnly(oldVaultPath)) {
        const entry = this.dropLocalOnly(oldVaultPath.slice(this.prefix.length));
        if (to !== null) this.setLocalOnly(to, entry?.hash, entry?.size);
        this.saveSoon();
        return;
      }
      if (oldVaultPath.startsWith(this.prefix) && this.rejected.delete(oldVaultPath.slice(this.prefix.length))) this.o.healthChanged?.();
      const id = from === null ? undefined : (this.idAt(from) ?? this.queuedPaths.get(from) ?? movedOn);
      const unusable = (to === null && this.unsafeInside(newVaultPath)) || (to !== null && !isShareable(to));
      if (id && (to !== null || unusable)) {
        // Renamed within the room: to a name others can't have, or by a reader, it goes back to its old name: the one
        // before this rename, or, renamed again before an earlier one was put back, the one before that.
        const own = this.known.get(id)?.path ?? this.queuedEntries.get(id) ?? from!;
        const home = movedOn !== undefined && id === movedOn ? this.vaultPath(own) : oldVaultPath;
        const back = async () => {
          // Renamed back to that name meanwhile: nothing to put back.
          if (home === newVaultPath) return;
          // Another file renamed onto its name meanwhile (so it left first), or deleted there and a new file written in
          // its place (events still to come): what is there now is that file, not this one. The next event from this
          // name is taken for this file.
          if (this.renaming.has(newVaultPath) || (to !== null && this.deletionPendingAt(to) && this.o.vault.stat(newVaultPath))) return void this.movedOn.set(newVaultPath, id);
          this.moving.add(movingMark(newVaultPath, home));
          try {
            await this.o.vault.rename(newVaultPath, home);
          } catch (error) {
            this.moving.delete(movingMark(newVaultPath, home));
            // Moved on meanwhile (renamed again, or deleted): that event comes next, and is taken for this file.
            if (!this.o.vault.stat(newVaultPath)) return void this.movedOn.set(newVaultPath, id);
            // Anything else in the way (the disk): the file is tracked where it stands, so a new file at its old name is
            // one of its own, and a pass moves it back (tried again while the disk refuses, shown failing meanwhile).
            // At a name no room can have it isn't tracked: as before.
            const stayPut = (failure: unknown): never => {
              if (to !== null) {
                if (this.known.has(id)) this.setKnown(id, { ...this.known.get(id)!, path: to });
                else if (this.queuedEntries.has(id)) {
                  this.dropQueued(id);
                  this.queuedEntries.set(id, to);
                  this.queuedPaths.set(to, id);
                }
                this.remoteChanged(INDEX_DOC);
              }
              throw failure;
            };
            // Its old name taken meanwhile (a new file made there, as the disk sees names: a Windows or macOS disk doesn't
            // tell "a.md" from "A.md"): kept next to it under a name of its own, the shared file it was, so neither is
            // taken for the other. The folder is listed for that: the new file's own event may not have come yet.
            const homeRelative = this.relative(home) ?? from!;
            const key = pathKey(homeRelative);
            const taken = this.o.vault.stat(home) !== null || [...this.o.vault.listFiles(this.o.folder)].some((path) => path !== newVaultPath && pathKey(this.relative(path) ?? path) === key);
            if (!taken) stayPut(error);
            const aside = this.copyName(homeRelative, "kept");
            const mark = movingMark(newVaultPath, this.vaultPath(aside));
            this.moving.add(mark);
            try {
              await this.o.vault.rename(newVaultPath, this.vaultPath(aside));
            } catch (asideError) {
              this.moving.delete(mark);
              stayPut(asideError);
            }
            let refused = false;
            if (this.known.has(id)) this.setKnown(id, { ...this.known.get(id)!, path: aside });
            else if (this.queuedEntries.has(id)) {
              // Its entry waits for the room key: it goes out under the kept name (as a rename of one does, see below).
              const entry = this.o.replica.entry(id);
              refused = entry !== undefined && !entry.deleted && this.o.replica.canWrite() && this.o.replica.editIndex((files) => files.set(id, { ...entry, path: aside })) === "refused";
              this.dropQueued(id);
              this.queuedEntries.set(id, aside);
              this.queuedPaths.set(aside, id);
            }
            // A pass settles the two (the shared file back at its name once the new one has a name of its own).
            // shortcut: a pass between this and the new file's own event keeps that file as a conflict copy instead
            // (nothing lost, but a notice of a clash that wasn't); handle if users meet it.
            this.remoteChanged(INDEX_DOC);
            // Told in full (the one before it, on the refused rename, would silence a quiet one): the user must find it.
            this.o.notify(`A new file took the name of "${from}" meanwhile: the shared file is kept here as "${aside}"${refused ? " (it couldn't be renamed for everyone: the room's storage may be full)" : ""}.`);
          }
        };
        if (unusable) {
          this.quietNotice(`"${newVaultPath.slice(this.prefix.length)}" can't be used in a shared room (too long, an unusual character, or a file type that isn't shared). The file keeps its old name.`);
          return back();
        }
        // A note and other files are shared differently: one can't become the other by a new name. (Judged by what it is
        // shared as, so a note an earlier version renamed to Plan.txt may go back to Plan.md.)
        const isNote = (this.o.replica.entry(id)?.kind ?? (isMarkdownPath(own) ? "md" : "bin")) === "md";
        if (isNote !== isMarkdownPath(to!)) {
          this.quietNotice(`"${from}" keeps its name: in a shared room a note can't be renamed into another type of file, nor another file into a note. Make a copy under the new name instead.`);
          return back();
        }
        if (!this.o.replica.canWrite()) {
          this.quietNotice("You can only read this room, so the file keeps its old name.");
          return back();
        }
        const entry = this.o.replica.entry(id);
        // Not read yet, its entry may be missing too (the whole list unread, say).
        if (!entry?.deleted && this.indexUnread()) {
          this.quietNotice(`"${from}" can't be renamed for everyone until this computer has read the room's file list (another program has it open), so it keeps its old name for now.`);
          return back();
        }
        if (entry && !entry.deleted && this.o.replica.editIndex((files) => files.set(id, { ...entry, path: to! })) === "refused") {
          this.quietNotice(`"${from}" couldn't be renamed for everyone (the room's storage may be full), so it keeps its old name.`);
          return back();
        }
        if (this.known.has(id)) this.setKnown(id, { ...this.known.get(id)!, path: to! });
        else {
          // Its entry still waits for the room key: it goes out under the new name (not the queued one, which may not be
          // `from`: see movedOn).
          this.dropQueued(id);
          this.queuedEntries.set(id, to!);
          this.queuedPaths.set(to!, id);
        }
        this.saveSoon();
        return;
      }
      // Moved out of the room: it leaves the room. Moved in: it joins it.
      if (id) {
        this.forget(id);
        this.dropQueued(id);
        if (!this.o.replica.canWrite()) return this.remoteChanged(id);
        return this.shareDeletion(id, from!);
      }
      if (to !== null && !this.idAt(to)) {
        if (!this.o.replica.canWrite()) return this.keepHere(to);
        await this.tryLocalWrite(newVaultPath);
      } else if (to !== null && !id) {
        // An untracked file renamed onto a tracked one's name (a program saving through a temporary file): that file's
        // new content.
        await this.tryLocalWrite(newVaultPath);
      }
    };
    return this.run(async () => {
      try {
        await handle();
      } finally {
        // A file missing here while this rename was pending (renamed away by it, say) is looked at again, and deletions
        // left to this rename (see flushDeletions) that it didn't take get their turn.
        this.resumeWrites();
        if (this.deletions.size > 0 && !this.deleteTimer && !this.askingAboutDeletions) this.waitForDeletions(DELETE_QUIET_MS);
      }
    });
  }
}
