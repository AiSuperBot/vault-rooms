import { normalizePath, TFile, TFolder, type App, type DataAdapter } from "obsidian";
import type { Files } from "./diskStore.js";
import type { FileStat, VaultLike } from "./roomFolder.js";

/** The room folders' view of the vault, through Obsidian's vault API (so its caches and editors stay in step). */
export class ObsidianVault implements VaultLike {
  constructor(private readonly app: App) {}

  private file(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFile ? file : null;
  }

  stat(path: string): FileStat | null {
    const file = this.file(path);
    return file ? { size: file.stat.size, mtime: file.stat.mtime } : null;
  }

  async readText(path: string): Promise<string> {
    const file = this.file(path);
    if (!file) throw new Error(`missing ${path}`);
    return this.app.vault.read(file);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const file = this.file(path);
    if (!file) throw new Error(`missing ${path}`);
    return new Uint8Array(await this.app.vault.readBinary(file));
  }

  private async ensureParent(path: string): Promise<void> {
    const parent = path.split("/").slice(0, -1).join("/");
    if (!parent || this.app.vault.getAbstractFileByPath(parent) instanceof TFolder) return;
    await this.app.vault.createFolder(parent).catch(() => {
      // created meanwhile
    });
  }

  async writeText(path: string, text: string): Promise<void> {
    const file = this.file(path);
    if (file) return this.app.vault.modify(file, text);
    await this.ensureParent(path);
    await this.app.vault.create(normalizePath(path), text);
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const file = this.file(path);
    if (file) return this.app.vault.modifyBinary(file, data);
    await this.ensureParent(path);
    await this.app.vault.createBinary(normalizePath(path), data);
  }

  /** A plain move: link updates in other notes made by the person who renamed it arrive as their own edits. */
  async rename(from: string, to: string): Promise<void> {
    const file = this.file(from);
    if (!file) throw new Error(`missing ${from}`);
    await this.ensureParent(to);
    await this.app.vault.rename(file, normalizePath(to));
  }

  /** Follows the user's "deleted files" setting (system trash, Obsidian trash, or delete). */
  async trash(path: string): Promise<void> {
    const file = this.file(path);
    if (file) await this.app.fileManager.trashFile(file);
  }

  listFiles(folder: string): string[] {
    const prefix = `${normalizePath(folder)}/`;
    return this.app.vault
      .getFiles()
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => file.path);
  }
}

/** The plugin's own data (encrypted envelopes, the record), through the vault's data adapter. */
export function adapterFiles(adapter: DataAdapter): Files {
  return {
    exists: (path) => adapter.exists(path),
    read: (path) => adapter.read(path),
    write: (path, data) => adapter.write(path, data),
    append: (path, data) => adapter.append(path, data),
    remove: (path) => adapter.remove(path),
    rename: (from, to) => adapter.rename(from, to),
    mkdir: (path) => adapter.mkdir(path),
    list: (path) => adapter.list(path),
    rmdir: (path, recursive) => adapter.rmdir(path, recursive)
  };
}
