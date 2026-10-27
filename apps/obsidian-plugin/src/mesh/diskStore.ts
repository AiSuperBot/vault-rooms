import {
  envelopeKey,
  EnvelopeStore,
  isHash,
  isId,
  parseEnvelope,
  parseJoinRecord,
  parseKeyWrap,
  parseSignedVersion,
  type BlobEnvelope,
  type BlobMeta,
  type BlobStorage,
  type JoinRecord,
  type KeyWrap,
  type SignedVersion,
  type SnapshotEnvelope,
  type StoredEnvelope,
  type UpdateEnvelope
} from "@vault-rooms/secure";

/** The few file operations the store needs (Obsidian's DataAdapter provides all of them). */
export interface Files {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  stat(path: string): Promise<{ size: number; mtime: number } | null>;
}

/**
 * A file name for an id that no other id shares on a disk that ignores case (Windows, macOS): ids are base64url,
 * where "a" and "A" differ, so capitals are written "_a" (and "_" as "__"). Any id at all gets a name, and the
 * name gives the id back.
 */
export function fileNameOf(id: string): string {
  return id.replace(/[A-Z_]/g, (ch) => (ch === "_" ? "__" : `_${ch.toLowerCase()}`));
}

function idOfFileName(name: string): string {
  return name.replace(/_(_|[a-z])/g, (_match, ch: string) => (ch === "_" ? "_" : ch.toUpperCase()));
}

function lastPart(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * What a device keeps of its workspace, under one folder of the plugin's data:
 *   chain.json, joins.json, wraps.json   replaced whole (written to .tmp, then swapped in)
 *   rooms/<room>.json                    what each room folder last synced
 *   docs/<room>/<doc>.jsonl              one encrypted envelope per line, appended; rewritten (with a line of marks)
 *                                        when a snapshot replaces envelopes
 *   blobs/<room>/<author>.<id>.<n>.json  one encrypted attachment version per file; gone.json lists dropped ones
 * Everything here is either public (the signed record) or ciphertext; device secrets live in Obsidian's secret
 * storage. Names are case-safe (see fileNameOf). Envelopes this device makes are on disk before they are sent
 * (`persisted`), so a crash can't lose one that peers already have.
 */
export class DiskStore implements BlobStorage {
  private queues = new Map<string, Promise<void>>();
  private pendingLines = new Map<string, string[]>();
  /** The append that will carry each document's pending lines. */
  private batches = new Map<string, Promise<void>>();
  private pendingWrites = new Map<string, Promise<void>>();
  private rewrites = new Set<string>();
  private goneWrites = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private store: EnvelopeStore | null = null;
  private muted = false;

  constructor(
    private readonly files: Files,
    private readonly root: string
  ) {}

  // ---- serialised writes per file ----

  private queue(path: string, write: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(path) ?? Promise.resolve()).then(write, write);
    const tracked = next.catch(() => {});
    this.queues.set(path, tracked);
    void tracked.then(() => {
      if (this.queues.get(path) === tracked) this.queues.delete(path);
    });
    return next;
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (folder && !(await this.files.exists(folder))) await this.files.mkdir(folder);
    }
  }

  /** Replace a whole file: write a temporary copy, keep the old one aside until the new one is in place. */
  private async swapIn(path: string, data: string): Promise<void> {
    await this.ensureFolder(path);
    await this.files.write(`${path}.tmp`, data);
    if (await this.files.exists(path)) {
      if (await this.files.exists(`${path}.old`)) await this.files.remove(`${path}.old`);
      await this.files.rename(path, `${path}.old`);
    }
    await this.files.rename(`${path}.tmp`, path);
    if (await this.files.exists(`${path}.old`)) await this.files.remove(`${path}.old`);
  }

  private writeWhole(path: string, data: string): Promise<void> {
    return this.queue(path, () => this.swapIn(path, data));
  }

  /** Read a whole file, recovering from a swap that was interrupted. */
  private async readWhole(path: string): Promise<string | null> {
    for (const candidate of [path, `${path}.tmp`, `${path}.old`]) {
      if (!(await this.files.exists(candidate))) continue;
      try {
        const text = await this.files.read(candidate);
        JSON.parse(text);
        return text;
      } catch {
        // A torn copy: try the next one.
      }
    }
    return null;
  }

  // ---- record, joins, wraps ----

  async loadChain(): Promise<SignedVersion[] | null> {
    const text = await this.readWhole(`${this.root}/chain.json`);
    if (text === null) return null;
    return (JSON.parse(text) as unknown[]).map(parseSignedVersion);
  }

  saveChain(versions: SignedVersion[]): Promise<void> {
    return this.writeWhole(`${this.root}/chain.json`, JSON.stringify(versions));
  }

  async loadJoins(): Promise<Array<{ join: JoinRecord; firstSeen: number }>> {
    const text = await this.readWhole(`${this.root}/joins.json`);
    if (text === null) return [];
    const out: Array<{ join: JoinRecord; firstSeen: number }> = [];
    for (const entry of JSON.parse(text) as Array<{ join: unknown; firstSeen: unknown }>) {
      try {
        out.push({ join: parseJoinRecord(entry.join), firstSeen: Number(entry.firstSeen) || Date.now() });
      } catch {
        // skip a bad entry
      }
    }
    return out;
  }

  saveJoins(joins: Array<{ join: JoinRecord; firstSeen: number }>): Promise<void> {
    return this.writeWhole(`${this.root}/joins.json`, JSON.stringify(joins));
  }

  async loadWraps(): Promise<KeyWrap[]> {
    const text = await this.readWhole(`${this.root}/wraps.json`);
    if (text === null) return [];
    const out: KeyWrap[] = [];
    for (const raw of JSON.parse(text) as unknown[]) {
      try {
        out.push(parseKeyWrap(raw));
      } catch {
        // skip
      }
    }
    return out;
  }

  saveWraps(wraps: KeyWrap[]): Promise<void> {
    return this.writeWhole(`${this.root}/wraps.json`, JSON.stringify(wraps));
  }

  // ---- per-room bookkeeping of the vault folder (what was last synced where) ----

  private roomStatePath(roomId: string): string {
    return `${this.root}/rooms/${fileNameOf(roomId)}.json`;
  }

  async loadRoomState<T>(roomId: string): Promise<T | null> {
    const text = await this.readWhole(this.roomStatePath(roomId));
    return text === null ? null : (JSON.parse(text) as T);
  }

  saveRoomState(roomId: string, state: unknown): Promise<void> {
    return this.writeWhole(this.roomStatePath(roomId), JSON.stringify(state));
  }

  // ---- envelopes ----

  private docPath(room: string, doc: string): string {
    return `${this.root}/docs/${fileNameOf(room)}/${fileNameOf(doc)}.jsonl`;
  }

  private blobPath(meta: { room: string; author: string; id: string; n: number }): string {
    return `${this.root}/blobs/${fileNameOf(meta.room)}/${fileNameOf(meta.author)}.${fileNameOf(meta.id)}.${meta.n}.json`;
  }

  private gonePath(room: string): string {
    return `${this.root}/blobs/${fileNameOf(room)}/gone.json`;
  }

  /**
   * The live envelope store, filled from disk and mirrored back to it from then on. Envelopes aren't re-verified:
   * they were verified when they arrived, and checking them against today's membership would drop the history of
   * writers who have since left the room.
   */
  async open(): Promise<EnvelopeStore> {
    const store = new EnvelopeStore(
      {
        added: (env) => this.onAdded(env),
        docChanged: (room, doc) => this.later(this.rewrites, `${room}\u0000${doc}`),
        goneChanged: (room) => this.later(this.goneWrites, room)
      },
      this
    );
    this.store = store;
    this.muted = true;
    try {
      await this.loadDocs(store);
      await this.loadBlobs(store);
    } finally {
      this.muted = false;
    }
    return store;
  }

  private async loadDocs(store: EnvelopeStore): Promise<void> {
    const base = `${this.root}/docs`;
    if (!(await this.files.exists(base))) return;
    for (const roomFolder of (await this.files.list(base)).folders) {
      const room = idOfFileName(lastPart(roomFolder));
      if (!isId(room, "r")) continue;
      // Every copy, a swap's .tmp and .old included: lines are independent and duplicates fold together, so an
      // interrupted rewrite loses nothing.
      for (const file of (await this.files.list(roomFolder)).files) {
        const doc = idOfFileName(lastPart(file).replace(/\.jsonl(\.tmp|\.old)?$/, ""));
        if (doc !== "index" && !isId(doc, "f")) continue;
        let text: string;
        try {
          text = await this.files.read(file);
        } catch {
          continue;
        }
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const raw = JSON.parse(line) as Record<string, unknown>;
            if ("marks" in raw) {
              store.restoreMarks(room, doc, numbers(raw.marks), numbers(raw.claimed));
              continue;
            }
            const env = parseEnvelope(raw);
            if (env.k !== "p" && env.k !== "b" && env.room === room && env.doc === doc) store.add(env);
          } catch {
            // a torn or foreign line
          }
        }
      }
    }
  }

  private async loadBlobs(store: EnvelopeStore): Promise<void> {
    const base = `${this.root}/blobs`;
    if (!(await this.files.exists(base))) return;
    for (const roomFolder of (await this.files.list(base)).folders) {
      const room = idOfFileName(lastPart(roomFolder));
      if (!isId(room, "r")) continue;
      for (const file of (await this.files.list(roomFolder)).files) {
        const name = lastPart(file);
        if (name === "gone.json") {
          try {
            store.restoreGone(room, (JSON.parse(await this.files.read(file)) as Array<[string, number]>).filter(([key, at]) => typeof key === "string" && Number.isFinite(at)));
          } catch {
            // a torn list: dropped blobs may be fetched once more
          }
          continue;
        }
        const match = /^([a-z0-9_-]+)\.([a-z0-9_-]+)\.(\d{1,9})\.json$/.exec(name);
        const author = match ? idOfFileName(match[1]!) : "";
        const id = match ? idOfFileName(match[2]!) : "";
        if (!match || !isId(author, "d") || !isHash(id)) continue;
        const stat = await this.files.stat(file);
        if (stat) store.restoreBlob({ room, author, id, n: Number(match[3]), size: stat.size, at: stat.mtime });
      }
    }
  }

  /** Resolves once an envelope this device made is on disk (see MeshNode.persist). */
  persisted(env: StoredEnvelope): Promise<void> {
    return this.pendingWrites.get(envelopeKey(env)) ?? Promise.resolve();
  }

  private track(env: StoredEnvelope, written: Promise<void>): void {
    const key = envelopeKey(env);
    this.pendingWrites.set(key, written);
    void written.then(
      () => this.pendingWrites.delete(key),
      () => this.pendingWrites.delete(key)
    );
  }

  private onAdded(env: UpdateEnvelope | SnapshotEnvelope): void {
    if (this.muted) return;
    const path = this.docPath(env.room, env.doc);
    const lines = this.pendingLines.get(path);
    if (lines) {
      lines.push(JSON.stringify(env));
    } else {
      this.pendingLines.set(path, [JSON.stringify(env)]);
      this.batches.set(
        path,
        this.queue(path, async () => {
          const batch = this.pendingLines.get(path) ?? [];
          this.pendingLines.delete(path);
          this.batches.delete(path);
          if (batch.length === 0) return;
          await this.ensureFolder(path);
          // Each batch starts on a new line, so a batch torn by a crash can't swallow the next one.
          await this.files.append(path, `\n${batch.join("\n")}`);
        })
      );
    }
    this.track(env, this.batches.get(path)!);
  }

  // ---- blobs (BlobStorage) ----

  put(env: BlobEnvelope): void {
    const path = this.blobPath(env);
    this.track(env, this.queue(path, () => this.swapIn(path, JSON.stringify(env))));
  }

  async get(meta: BlobMeta): Promise<BlobEnvelope | null> {
    const path = this.blobPath(meta);
    await this.queues.get(path);
    try {
      const env = parseEnvelope(JSON.parse(await this.files.read(path)));
      return env.k === "b" && env.room === meta.room && env.author === meta.author && env.id === meta.id && env.n === meta.n ? env : null;
    } catch {
      return null;
    }
  }

  remove(meta: BlobMeta): void {
    const path = this.blobPath(meta);
    void this.queue(path, async () => {
      if (await this.files.exists(path)) await this.files.remove(path);
    });
  }

  // ---- rewrites ----

  private later(set: Set<string>, item: string): void {
    set.add(item);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.runLater(), 500);
  }

  private async runLater(): Promise<void> {
    this.flushTimer = null;
    const store = this.store;
    const docs = [...this.rewrites];
    const rooms = [...this.goneWrites];
    this.rewrites.clear();
    this.goneWrites.clear();
    if (!store) return;
    await Promise.all([
      ...docs.map((target) => {
        const [room, doc] = target.split("\u0000") as [string, string];
        const path = this.docPath(room, doc);
        // Taken when the rewrite runs, after the appends queued before it; appends queued after it follow it (a line
        // written twice is folded together when loading).
        return this.queue(path, async () => {
          const { snapshots, updates } = store.envelopesOf(room, doc);
          const lines = [JSON.stringify(store.marksOf(room, doc)), ...[...snapshots, ...updates].map((env) => JSON.stringify(env))];
          await this.swapIn(path, `${lines.join("\n")}\n`);
        });
      }),
      ...rooms.map((room) => this.writeWhole(this.gonePath(room), JSON.stringify(store.gone(room))))
    ]);
  }

  /** Wait for every write queued so far (call before shutting down). */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      await this.runLater();
    }
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  /** Remove everything this workspace stored on this device (leaving a workspace). */
  async wipe(): Promise<void> {
    await this.flush();
    if (await this.files.exists(this.root)) await this.files.rmdir(this.root, true);
  }
}

function numbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, clock] of Object.entries(value)) if (/^d[A-Za-z0-9_-]{22}$/.test(key) && Number.isSafeInteger(clock) && (clock as number) > 0) out[key] = clock as number;
  return out;
}
