import type { FileStat, VaultLike } from "../../src/mesh/roomFolder.js";

/** An in-memory vault that reports writes, deletions and renames the way Obsidian's vault events do. */
export class MemoryVault implements VaultLike {
  readonly files = new Map<string, Uint8Array>();
  readonly trashed: string[] = [];
  private mtimes = new Map<string, number>();
  private clock = 1;
  listener: { write?(path: string): void; delete?(path: string): void; rename?(from: string, to: string): void } = {};

  stat(path: string): FileStat | null {
    const data = this.files.get(path);
    return data ? { size: data.length, mtime: this.mtimes.get(path)! } : null;
  }

  text(path: string): string | undefined {
    const data = this.files.get(path);
    return data ? Buffer.from(data).toString("utf8") : undefined;
  }

  async readText(path: string): Promise<string> {
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT ${path}`);
    return Buffer.from(data).toString("utf8");
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`ENOENT ${path}`);
    return new Uint8Array(data);
  }

  private put(path: string, data: Uint8Array): void {
    this.files.set(path, data);
    this.mtimes.set(path, ++this.clock);
  }

  async writeText(path: string, text: string): Promise<void> {
    this.put(path, new Uint8Array(Buffer.from(text, "utf8")));
    this.listener.write?.(path);
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.put(path, new Uint8Array(bytes));
    this.listener.write?.(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (!data) throw new Error(`ENOENT ${from}`);
    if (this.files.has(to)) throw new Error(`EEXIST ${to}`);
    this.files.delete(from);
    this.put(to, data);
    this.listener.rename?.(from, to);
  }

  async trash(path: string): Promise<void> {
    this.files.delete(path);
    this.trashed.push(path);
    this.listener.delete?.(path);
  }

  listFiles(folder: string): string[] {
    return [...this.files.keys()].filter((path) => path.startsWith(`${folder}/`)).sort();
  }

  /** Change a file without telling anyone (as if edited while Obsidian was closed). */
  silently(path: string, text: string): void {
    this.put(path, new Uint8Array(Buffer.from(text, "utf8")));
  }
}
