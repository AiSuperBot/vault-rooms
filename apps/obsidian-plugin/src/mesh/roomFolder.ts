import { createHash } from "node:crypto";
import { isMarkdownPath, MAX_BYTES, pathKey, randomId, safeRoomPath, type FileEntry, type RoomReplica } from "@vault-rooms/secure";
import { reconcileYTextWithDiskText } from "../crdtReconcile.js";

/**
 * Keeps one room's folder in the vault and the room's shared state in step.
 *
 * Shared -> disk: notes are written from their documents, attachments from their blobs, renames and deletions
 * follow the room index. Disk -> shared: new, changed, renamed and deleted files become index and document edits.
 * Rules that protect data, in order of importance:
 *  - Every path comes through safeRoomPath, so nothing is ever written outside the folder or into dot-folders.
 *  - A file changed both here and remotely since the last sync is never overwritten silently: the local version
 *    is kept as a conflict copy next to it.
 *  - A remote deletion trashes a file only if it is unchanged here; otherwise the local file is shared again.
 *  - In a room this user may only read, local changes are put back and the user is told.
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
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  /** Vault paths of every file under `folder`, recursively. */
  listFiles(folder: string): string[];
}

interface Known extends FileStat {
  path: string;
  hash: string;
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
  loadState(): Promise<RoomFolderState | null>;
  saveState(state: RoomFolderState): Promise<void>;
  notify(message: string): void;
  log(message: string): void;
  now?: () => Date;
}

const DELETED = "\u0000deleted";

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).digest("base64url");
}

function splitName(path: string): { stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? { stem: path.slice(0, dot), ext: path.slice(dot) } : { stem: path, ext: "" };
}

export class RoomFolder {
  private known = new Map<string, Known>();
  private expected = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private materializeTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readOnlyNoticeAt = 0;
  private stopped = false;

  constructor(private readonly o: RoomFolderOptions) {}

  // ---- paths ----

  /** Room-relative path for a vault path inside the folder (null if outside or unsafe). */
  relative(vaultPath: string): string | null {
    const prefix = `${this.o.folder}/`;
    if (!vaultPath.startsWith(prefix)) return null;
    return safeRoomPath(vaultPath.slice(prefix.length));
  }

  private vaultPath(relative: string): string {
    return `${this.o.folder}/${relative}`;
  }

  private idAt(relative: string): string | undefined {
    const key = pathKey(relative);
    for (const [id, known] of this.known) if (pathKey(known.path) === key) return id;
    return undefined;
  }

  /** The file id of a note at a vault path, for the editor binding. */
  noteIdAt(vaultPath: string): string | null {
    const relative = this.relative(vaultPath);
    if (relative === null) return null;
    const id = this.idAt(relative) ?? [...this.o.replica.files()].find(([, entry]) => pathKey(entry.path) === pathKey(relative))?.[0];
    return id && this.o.replica.files().get(id)?.kind === "md" ? id : null;
  }

  // ---- running ----

  private run(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task).catch((error: Error) => this.o.log(`room folder: ${error.stack ?? error.message}`));
    this.queue = next;
    return next;
  }

  async start(): Promise<void> {
    const saved = await this.o.loadState();
    for (const [id, known] of Object.entries(saved?.known ?? {})) this.known.set(id, known);
    await this.run(async () => {
      await this.adoptLocalFiles();
      await this.materializeNow();
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.materializeTimer) clearTimeout(this.materializeTimer);
    return this.run(() => this.saveNow());
  }

  /** Call when the room index or a note changed remotely. */
  remoteChanged(): void {
    if (this.stopped || this.materializeTimer) return;
    this.materializeTimer = setTimeout(() => {
      this.materializeTimer = null;
      void this.run(() => this.materializeNow());
    }, 150);
  }

  /** Wait until everything queued so far has run (tests, shutdown). */
  settled(): Promise<void> {
    if (this.materializeTimer) {
      clearTimeout(this.materializeTimer);
      this.materializeTimer = null;
      void this.run(() => this.materializeNow());
    }
    return this.queue;
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.run(() => this.saveNow());
    }, 500);
  }

  private async saveNow(): Promise<void> {
    await this.o.saveState({ known: Object.fromEntries(this.known) });
  }

  private remember(id: string, path: string, hash: string): void {
    const stat = this.o.vault.stat(this.vaultPath(path));
    this.known.set(id, { path, hash, size: stat?.size ?? -1, mtime: stat?.mtime ?? -1 });
    this.saveSoon();
  }

  private readOnlyNotice(): void {
    if (Date.now() - this.readOnlyNoticeAt < 10_000) return;
    this.readOnlyNoticeAt = Date.now();
    this.o.notify("You can only read this room. Your change was put back.");
  }

  // ---- writing to disk (ours, so the resulting vault events are ignored) ----

  private async writeText(relative: string, text: string): Promise<void> {
    const path = this.vaultPath(relative);
    this.expected.set(path, sha(text));
    await this.o.vault.writeText(path, text);
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

  /** A free name next to `relative` for a copy of a file that would otherwise be lost. */
  private conflictName(relative: string): string {
    const { stem, ext } = splitName(relative);
    const stamp = (this.o.now?.() ?? new Date()).toISOString().slice(0, 16).replace("T", " ").replace(":", "");
    const device = this.o.deviceName.replace(/[\\/:*?"<>|]/g, "").slice(0, 40) || "this device";
    for (let i = 1; ; i++) {
      const candidate = `${stem} (conflict ${device} ${stamp}${i > 1 ? ` ${i}` : ""})${ext}`;
      if (!this.o.vault.stat(this.vaultPath(candidate))) return candidate;
    }
  }

  private async keepAside(relative: string, content: string | Uint8Array): Promise<void> {
    const name = this.conflictName(relative);
    // Not marked as ours: the new file is a local addition and gets shared like any other.
    if (typeof content === "string") await this.o.vault.writeText(this.vaultPath(name), content);
    else await this.o.vault.writeBytes(this.vaultPath(name), content);
    this.o.notify(`"${relative}" was changed here and by someone else at the same time. Your version is kept as "${name}".`);
  }

  // ---- shared -> disk ----

  /** The paths files should have here: index paths, with deterministic suffixes when two entries collide. */
  private desired(): Map<string, FileEntry> {
    const groups = new Map<string, Array<[string, FileEntry]>>();
    for (const [id, entry] of this.o.replica.files()) {
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
    if (this.stopped) return;
    const desired = this.desired();
    // Removals first: a file removed elsewhere may stand where a renamed one has to go.
    for (const [id, known] of [...this.known]) if (!desired.has(id)) await this.applyRemoval(id, known);
    await this.applyRenames(desired);
    for (const [id, entry] of desired) await this.applyContent(id, entry);
    this.saveSoon();
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
        if (this.o.vault.stat(this.vaultPath(to))) continue;
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
        const content = await this.o.vault.readBytes(this.vaultPath(move.to));
        await this.keepAside(move.to, content);
        await this.trash(move.to);
      }
    }
  }

  private async applyContent(id: string, entry: FileEntry): Promise<void> {
    const path = this.vaultPath(entry.path);
    const known = this.known.get(id);
    if (entry.kind === "md" && this.o.isBound(id)) return;
    let remote: string | Uint8Array | null;
    if (entry.kind === "md") remote = this.o.replica.noteText(id);
    else remote = entry.blob ? this.o.replica.readBlob(entry.blob) : null;
    if (remote === null) return; // the attachment hasn't arrived yet
    const remoteHash = sha(remote);
    const stat = this.o.vault.stat(path);
    const write = async () => {
      if (typeof remote === "string") await this.writeText(entry.path, remote);
      else await this.writeBytes(entry.path, remote!);
      this.remember(id, entry.path, remoteHash);
    };
    if (!stat) return write();
    const unchangedHere = known !== undefined && known.path === entry.path && known.size === stat.size && known.mtime === stat.mtime;
    if (unchangedHere) {
      if (remoteHash !== known.hash) await write();
      return;
    }
    const local = entry.kind === "md" ? await this.o.vault.readText(path) : await this.o.vault.readBytes(path);
    const localHash = sha(local);
    if (localHash === remoteHash) return this.remember(id, entry.path, remoteHash);
    if (!known || localHash === known.hash) {
      // Nothing changed here since the last sync (or a file we never tracked sits at this path): the shared copy wins,
      // but an untracked file with content is kept aside first.
      if (!known && (typeof local === "string" ? local.length > 0 : local.length > 0)) await this.keepAside(entry.path, local);
      return write();
    }
    if (remoteHash === known.hash) {
      // Only changed here (e.g. while Obsidian was closed): share the local version.
      return this.localChanged(id, entry, local, localHash);
    }
    // Changed on both sides since the last sync.
    await this.keepAside(entry.path, local);
    await write();
  }

  private async applyRemoval(id: string, known: Known): Promise<void> {
    const path = this.vaultPath(known.path);
    const stat = this.o.vault.stat(path);
    this.known.delete(id);
    if (!stat) return;
    const unchanged = (stat.size === known.size && stat.mtime === known.mtime) || sha(await this.o.vault.readBytes(path)) === known.hash;
    if (unchanged) return this.trash(known.path);
    // Changed here after someone else removed it: keep it, and share it again as a new file.
    if (this.o.replica.canWrite()) await this.createEntry(known.path);
  }

  // ---- disk -> shared ----

  /** Files in the folder that aren't tracked yet become shared files (when this user may write). */
  private async adoptLocalFiles(): Promise<void> {
    if (!this.o.replica.canWrite()) return;
    const indexPaths = new Set([...this.o.replica.files().values()].map((entry) => pathKey(entry.path)));
    for (const path of this.o.vault.listFiles(this.o.folder)) {
      const relative = this.relative(path);
      if (relative === null || this.idAt(relative) || indexPaths.has(pathKey(relative))) continue;
      await this.createEntry(relative);
    }
  }

  private async createEntry(relative: string): Promise<void> {
    const path = this.vaultPath(relative);
    const id = randomId("f");
    if (isMarkdownPath(relative)) {
      const text = await this.o.vault.readText(path);
      this.o.replica.editIndex((files) => files.set(id, { path: relative, kind: "md" }));
      if (text) this.o.replica.noteDoc(id).getText("content").insert(0, text);
      this.remember(id, relative, sha(text));
      return;
    }
    const bytes = await this.o.vault.readBytes(path);
    if (bytes.length + 16 > MAX_BYTES.b) {
      this.o.notify(`"${relative}" is too large to share (over ${Math.floor(MAX_BYTES.b / 1048576) - 1} MB); it stays on this computer only.`);
      return;
    }
    const blob = this.o.replica.putBlob(bytes);
    this.o.replica.editIndex((files) => files.set(id, { path: relative, kind: "bin", blob }));
    this.remember(id, relative, sha(bytes));
  }

  /** Content changed here: put it into the shared state, or put the shared version back in a read-only room. */
  private async localChanged(id: string, entry: FileEntry, local: string | Uint8Array, localHash: string): Promise<void> {
    if (!this.o.replica.canWrite()) {
      this.readOnlyNotice();
      const remote = entry.kind === "md" ? this.o.replica.noteText(id) : entry.blob ? this.o.replica.readBlob(entry.blob) : null;
      if (remote === null) return;
      if (typeof remote === "string") await this.writeText(entry.path, remote);
      else await this.writeBytes(entry.path, remote);
      this.remember(id, entry.path, sha(remote));
      return;
    }
    if (entry.kind === "md" && typeof local === "string") {
      reconcileYTextWithDiskText(this.o.replica.noteDoc(id).getText("content"), local, "disk");
    } else if (local instanceof Uint8Array) {
      if (local.length + 16 > MAX_BYTES.b) {
        this.o.notify(`"${entry.path}" is too large to share; the change stays on this computer only.`);
        return;
      }
      const blob = this.o.replica.putBlob(local);
      this.o.replica.editIndex((files) => files.set(id, { ...entry, blob, ...(entry.blob ? { base: entry.blob.id } : {}) }));
    }
    this.remember(id, entry.path, localHash);
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
      const relative = this.relative(vaultPath);
      if (relative === null || !this.o.vault.stat(vaultPath)) return;
      const id = this.idAt(relative);
      const entry = id ? this.o.replica.files().get(id) : undefined;
      const markdown = isMarkdownPath(relative);
      const content = markdown ? await this.o.vault.readText(vaultPath) : await this.o.vault.readBytes(vaultPath);
      const hash = sha(content);
      if (this.isEcho(vaultPath, hash)) return;
      if (!id || !entry) {
        if (!this.o.replica.canWrite()) return this.readOnlyNotice();
        return this.createEntry(relative);
      }
      if (hash === this.known.get(id)?.hash) return this.remember(id, relative, hash);
      if (entry.kind === "md" && this.o.isBound(id)) return this.remember(id, relative, sha(this.o.replica.noteText(id)));
      await this.localChanged(id, entry, content, hash);
    });
  }

  onLocalDelete(vaultPath: string): Promise<void> {
    return this.run(async () => {
      const relative = this.relative(vaultPath);
      if (relative === null) return;
      if (this.expected.get(vaultPath) === DELETED) {
        this.expected.delete(vaultPath);
        return;
      }
      const id = this.idAt(relative);
      if (!id) return;
      if (!this.o.replica.canWrite()) {
        this.readOnlyNotice();
        this.known.delete(id);
        return this.materializeNow();
      }
      const entry = this.o.replica.files().get(id);
      this.known.delete(id);
      if (entry) this.o.replica.editIndex((files) => files.set(id, { ...entry, deleted: true }));
      this.saveSoon();
    });
  }

  onLocalRename(oldVaultPath: string, newVaultPath: string): Promise<void> {
    return this.run(async () => {
      const expected = this.expected.get(oldVaultPath);
      if (expected === `\u0000moved:${newVaultPath}`) {
        this.expected.delete(oldVaultPath);
        return;
      }
      const from = this.relative(oldVaultPath);
      const to = this.relative(newVaultPath);
      const id = from === null ? undefined : this.idAt(from);
      if (id && to !== null) {
        if (!this.o.replica.canWrite()) {
          this.readOnlyNotice();
          return this.move(to, from!);
        }
        const entry = this.o.replica.files().get(id);
        if (entry) this.o.replica.editIndex((files) => files.set(id, { ...entry, path: to }));
        this.known.set(id, { ...this.known.get(id)!, path: to });
        this.saveSoon();
        return;
      }
      // Moved out of the room: it leaves the room. Moved in: it joins it.
      if (id) {
        if (!this.o.replica.canWrite()) {
          this.known.delete(id);
          return this.materializeNow();
        }
        const entry = this.o.replica.files().get(id);
        this.known.delete(id);
        if (entry) this.o.replica.editIndex((files) => files.set(id, { ...entry, deleted: true }));
        this.saveSoon();
      }
      if (to !== null && !this.idAt(to)) {
        if (!this.o.replica.canWrite()) return this.readOnlyNotice();
        await this.createEntry(to);
      }
    });
  }
}
