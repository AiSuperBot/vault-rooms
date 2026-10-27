import { createHash } from "node:crypto";
import { INDEX_DOC, isMarkdownPath, MAX_BYTES, MAX_NOTE_BYTES, MAX_SEGMENT, pathKey, randomId, safeRoomPath, SecureError, type FileEntry, type RoomReplica } from "@vault-rooms/secure";
import { reconcileYTextWithDiskText } from "../crdtReconcile.js";

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
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
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
   * else has then). If Obsidian stopped before it was, the shared state may lack it: such a file isn't taken as
   * "unchanged here" until the shared version matches it, and a new entry that never got stored is made again.
   */
  unstored?: true | "entry";
}

export interface RoomFolderState {
  known: Record<string, Known>;
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
  loadState(): Promise<RoomFolderState | null>;
  saveState(state: RoomFolderState): Promise<void>;
  notify(message: string): void;
  log(message: string): void;
  now?: () => Date;
}

/**
 * The file types a room shares. Anything else (programs, scripts, shortcuts, web pages, documents that can carry
 * macros) is neither shared from this computer nor written to it when someone else adds one, so a member can't plant
 * something that runs when opened.
 */
export const SHARED_EXTENSIONS = new Set([
  "md", "canvas", "base", "txt", "csv", "tsv", "json",
  "pdf", "epub", "docx", "xlsx", "pptx", "odt", "ods", "odp",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic",
  "mp3", "wav", "m4a", "ogg", "oga", "opus", "flac", "mp4", "m4v", "webm", "mov", "mkv", "ogv",
  "zip"
]);

export function isShareable(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") + 1 && SHARED_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

const DELETED = "\u0000deleted";
/** A note changed here this recently counts as being worked on: a deletion by someone else doesn't take it away. */
const RECENT_EDIT_MS = 10 * 60_000;

/** Notes are compared and shared with "\n" line endings, as Obsidian's editor holds them (and saves them, once edited). */
export function normalizeNote(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).digest("base64url");
}

function splitName(path: string): { stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? { stem: path.slice(0, dot), ext: path.slice(dot) } : { stem: path, ext: "" };
}

function code(error: unknown): string {
  return error instanceof SecureError ? error.code : "error";
}

export class RoomFolder {
  private known = new Map<string, Known>();
  private expected = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private materializeTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private deleteTimer: ReturnType<typeof setTimeout> | null = null;
  private deletions = new Set<string>();
  /** Local versions that couldn't be shared (too large, refused), by file id: their hash. */
  private heldBack = new Map<string, string>();
  /** Attachments changed here, by file id: when. */
  private binEdits = new Map<string, number>();
  /** Copies this device made of a reader's own changes: local only, not to be reported again. */
  private localOnly = new Set<string>();
  private told = new Set<string>();
  /** Files remembered in this session while something made here for them was still being stored: what to check. */
  private unstoredNow = new Map<string, Pending>();
  /** Notes whose new entry had to wait for the room key: remembered (when shared) as entries made here. */
  private queuedEntries = new Set<string>();
  /** What an editor showed when it stopped co-editing a note (already in the shared text), by file id: its hash. */
  private leftByEditor = new Map<string, string>();
  private needsAdopt = false;
  /** What was last synced is loaded: decisions can be made. */
  private started = false;
  /** The first pass after starting is done: editors may be bound. */
  private ready = false;
  private readOnlyNoticeAt = 0;
  private stopped = false;

  constructor(private readonly o: RoomFolderOptions) {
    if (safeRoomPath(o.folder) === null) throw new Error(`"${o.folder}" can't hold a room.`);
  }

  // ---- paths ----

  private get prefix(): string {
    return `${this.o.folder}/`;
  }

  /** Room-relative path for a vault path inside the folder (null if outside, in another room's folder, or unsafe). */
  relative(vaultPath: string): string | null {
    if (!vaultPath.startsWith(this.prefix) || this.o.inOtherRoom?.(vaultPath)) return null;
    return safeRoomPath(vaultPath.slice(this.prefix.length));
  }

  /** Inside the folder, but under a name that can't be shared. */
  private unsafeInside(vaultPath: string): boolean {
    return vaultPath.startsWith(this.prefix) && !this.o.inOtherRoom?.(vaultPath) && safeRoomPath(vaultPath.slice(this.prefix.length)) === null;
  }

  private vaultPath(relative: string): string {
    return `${this.o.folder}/${relative}`;
  }

  private idAt(relative: string): string | undefined {
    const key = pathKey(relative);
    for (const [id, known] of this.known) if (pathKey(known.path) === key) return id;
    return undefined;
  }

  /** The file id of a note at a vault path, for the editor binding (none before the first pass, or while its local version is held back or in doubt). */
  noteIdAt(vaultPath: string): string | null {
    const relative = this.relative(vaultPath);
    if (relative === null || !this.ready) return null;
    const id = this.idAt(relative) ?? [...this.o.replica.files()].find(([, entry]) => pathKey(entry.path) === pathKey(relative))?.[0];
    return id && this.o.replica.files().get(id)?.kind === "md" && !this.heldBack.has(id) && !this.doubtful(id) ? id : null;
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

  /** One file's trouble (locked, a folder in the way, ...) mustn't stop the others. */
  private async safely(what: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.o.log(`room folder, ${what}: ${(error as Error).message}`);
    }
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
        this.o.notify(`"${this.o.folder}" isn't syncing: what was last synced there couldn't be read (${(error as Error).message}). Restart Obsidian to try again.`);
        throw error;
      }
      for (const [id, known] of Object.entries(saved?.known ?? {})) this.known.set(id, known);
      this.started = true;
      await this.adoptLocalFiles();
      await this.materializeNow();
      this.ready = true;
      this.o.passed?.();
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.materializeTimer, this.saveTimer, this.deleteTimer]) if (timer) clearTimeout(timer);
    this.materializeTimer = this.saveTimer = this.deleteTimer = null;
    return this.run(async () => {
      // Never loaded: the saved state stays as it was.
      if (!this.started) return;
      // Deletions made just before stopping still count, unless the folder itself went (moved or deleted), or the room.
      if (this.deletions.size > 0 && !this.o.replica.isDestroyed && this.o.vault.folderExists(this.o.folder)) await this.flushDeletions();
      // What this computer made is stored before the state that counts on it is saved (a stuck disk isn't waited for long).
      await Promise.race([this.o.replica.stored(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      await this.saveNow();
    }, true);
  }

  /** Call when the room index or a note changed remotely, or a key arrived. */
  remoteChanged(): void {
    if (this.stopped || this.materializeTimer) return;
    this.materializeTimer = setTimeout(() => {
      this.materializeTimer = null;
      void this.run(() => this.materializeNow());
    }, 150);
  }

  /** Wait until everything queued so far has run (tests, shutdown). */
  async settled(): Promise<void> {
    if (this.materializeTimer) {
      clearTimeout(this.materializeTimer);
      this.materializeTimer = null;
      void this.run(() => this.materializeNow());
    }
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
      void this.run(() => this.flushDeletions());
    }
    await this.queue;
  }

  /** Whether a note's local version is held back (couldn't be shared): the editor shouldn't be bound to it. */
  isHeldBack(fileId: string): boolean {
    return this.heldBack.has(fileId);
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
    // Stored meanwhile: no longer in doubt.
    for (const [id, pending] of this.unstoredNow) {
      if (this.unstored(pending)) continue;
      this.unstoredNow.delete(id);
      const known = this.known.get(id);
      if (known) delete known.unstored;
    }
    await this.o.saveState({ known: Object.fromEntries(this.known) });
  }

  /**
   * Remember a file as synced. What this computer made for it counts only once stored: edits of its note, and `made`,
   * the envelopes (by key) it just made for the file's entry (`created`: a new entry). Until then the file is marked
   * (see Known.unstored), and the mark is checked again whenever state is saved.
   */
  private remember(id: string, path: string, hash: string, blob?: { id: string; by: string }, made: Array<string | null> = [], created = false): void {
    const replica = this.o.replica;
    const stat = this.o.vault.stat(this.vaultPath(path));
    const pending = this.unstoredNow.get(id) ?? { docs: new Set<string>(), keys: new Set<string>(), index: false, created: false };
    if (isMarkdownPath(path)) pending.docs.add(id);
    for (const key of made) if (key) pending.keys.add(key);
    pending.created ||= created;
    if (this.queuedEntries.delete(id)) pending.index = pending.created = true;
    this.leftByEditor.delete(id);
    const unstored = this.unstored(pending);
    if (unstored) this.unstoredNow.set(id, pending);
    else this.unstoredNow.delete(id);
    this.known.set(id, {
      path,
      hash,
      size: stat?.size ?? -1,
      mtime: stat?.mtime ?? -1,
      ...(blob ? { blob: blob.id, ...(blob.by === replica.deviceId ? { mine: true as const } : {}) } : {}),
      ...(unstored ? { unstored: pending.created ? ("entry" as const) : (true as const) } : {})
    });
    if (this.heldBack.delete(id)) this.o.heldBackChanged?.();
    this.saveSoon();
  }

  private unstored(pending: Pending): boolean {
    const replica = this.o.replica;
    const keys = [...pending.keys];
    if (pending.index) keys.push(replica.ownUpdateKey(INDEX_DOC) ?? "");
    return replica.hasUnstored([...pending.docs], keys) || (pending.index && replica.hasUnsent(INDEX_DOC));
  }

  /** An editor stopped co-editing a note; what it showed then is in the shared text (its last save may come just after). */
  editorLeft(fileId: string, text: string): void {
    this.leftByEditor.set(fileId, sha(normalizeNote(text)));
  }

  /** Tell the user once about something (per subject). */
  private tellOnce(subject: string, message: string): void {
    if (this.told.has(subject)) return;
    this.told.add(subject);
    this.o.notify(message);
  }

  private readOnlyNotice(message: string): void {
    if (Date.now() - this.readOnlyNoticeAt < 10_000) return;
    this.readOnlyNoticeAt = Date.now();
    this.o.notify(message);
  }

  private notShared(relative: string, why: "type" | "size" | "name"): void {
    const reason = {
      type: "files of this type aren't shared in rooms",
      size: `it is too large to share (notes over ${MAX_NOTE_BYTES >> 20} MB, other files over ${(MAX_BYTES.b >> 20) - 1} MB)`,
      name: "its name can't be used on every computer (too long, or with characters some systems refuse)"
    }[why];
    this.tellOnce(`${why}:${relative}`, `"${relative}" stays on this computer only: ${reason}.`);
  }

  // ---- writing to disk (ours, so the resulting vault events are ignored) ----

  private async writeText(relative: string, text: string, expected?: (current: string) => boolean): Promise<boolean> {
    const path = this.vaultPath(relative);
    this.expected.set(path, sha(text));
    const wrote = await this.o.vault.writeText(path, text, expected);
    if (!wrote) this.expected.delete(path);
    return wrote;
  }

  private async writeBytes(relative: string, bytes: Uint8Array): Promise<void> {
    const path = this.vaultPath(relative);
    this.expected.set(path, sha(bytes));
    await this.o.vault.writeBytes(path, bytes);
  }

  private async trash(relative: string): Promise<void> {
    const path = this.vaultPath(relative);
    this.expected.set(path, DELETED);
    await this.o.vault.trash(path);
  }

  private async move(from: string, to: string): Promise<void> {
    this.expected.set(this.vaultPath(from), `\u0000moved:${this.vaultPath(to)}`);
    await this.o.vault.rename(this.vaultPath(from), this.vaultPath(to));
  }

  /** A free name next to `relative` for a copy of a file that would otherwise be lost (one safe path segment). */
  private copyName(relative: string, label: string): string {
    const slash = relative.lastIndexOf("/");
    const dir = relative.slice(0, slash + 1);
    const { stem, ext } = splitName(relative.slice(slash + 1));
    const stamp = (this.o.now?.() ?? new Date()).toISOString().slice(0, 16).replace("T", " ").replace(":", "");
    const device = this.o.deviceName.replace(/[\\/:*?"<>|.]/g, "").trim().slice(0, 40) || "this computer";
    for (let i = 1; ; i++) {
      const suffix = ` (${label} ${device} ${stamp}${i > 1 ? ` ${i}` : ""})`;
      const name = `${stem.slice(0, Math.max(1, MAX_SEGMENT - suffix.length - ext.length)).trimEnd()}${suffix}${ext}`;
      const candidate = safeRoomPath(`${dir}${name}`) ?? `${dir}copy ${stamp.replace(/[ ]/g, "-")} ${i}${ext}`;
      if (!this.o.vault.stat(this.vaultPath(candidate))) return candidate;
    }
  }

  private async keepAside(relative: string, content: string | Uint8Array): Promise<string> {
    const name = this.copyName(relative, "conflict");
    // Not marked as ours: the copy is a local addition and gets shared like any other.
    if (typeof content === "string") await this.o.vault.writeText(this.vaultPath(name), content);
    else await this.o.vault.writeBytes(this.vaultPath(name), content);
    this.o.notify(`"${relative}" was changed here and by someone else at the same time. Your version is kept as "${name}".`);
    return name;
  }

  // ---- shared -> disk ----

  /** The paths files should have here: index paths, with deterministic suffixes when two entries collide. */
  private desired(): Map<string, FileEntry> {
    const groups = new Map<string, Array<[string, FileEntry]>>();
    for (const [id, entry] of this.o.replica.files()) {
      if (!isShareable(entry.path) || this.o.inOtherRoom?.(this.vaultPath(entry.path))) continue;
      const key = pathKey(entry.path);
      groups.set(key, [...(groups.get(key) ?? []), [id, entry]]);
    }
    const out = new Map<string, FileEntry>();
    const renames: Array<[string, FileEntry, string]> = [];
    for (const group of groups.values()) {
      group.sort(([a], [b]) => (a < b ? -1 : 1));
      group.forEach(([id, entry], index) => {
        if (index === 0) return out.set(id, entry);
        const { stem, ext } = splitName(entry.path);
        const path = `${stem} (${id.slice(1, 5)})${ext}`;
        out.set(id, { ...entry, path });
        renames.push([id, entry, path]);
      });
    }
    // Writers settle the clash for everyone, the same way on every device.
    if (renames.length > 0 && this.o.replica.canWrite()) {
      this.o.replica.editIndex((files) => {
        for (const [id, entry, path] of renames) files.set(id, { ...entry, path });
      });
    }
    return out;
  }

  private async materializeNow(): Promise<void> {
    if (this.stopped || !this.started) return;
    const replica = this.o.replica;
    const desired = this.desired();
    // Removals and renames only from a fully readable index: a gap there is never taken for a deletion.
    if (replica.isComplete(INDEX_DOC)) {
      const entries = replica.entries();
      for (const [id, known] of [...this.known]) {
        if (entries.get(id)?.deleted) await this.safely(known.path, () => this.applyRemoval(id, known));
        else if (!entries.has(id) && this.doubtful(id) && known.unstored === "entry") {
          // Shared in a session that ended before its new entry was stored, so no one has it: shared again.
          this.known.delete(id);
          this.needsAdopt = true;
        }
      }
      await this.safely("renames", () => this.applyRenames(desired));
    }
    for (const [id, entry] of desired) await this.safely(entry.path, () => this.applyContent(id, entry));
    if (this.needsAdopt && replica.canWrite()) {
      this.needsAdopt = false;
      await this.adoptLocalFiles();
    }
    this.saveSoon();
    if (this.ready) this.o.passed?.();
  }

  private async applyRenames(desired: Map<string, FileEntry>): Promise<void> {
    const moves = new Map<string, { from: string; to: string }>();
    for (const [id, entry] of desired) {
      const known = this.known.get(id);
      if (known && known.path !== entry.path && this.o.vault.stat(this.vaultPath(known.path))) moves.set(id, { from: known.path, to: entry.path });
    }
    while (moves.size > 0) {
      let progressed = false;
      for (const [id, { from, to }] of moves) {
        if (this.o.vault.stat(this.vaultPath(to)) && pathKey(from) !== pathKey(to)) continue;
        await this.move(from, to);
        this.known.set(id, { ...this.known.get(id)!, path: to });
        moves.delete(id);
        progressed = true;
      }
      if (progressed) continue;
      // Every target is taken: a swap or a file in the way. Move one aside under a visible temporary name.
      const [, move] = moves.entries().next().value as [string, { from: string; to: string }];
      const occupant = this.idAt(move.to);
      if (occupant && moves.has(occupant)) {
        const { stem, ext } = splitName(moves.get(occupant)!.from);
        const temporary = `${stem} (moving ${occupant.slice(1, 5)})${ext}`;
        await this.move(moves.get(occupant)!.from, temporary);
        this.known.set(occupant, { ...this.known.get(occupant)!, path: temporary });
        moves.set(occupant, { from: temporary, to: moves.get(occupant)!.to });
      } else {
        // An untracked local file is in the way: keep it under a conflict name.
        await this.keepAside(move.to, await this.o.vault.readBytes(this.vaultPath(move.to)));
        await this.trash(move.to);
      }
    }
  }

  /** A file here whose name differs from `relative` only in case (the same file on Windows and macOS), if untracked. */
  private untrackedCaseVariant(relative: string): string | null {
    const key = pathKey(relative);
    for (const path of this.o.vault.listFiles(this.o.folder)) {
      const other = this.relative(path);
      if (other !== null && other !== relative && pathKey(other) === key && !this.idAt(other)) return other;
    }
    return null;
  }

  private async applyContent(id: string, entry: FileEntry): Promise<void> {
    const replica = this.o.replica;
    const path = this.vaultPath(entry.path);
    const known = this.known.get(id);
    if (entry.kind === "md" && this.o.isBound(id)) return;
    let remote: string | Uint8Array | null;
    if (entry.kind === "md") {
      // Part of the note can't be read yet, or our own edit is waiting for the room key: nothing to decide on yet.
      if (!replica.isComplete(id) || replica.hasUnsent(id)) return;
      remote = normalizeNote(replica.noteText(id));
    } else {
      remote = entry.blob ? await replica.readBlob(entry.blob) : null;
    }
    if (remote === null) return; // the attachment hasn't arrived yet
    const remoteHash = sha(remote);
    // Left from a session that may have ended before what it made was stored: proven only by a matching shared copy.
    const doubtful = this.doubtful(id);
    const stat = this.o.vault.stat(path);
    if (!stat) {
      const variant = this.untrackedCaseVariant(entry.path);
      if (variant) {
        await this.keepAside(variant, await this.o.vault.readBytes(this.vaultPath(variant)));
        await this.trash(variant);
      }
      return this.write(id, entry, remote, remoteHash);
    }
    const unchangedHere = known !== undefined && !doubtful && known.path === entry.path && known.size === stat.size && known.mtime === stat.mtime;
    if (unchangedHere) {
      if (remoteHash === known.hash) return;
      // Another version of an attachment made from an older one than the version this computer made (two people
      // changed it at once): keep ours. A version of someone else's that we merely had is just older.
      if (entry.kind === "bin" && known.mine && entry.blob && entry.blob.id !== known.blob && entry.base !== known.blob) await this.keepAside(entry.path, await this.o.vault.readBytes(path));
      return this.write(id, entry, remote, remoteHash, known.hash);
    }
    const local = entry.kind === "md" ? await this.readNote(path) : await this.o.vault.readBytes(path);
    const localHash = sha(local);
    if (localHash === remoteHash) return this.remember(id, entry.path, remoteHash, entry.blob);
    if (!known || (localHash === known.hash && !doubtful)) {
      // Nothing changed here since the last sync (or a file we never tracked sits at this path): the shared copy wins,
      // but an untracked file with content is kept aside first.
      if (!known && local.length > 0) await this.keepAside(entry.path, local);
      return this.write(id, entry, remote, remoteHash, localHash);
    }
    if (remoteHash === known.hash && !doubtful) {
      // Only changed here (e.g. while Obsidian was closed): share the local version, unless it is already held back.
      if (this.heldBack.get(id) === localHash) return;
      return this.localChanged(id, entry, local, localHash);
    }
    // Changed on both sides since the last sync.
    await this.keepAside(entry.path, local);
    await this.write(id, entry, remote, remoteHash, localHash);
  }

  /** Write the shared version; a text file is written only if it is still what the decision was based on. */
  private async write(id: string, entry: FileEntry, remote: string | Uint8Array, remoteHash: string, basedOn?: string): Promise<void> {
    if (typeof remote === "string") {
      // Checked as it is written: changed meanwhile, or an editor bound meanwhile (which owns the note now), it waits.
      const wrote = await this.writeText(entry.path, remote, (current) => !this.o.isBound(id) && (basedOn === undefined || sha(normalizeNote(current)) === basedOn));
      if (!wrote) return; // looked at again next time
    } else {
      await this.writeBytes(entry.path, remote);
    }
    this.remember(id, entry.path, remoteHash, entry.blob);
  }

  private lastEdit(id: string, entry: FileEntry): number {
    return entry.kind === "md" ? this.o.replica.lastLocalEdit(id) : (this.binEdits.get(id) ?? 0);
  }

  private async applyRemoval(id: string, known: Known): Promise<void> {
    const path = this.vaultPath(known.path);
    const stat = this.o.vault.stat(path);
    const entry = this.o.replica.entries().get(id);
    // Whether the others ever had this version is in doubt (see Known.unstored): it counts as a change made here.
    const busy = this.doubtful(id) || (entry !== undefined && Date.now() - this.lastEdit(id, entry) < RECENT_EDIT_MS);
    this.known.delete(id);
    if (!stat) return;
    const current = isMarkdownPath(known.path) ? await this.readNote(path) : await this.o.vault.readBytes(path);
    const unchanged = !busy && ((stat.size === known.size && stat.mtime === known.mtime) || sha(current) === known.hash);
    if (unchanged) return this.trash(known.path);
    // Changed here after someone else removed it, or being worked on here: keep it, and share it again as a new file.
    if (!this.o.replica.canWrite()) return;
    await this.createEntry(known.path);
    this.o.notify(`"${known.path}" was deleted by someone else while you were working on it here. Your copy stays, and is shared again.`);
  }

  // ---- disk -> shared ----

  /** Files in the folder that aren't tracked yet become shared files (when this user may write). */
  private async adoptLocalFiles(): Promise<void> {
    if (!this.o.replica.canWrite()) return;
    const indexPaths = new Set([...this.o.replica.files().values()].map((entry) => pathKey(entry.path)));
    for (const path of this.o.vault.listFiles(this.o.folder)) {
      if (this.o.inOtherRoom?.(path)) continue;
      const relative = this.relative(path);
      if (relative === null) {
        if (this.unsafeInside(path)) this.notShared(path.slice(this.prefix.length), "name");
        continue;
      }
      if (this.idAt(relative) || indexPaths.has(pathKey(relative))) continue;
      await this.safely(relative, () => this.createEntry(relative));
    }
  }

  private async createEntry(relative: string): Promise<void> {
    if (!isShareable(relative)) return this.notShared(relative, "type");
    const replica = this.o.replica;
    const path = this.vaultPath(relative);
    const id = randomId("f");
    if (isMarkdownPath(relative)) {
      const text = await this.readNote(path);
      if (Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES) return this.notShared(relative, "size");
      const added = replica.editIndex((files) => files.set(id, { path: relative, kind: "md" }));
      if (added === "refused") return;
      const entryKey = replica.ownUpdateKey(INDEX_DOC);
      const filled = text ? replica.edit(id, (doc) => doc.getText("content").insert(0, text)) : "published";
      if (filled === "refused") {
        replica.editIndex((files) => files.set(id, { path: relative, kind: "md", deleted: true }));
        return this.notShared(relative, "size");
      }
      // Remembered only once actually shared (a missing key leaves it to the next pass).
      if (added === "published" && filled === "published") this.remember(id, relative, sha(text), undefined, [entryKey], true);
      else this.queuedEntries.add(id);
      return;
    }
    const bytes = await this.o.vault.readBytes(path);
    if (bytes.length + 16 > MAX_BYTES.b) return this.notShared(relative, "size");
    let blob;
    try {
      blob = replica.putBlob(bytes);
    } catch (error) {
      // Without the room's newest key yet: shared on a later pass.
      if (code(error) === "no_room_key") this.needsAdopt = true;
      else this.o.log(`share ${relative}: ${code(error)}`);
      return;
    }
    if (replica.editIndex((files) => files.set(id, { path: relative, kind: "bin", blob })) === "published") {
      this.remember(id, relative, sha(bytes), blob, [replica.ownUpdateKey(INDEX_DOC), replica.ownBlobKey(blob.id)], true);
    }
  }

  /** Content changed here: put it into the shared state, or put the shared version back in a read-only room. */
  private async localChanged(id: string, entry: FileEntry, local: string | Uint8Array, localHash: string): Promise<void> {
    const replica = this.o.replica;
    if (!replica.canWrite()) {
      const remote = entry.kind === "md" ? normalizeNote(replica.noteText(id)) : entry.blob ? await replica.readBlob(entry.blob) : null;
      if (remote === null) return;
      const remoteHash = sha(remote);
      if (remoteHash !== localHash) {
        // Nothing of the reader's is lost: their version stays next to the shared one, on this computer only.
        const copy = this.copyName(entry.path, "your copy");
        this.localOnly.add(this.vaultPath(copy));
        if (typeof local === "string") await this.o.vault.writeText(this.vaultPath(copy), local);
        else await this.o.vault.writeBytes(this.vaultPath(copy), local);
        if (typeof remote === "string") await this.writeText(entry.path, remote);
        else await this.writeBytes(entry.path, remote);
        this.readOnlyNotice(`You can only read this room, so "${entry.path}" was put back. Your version is kept as "${copy}" on this computer only.`);
      }
      this.remember(id, entry.path, remoteHash, entry.blob);
      return;
    }
    if (entry.kind === "md" && typeof local === "string") {
      if (Buffer.byteLength(local, "utf8") > MAX_NOTE_BYTES) return this.holdBack(id, entry.path, localHash);
      const result = replica.edit(id, (doc) => reconcileYTextWithDiskText(doc.getText("content"), local, "disk"));
      if (result === "refused") return this.holdBack(id, entry.path, localHash);
      if (result === "queued") return;
      this.remember(id, entry.path, localHash);
      return;
    }
    if (!(local instanceof Uint8Array)) return;
    if (local.length + 16 > MAX_BYTES.b) return this.holdBack(id, entry.path, localHash);
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
    this.tellOnce(`held:${id}:${localHash}`, `Your change to "${path}" couldn't be shared (it may be too large, or the room's storage is full). It stays on this computer, and isn't overwritten.`);
  }

  /** Was this vault event caused by our own write? Consumes the expectation. */
  private isEcho(path: string, hash: string): boolean {
    const expected = this.expected.get(path);
    if (expected === undefined) return false;
    this.expected.delete(path);
    return expected === hash;
  }

  onLocalWrite(vaultPath: string): Promise<void> {
    return this.run(async () => {
      if (!this.started) return; // taken in by start
      if (this.localOnly.has(vaultPath)) return;
      const relative = this.relative(vaultPath);
      if (relative === null) {
        if (this.unsafeInside(vaultPath)) this.notShared(vaultPath.slice(this.prefix.length), "name");
        return;
      }
      if (!this.o.vault.stat(vaultPath)) return;
      const id = this.idAt(relative);
      const entry = id ? this.o.replica.files().get(id) : undefined;
      const content = isMarkdownPath(relative) ? await this.readNote(vaultPath) : await this.o.vault.readBytes(vaultPath);
      const hash = sha(content);
      if (this.isEcho(vaultPath, hash)) return;
      if (!id || !entry) {
        if (this.o.replica.canWrite()) return this.createEntry(relative);
        return this.readOnlyNotice(`You can only read this room: "${relative}" stays on this computer and isn't shared.`);
      }
      // In doubt whether the others ever had what was made here last time: a pass settles it with the shared copy.
      if (this.doubtful(id)) return;
      const known = this.known.get(id)!;
      if (hash === known.hash) return this.remember(id, relative, hash, known.blob ? { id: known.blob, by: known.mine ? this.o.replica.deviceId : "" } : undefined);
      // An editor owns the note while bound (its edits already went into the shared text): remember what is on disk.
      if (entry.kind === "md" && this.o.isBound(id) && this.o.replica.canWrite()) return this.remember(id, relative, hash);
      // The last save of an editor that just stopped co-editing: already in the shared text.
      if (this.leftByEditor.get(id) === hash) return this.remember(id, relative, hash);
      // The shared version moved on since the last sync and isn't here yet: taking this change in now would undo it, so
      // the next pass settles it like any change made on both sides (keeping a copy).
      if (this.o.replica.canWrite() && (await this.sharedMovedOn(id, entry, known))) return this.remoteChanged();
      await this.localChanged(id, entry, content, hash);
    });
  }

  /** Deletions wait a moment: if the room's whole folder went, that is an unmount here, not deletions for everyone. */
  onLocalDelete(vaultPath: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.deletions.add(vaultPath);
    if (!this.deleteTimer) {
      this.deleteTimer = setTimeout(() => {
        this.deleteTimer = null;
        void this.run(() => this.flushDeletions());
      }, 1000);
    }
    return Promise.resolve();
  }

  private async flushDeletions(): Promise<void> {
    if (!this.started) return;
    const paths = [...this.deletions];
    this.deletions.clear();
    if (!this.o.vault.folderExists(this.o.folder)) {
      this.o.folderGone?.();
      return;
    }
    for (const vaultPath of paths) await this.safely(vaultPath, () => this.applyLocalDelete(vaultPath));
  }

  private async applyLocalDelete(vaultPath: string): Promise<void> {
    this.localOnly.delete(vaultPath);
    const relative = this.relative(vaultPath);
    if (relative === null) return;
    if (this.expected.get(vaultPath) === DELETED) {
      this.expected.delete(vaultPath);
      return;
    }
    if (this.o.vault.stat(vaultPath)) return; // back already
    const id = this.idAt(relative);
    if (!id) return;
    this.known.delete(id);
    if (!this.o.replica.canWrite()) {
      this.readOnlyNotice(`You can only read this room, so "${relative}" was put back.`);
      return this.materializeNow();
    }
    const entry = this.o.replica.files().get(id);
    if (entry) this.o.replica.editIndex((files) => files.set(id, { ...entry, deleted: true }));
    this.saveSoon();
  }

  onLocalRename(oldVaultPath: string, newVaultPath: string): Promise<void> {
    return this.run(async () => {
      if (!this.started) return; // taken in by start
      const expected = this.expected.get(oldVaultPath);
      if (expected === `\u0000moved:${newVaultPath}`) {
        this.expected.delete(oldVaultPath);
        return;
      }
      const from = this.relative(oldVaultPath);
      const to = this.relative(newVaultPath);
      const id = from === null ? undefined : this.idAt(from);
      const unusable = (to === null && this.unsafeInside(newVaultPath)) || (to !== null && !isShareable(to));
      if (id && (to !== null || unusable)) {
        // Renamed within the room: to a name others can't have, or by a reader, it goes back to its old name.
        const back = () => {
          this.expected.set(newVaultPath, `\u0000moved:${oldVaultPath}`);
          return this.o.vault.rename(newVaultPath, oldVaultPath);
        };
        if (unusable) {
          this.tellOnce(`rename:${newVaultPath}`, `"${newVaultPath.slice(this.prefix.length)}" can't be used in a shared room (too long, an unusual character, or a file type that isn't shared). The file keeps its old name.`);
          return back();
        }
        if (!this.o.replica.canWrite()) {
          this.readOnlyNotice("You can only read this room, so the file keeps its old name.");
          return back();
        }
        const entry = this.o.replica.files().get(id);
        if (entry) this.o.replica.editIndex((files) => files.set(id, { ...entry, path: to! }));
        this.known.set(id, { ...this.known.get(id)!, path: to! });
        this.saveSoon();
        return;
      }
      // Moved out of the room: it leaves the room. Moved in: it joins it.
      if (id) {
        this.known.delete(id);
        if (!this.o.replica.canWrite()) return this.materializeNow();
        const entry = this.o.replica.files().get(id);
        if (entry) this.o.replica.editIndex((files) => files.set(id, { ...entry, deleted: true }));
        this.saveSoon();
      }
      if (to !== null && !this.idAt(to)) {
        if (!this.o.replica.canWrite()) return this.readOnlyNotice(`You can only read this room: "${to}" stays on this computer and isn't shared.`);
        await this.createEntry(to);
      }
    });
  }
}
