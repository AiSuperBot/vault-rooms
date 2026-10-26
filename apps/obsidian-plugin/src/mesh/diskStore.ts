import {
  envelopeKey,
  parseEnvelope,
  parseJoinRecord,
  parseKeyWrap,
  parseSignedVersion,
  EnvelopeStore,
  type JoinRecord,
  type KeyWrap,
  type SignedVersion,
  type StoredEnvelope
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
}

/**
 * What a device keeps of its workspace, under one folder of the plugin's data:
 *   chain.json, joins.json, wraps.json   replaced whole (written to .tmp, then swapped in)
 *   docs/<room>/<doc>.jsonl              one encrypted envelope per line, appended; rewritten when a snapshot prunes it
 *   blobs/<room>/<id>.json               one encrypted attachment version per file
 * Everything here is either public (the signed record) or ciphertext; device secrets live in Obsidian's secret storage.
 */
export class DiskStore {
  private queues = new Map<string, Promise<void>>();
  private pendingLines = new Map<string, string[]>();
  private rewrites = new Set<string>();
  private rewriteTimer: ReturnType<typeof setTimeout> | null = null;
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
  private writeWhole(path: string, data: string): Promise<void> {
    return this.queue(path, async () => {
      await this.ensureFolder(path);
      await this.files.write(`${path}.tmp`, data);
      if (await this.files.exists(path)) {
        if (await this.files.exists(`${path}.old`)) await this.files.remove(`${path}.old`);
        await this.files.rename(path, `${path}.old`);
      }
      await this.files.rename(`${path}.tmp`, path);
      if (await this.files.exists(`${path}.old`)) await this.files.remove(`${path}.old`);
    });
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

  async loadRoomState<T>(roomId: string): Promise<T | null> {
    const text = await this.readWhole(`${this.root}/rooms/${roomId}.json`);
    return text === null ? null : (JSON.parse(text) as T);
  }

  saveRoomState(roomId: string, state: unknown): Promise<void> {
    return this.writeWhole(`${this.root}/rooms/${roomId}.json`, JSON.stringify(state));
  }

  // ---- envelopes ----

  private docPath(room: string, doc: string): string {
    return `${this.root}/docs/${room}/${doc}.jsonl`;
  }

  private blobPath(room: string, id: string): string {
    return `${this.root}/blobs/${room}/${id}.json`;
  }

  /**
   * The live envelope store, filled from disk and mirrored back to it from then on. Envelopes aren't re-verified:
   * they were verified when they arrived, and checking them against today's membership would drop the history of
   * writers who have since left the room.
   */
  async open(): Promise<EnvelopeStore> {
    const store = new EnvelopeStore({ added: (env) => this.onAdded(env), removed: (env) => this.onRemoved(env) });
    this.store = store;
    this.muted = true;
    try {
      await this.loadEnvelopes(store);
    } finally {
      this.muted = false;
    }
    return store;
  }

  private async loadEnvelopes(store: EnvelopeStore): Promise<number> {
    let count = 0;
    const add = (raw: unknown) => {
      try {
        const env = parseEnvelope(raw);
        if (env.k !== "p" && store.add(env) === "added") count++;
      } catch {
        // a torn or foreign line
      }
    };
    for (const kind of ["docs", "blobs"] as const) {
      const base = `${this.root}/${kind}`;
      if (!(await this.files.exists(base))) continue;
      for (const roomFolder of (await this.files.list(base)).folders) {
        for (const file of (await this.files.list(roomFolder)).files) {
          if (file.endsWith(".tmp") || file.endsWith(".old")) continue;
          let text: string;
          try {
            text = await this.files.read(file);
          } catch {
            continue;
          }
          if (kind === "blobs") {
            try {
              add(JSON.parse(text));
            } catch {
              // torn blob file
            }
          } else {
            for (const line of text.split("\n")) {
              if (!line.trim()) continue;
              try {
                add(JSON.parse(line));
              } catch {
                // torn line
              }
            }
          }
        }
      }
    }
    return count;
  }

  private onAdded(env: StoredEnvelope): void {
    if (this.muted) return;
    if (env.k === "b") {
      void this.queue(this.blobPath(env.room, env.id), async () => {
        const path = this.blobPath(env.room, env.id);
        await this.ensureFolder(path);
        await this.files.write(path, JSON.stringify(env));
      });
      return;
    }
    const path = this.docPath(env.room, env.doc);
    if (this.rewrites.has(path)) return; // the coming rewrite includes it
    const lines = this.pendingLines.get(path);
    if (lines) {
      lines.push(JSON.stringify(env));
      return;
    }
    this.pendingLines.set(path, [JSON.stringify(env)]);
    void this.queue(path, async () => {
      const batch = this.pendingLines.get(path) ?? [];
      this.pendingLines.delete(path);
      if (batch.length === 0) return;
      await this.ensureFolder(path);
      await this.files.append(path, `${batch.join("\n")}\n`);
    });
  }

  private onRemoved(env: StoredEnvelope): void {
    if (this.muted) return;
    if (env.k === "b") {
      const path = this.blobPath(env.room, env.id);
      void this.queue(path, async () => {
        if (await this.files.exists(path)) await this.files.remove(path);
      });
      return;
    }
    // A snapshot pruned updates of this document: rewrite its log from what the store holds now (soon, once).
    this.rewrites.add(`${env.room}\u0000${env.doc}`);
    if (!this.rewriteTimer) this.rewriteTimer = setTimeout(() => void this.runRewrites(), 500);
  }

  private async runRewrites(): Promise<void> {
    this.rewriteTimer = null;
    const store = this.store;
    const targets = [...this.rewrites];
    this.rewrites.clear();
    if (!store) return;
    await Promise.all(
      targets.map((target) => {
        const [room, doc] = target.split("\u0000") as [string, string];
        const { snapshots, updates } = store.envelopesOf(room, doc);
        const path = this.docPath(room, doc);
        this.pendingLines.delete(path);
        const text = [...snapshots, ...updates].map((env) => JSON.stringify(env)).join("\n");
        return this.writeWhole(path, text ? `${text}\n` : "");
      })
    );
  }

  /** Wait for every write queued so far (call before shutting down). */
  async flush(): Promise<void> {
    if (this.rewriteTimer) {
      clearTimeout(this.rewriteTimer);
      await this.runRewrites();
    }
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  /** Remove everything this workspace stored on this device (leaving a workspace). */
  async wipe(): Promise<void> {
    await this.flush();
    if (await this.files.exists(this.root)) await this.files.rmdir(this.root, true);
  }
}

export { envelopeKey };
