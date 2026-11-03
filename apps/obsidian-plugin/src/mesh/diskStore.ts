import {
  envelopeKey,
  EnvelopeStore,
  isHash,
  isId,
  parseEnvelope,
  parseJoinRecord,
  parseKeyWrap,
  parseSignedVersion,
  versionHash,
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
 *   rooms/<room>.saves.json              saves of its notes made here outside the editor (see RoomReplica.recentSaves)
 *   docs/<room>/<doc>.jsonl              one encrypted envelope per line, appended; rewritten (with a line of marks)
 *                                        when a snapshot replaces envelopes
 *   blobs/<room>/<author>.<id>.<n>.json  one encrypted attachment version per file; gone.json lists dropped ones
 * Everything here is either public (the signed record) or ciphertext; device secrets live in Obsidian's secret
 * storage. Names are case-safe (see fileNameOf). Envelopes this device makes are on disk before they are sent
 * (`persisted`), so a crash can't lose one that peers already have; a write that failed is made again when asked.
 */
/** Run a file operation, trying again a few times while another program holds the file a moment (EPERM, EBUSY). */
async function held<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (error) {
      if (attempt >= 4 || !/EPERM|EBUSY|EACCES/.test(String((error as { code?: string }).code ?? (error as Error).message))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 << attempt));
    }
  }
}

export class DiskStore implements BlobStorage {
  private queues = new Map<string, Promise<void>>();
  private pendingLines = new Map<string, Map<string, string>>();
  /** The append that will carry each document's pending lines. */
  private batches = new Map<string, Promise<void>>();
  private pendingWrites = new Map<string, Promise<void>>();
  /** Envelopes whose write failed: written again when asked (`persisted`). */
  private failedWrites = new Set<string>();
  private rewrites = new Set<string>();
  private goneWrites = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private store: EnvelopeStore | null = null;
  private muted = false;
  /** Journals that couldn't be read (in use by another program, say), by document ("room\0doc"): tried again. */
  private unread = new Map<string, string[]>();
  private unreadTimer: ReturnType<typeof setTimeout> | null = null;
  /** A journal read late (see unread): its envelopes new to the store, for the owner to take in like news. */
  onLateRead?: (room: string, doc: string, envelopes: StoredEnvelope[]) => void;

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

  /** Folders made or found here: not looked for again on every write (a failed write forgets its folder, see written). */
  private folders = new Set<string>();

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    if (this.folders.has(parts.join("/"))) return;
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (folder && !(await this.files.exists(folder))) await this.files.mkdir(folder);
    }
    this.folders.add(parts.join("/"));
  }

  /** A write that failed may have lost its folder (deleted from outside): it is looked for again next time. */
  private async written(path: string, write: Promise<void>): Promise<void> {
    try {
      await write;
    } catch (error) {
      this.folders.delete(path.split("/").slice(0, -1).join("/"));
      throw error;
    }
  }

  /** Replace a whole file: write a temporary copy, keep the old one aside until the new one is in place. */
  private async swapIn(path: string, data: string): Promise<void> {
    await this.ensureFolder(path);
    await this.written(path, this.files.write(`${path}.tmp`, data));
    if (await this.files.exists(path)) {
      if (await this.files.exists(`${path}.old`)) await this.files.remove(`${path}.old`);
      await held(() => this.files.rename(path, `${path}.old`));
    }
    await held(() => this.files.rename(`${path}.tmp`, path));
    if (await this.files.exists(`${path}.old`)) await this.files.remove(`${path}.old`);
  }

  private writeWhole(path: string, data: string): Promise<void> {
    return this.queue(path, () => this.swapIn(path, data));
  }

  /**
   * Read a whole file, recovering from a swap that was interrupted. `strict`: one that is there but can't be read now
   * (locked, say) throws, rather than reading as no file.
   */
  /** The parsed JSON of a file swapped in whole (see writeWhole), parsed once (attachments can be tens of MB). */
  private async readWhole(path: string, strict = false): Promise<unknown> {
    let locked = false;
    for (const candidate of [path, `${path}.tmp`, `${path}.old`]) {
      if (!(await this.files.exists(candidate))) continue;
      let text: string;
      try {
        text = await this.files.read(candidate);
      } catch {
        locked = true;
        continue;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // A torn copy: try the next one.
      }
    }
    if (locked && strict) throw new Error(`${lastPart(path)} can't be read now (in use by another program?): close that program, then try again`);
    return null;
  }

  // ---- record, joins, wraps ----

  /** A list swapped in whole, read strictly; entries that don't parse are left out. */
  private async readList<T>(path: string, parse: (raw: unknown) => T): Promise<T[]> {
    const saved = await this.readWhole(path, true);
    const out: T[] = [];
    for (const raw of (saved ?? []) as unknown[]) {
      try {
        out.push(parse(raw));
      } catch {
        // a bad entry is skipped
      }
    }
    return out;
  }

  /**
   * The record, as files of CHAIN_SEGMENT versions each, one version per line: a new version is appended, so a change
   * writes that version only, not the whole record (tens of MB once it holds thousands of versions; a single file of
   * it would in the end be too large to read back at all). Read strictly: a locked one is an error, never "none".
   * Reading stops at the first thing that doesn't read whole (a torn line, a segment cut short or missing): the record
   * read is always a prefix of what was saved, never one with a gap (peers send the rest), and the next save writes
   * again from the first segment not read cleanly. chain.json (before 0.3.9) is read too while it is there, and wins
   * if it holds more (a move to segments that stopped half-way).
   */
  async loadChain(): Promise<SignedVersion[] | null> {
    const folder = `${this.root}/chain`;
    await this.listChain();
    const versions: SignedVersion[] = [];
    for (let i = 0; i < this.chainFiles; i++) {
      // A swap stopped half-way leaves the segment as .tmp (new, written whole) or .old (before): read as it was
      // swapped, and written again from there.
      const base = `${folder}/${segmentName(i)}`;
      let path: string | undefined;
      for (const candidate of [base, `${base}.tmp`, `${base}.old`]) if (!path && (await this.files.exists(candidate))) path = candidate;
      // Missing while a later one is there (deleted from outside): written again from here, never appended after.
      if (!path) {
        this.chainDirtyFrom = Math.min(this.chainDirtyFrom, i);
        break;
      }
      if (path !== base) this.chainDirtyFrom = Math.min(this.chainDirtyFrom, i);
      let text: string;
      try {
        text = await this.files.read(path);
      } catch {
        throw new Error(`${segmentName(i)} of the record can't be read now (in use by another program?): close that program, then try again`);
      }
      let count = 0;
      let whole = text.length === 0 || text.endsWith("\n");
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        try {
          versions.push(parseSignedVersion(JSON.parse(line)));
          count++;
        } catch {
          whole = false;
          break;
        }
      }
      if (!whole) this.chainDirtyFrom = Math.min(this.chainDirtyFrom, i);
      // Only the last segment may be short: anything after a short one isn't read.
      if (!whole || count < CHAIN_SEGMENT) {
        if (i < this.chainFiles - 1) this.chainDirtyFrom = Math.min(this.chainDirtyFrom, i);
        break;
      }
    }
    this.chainWritten = versions.slice();
    const before = await this.readWhole(`${this.root}/chain.json`, true);
    if (before !== null && (before as unknown[]).length > versions.length) {
      const older = (before as unknown[]).map(parseSignedVersion);
      // The record is hash-linked: the same version at the segments' end means the same start.
      if (versions.length === 0 || versionHash(older[versions.length - 1]!) === versionHash(versions[versions.length - 1]!)) {
        this.chainWritten = [];
        this.chainDirtyFrom = 0;
        return older;
      }
    }
    return versions.length > 0 ? versions : null;
  }

  /** Which segment files there may be (see loadChain); what they hold isn't known until they are read. */
  private async listChain(): Promise<void> {
    const folder = `${this.root}/chain`;
    const names = (await this.files.exists(folder)) ? (await this.files.list(folder)).files.map(lastPart).filter((name) => SEGMENT.test(name)) : [];
    this.chainFiles = names.reduce((most, name) => Math.max(most, Number(name.slice(0, 6)) + 1), 0);
    this.chainWritten = [];
    this.chainDirtyFrom = Infinity;
    this.chainListed = true;
  }

  /** Store the record: from the first version that isn't on disk as it is in `versions` (see loadChain). */
  saveChain(versions: SignedVersion[]): Promise<void> {
    return this.queue(`${this.root}/chain`, async () => {
      const folder = `${this.root}/chain`;
      // Never read here (a join, say): whatever segment files are there are written over, never appended to.
      if (!this.chainListed) {
        await this.listChain();
        this.chainDirtyFrom = 0;
      }
      const written = this.chainWritten;
      let same = 0;
      while (same < written.length && same < versions.length && written[same] === versions[same]) same++;
      if (same < written.length || this.chainDirtyFrom !== Infinity) {
        // From the segment of the first difference (or the first not read cleanly) on, written again: every file of the
        // later segments removed first, so a stop half-way leaves a shorter record, never one with a gap or with another
        // branch's versions.
        const from = Math.min(Math.floor(same / CHAIN_SEGMENT), this.chainDirtyFrom);
        this.chainDirtyFrom = Math.min(this.chainDirtyFrom, from);
        for (let i = this.chainFiles - 1; i > from; i--) {
          for (const suffix of ["", ".tmp", ".old"]) if (await this.files.exists(`${folder}/${segmentName(i)}${suffix}`)) await this.files.remove(`${folder}/${segmentName(i)}${suffix}`);
        }
        const end = Math.min(versions.length, (from + 1) * CHAIN_SEGMENT);
        await this.swapIn(`${folder}/${segmentName(from)}`, lines(versions.slice(from * CHAIN_SEGMENT, end)));
        this.chainFiles = from + 1;
        this.chainWritten = versions.slice(0, end);
        this.chainDirtyFrom = Infinity;
      }
      // Then appended, segment by segment.
      for (let at = this.chainWritten.length; at < versions.length; ) {
        const segment = Math.floor(at / CHAIN_SEGMENT);
        const end = Math.min(versions.length, (segment + 1) * CHAIN_SEGMENT);
        const path = `${folder}/${segmentName(segment)}`;
        await this.ensureFolder(path);
        this.chainFiles = Math.max(this.chainFiles, segment + 1);
        try {
          await this.written(path, this.files.append(path, lines(versions.slice(at, end))));
        } catch (error) {
          // Part of it may be there: written whole next time.
          this.chainDirtyFrom = segment;
          throw error;
        }
        this.chainWritten = versions.slice(0, end);
        at = end;
      }
      // Stored as segments now: the whole file of before 0.3.9 goes.
      for (const old of ["chain.json", "chain.json.tmp", "chain.json.old"]) if (await this.files.exists(`${this.root}/${old}`)) await this.files.remove(`${this.root}/${old}`);
    });
  }

  /**
   * What the record's files hold (see saveChain): these versions, by object (a version replaced by another isn't one of
   * them), how many segment files there may be, the first segment to be written again whole (Infinity: none), and
   * whether the files were looked at yet.
   */
  private chainWritten: SignedVersion[] = [];
  private chainFiles = 0;
  private chainDirtyFrom = Infinity;
  private chainListed = false;

  async loadJoins(): Promise<Array<{ join: JoinRecord; firstSeen: number }>> {
    return this.readList(`${this.root}/joins.json`, (entry) => ({ join: parseJoinRecord((entry as { join: unknown }).join), firstSeen: Number((entry as { firstSeen: unknown }).firstSeen) || Date.now() }));
  }

  saveJoins(joins: Array<{ join: JoinRecord; firstSeen: number }>): Promise<void> {
    return this.writeWhole(`${this.root}/joins.json`, JSON.stringify(joins));
  }

  async loadWraps(): Promise<KeyWrap[]> {
    return this.readList(`${this.root}/wraps.json`, parseKeyWrap);
  }

  saveWraps(wraps: KeyWrap[]): Promise<void> {
    return this.writeWhole(`${this.root}/wraps.json`, JSON.stringify(wraps));
  }

  // ---- per-room bookkeeping of the vault folder (what was last synced where) ----

  /** A room's file: its state (`kind` ""), or its saves (".saves"). */
  private roomStatePath(roomId: string, kind = ""): string {
    return `${this.root}/rooms/${fileNameOf(roomId)}${kind}.json`;
  }

  /** Null if there is none; throws if it is there but can't be read (better than taking it for none). */
  async loadRoomState<T>(roomId: string, kind = ""): Promise<T | null> {
    return (await this.readWhole(this.roomStatePath(roomId, kind), true)) as T | null;
  }

  saveRoomState(roomId: string, state: unknown, kind = ""): Promise<void> {
    return this.writeWhole(this.roomStatePath(roomId, kind), JSON.stringify(state));
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
      const journals = (await this.files.list(roomFolder)).files
        .map((file) => ({ file, doc: idOfFileName(lastPart(file).replace(/\.jsonl(\.tmp|\.old)?$/, "")) }))
        .filter(({ doc }) => doc === "index" || isId(doc, "f"));
      // Read several at once (tens of thousands of notes), each batch taken in, in order, before the next is read (so
      // only a batch, not the whole room, is in memory as text).
      for (let at = 0; at < journals.length; at += READ_AT_ONCE) {
        const batch = journals.slice(at, at + READ_AT_ONCE);
        const texts = await Promise.all(batch.map(({ file }) => this.readJournal(file)));
        for (const [i, { file, doc }] of batch.entries()) {
          const text = texts[i]!;
          if (text !== null) {
            this.addLines(store, room, doc, text);
            continue;
          }
          // Without it the document would look like it holds less than it does (empty, say), and a note would be written
          // over with that: it stays incomplete until the journal is read (see RoomReplica.isComplete), tried again.
          const key = `${room}\u0000${doc}`;
          this.unread.set(key, [...(this.unread.get(key) ?? []), file]);
          store.setUnreadable(room, doc, true);
        }
      }
    }
    if (this.unread.size > 0) this.retryUnreadSoon();
  }

  /** A journal's text, tried a few times (another program may hold it a moment); "" if it is gone, null if unreadable. */
  private async readJournal(path: string): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.files.read(path);
      } catch {
        if (!(await this.files.exists(path).catch(() => true))) return "";
        if (attempt === 2) return null;
        await new Promise((resolve) => setTimeout(resolve, 100 * 4 ** attempt));
      }
    }
  }

  private addLines(store: EnvelopeStore, room: string, doc: string, text: string, added?: StoredEnvelope[]): void {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        if ("marks" in raw) {
          store.restoreMarks(room, doc, numbers(raw.marks), numbers(raw.claimed), numbers(raw.dropped));
          continue;
        }
        const env = parseEnvelope(raw);
        if (env.k !== "p" && env.k !== "b" && env.room === room && env.doc === doc && store.add(env) === "added") added?.push(env);
      } catch {
        // a torn or foreign line
      }
    }
  }

  /** Journals that couldn't be read yet. */
  unreadDocs(): number {
    return this.unread.size;
  }

  private retryUnreadSoon(): void {
    if (!this.unreadTimer) this.unreadTimer = setTimeout(() => void this.retryUnread(), 5_000);
  }

  /** Read the journals that couldn't be read yet, again (on a timer; tests call it). */
  async retryUnread(): Promise<void> {
    this.unreadTimer = null;
    const store = this.store;
    for (const [key, paths] of [...this.unread]) {
      const texts: string[] = [];
      for (const path of paths) {
        const text = await this.readJournal(path);
        if (text === null) break;
        texts.push(text);
      }
      if (!store || this.store !== store) return;
      if (texts.length < paths.length) continue;
      const [room, doc] = key.split("\u0000") as [string, string];
      this.unread.delete(key);
      const added: StoredEnvelope[] = [];
      // Already on disk: not appended again.
      this.muted = true;
      try {
        for (const text of texts) this.addLines(store, room, doc, text, added);
      } finally {
        this.muted = false;
      }
      store.setUnreadable(room, doc, false);
      // Written once more as the store has it now (lines that came in meanwhile were appended, and are in it).
      this.later(this.rewrites, key);
      this.onLateRead?.(room, doc, added);
    }
    if (this.unread.size > 0 && this.store === store) this.retryUnreadSoon();
  }

  private async loadBlobs(store: EnvelopeStore): Promise<void> {
    const base = `${this.root}/blobs`;
    if (!(await this.files.exists(base))) return;
    for (const roomFolder of (await this.files.list(base)).folders) {
      const room = idOfFileName(lastPart(roomFolder));
      if (!isId(room, "r")) continue;
      const blobs: Array<{ file: string; author: string; id: string; n: number }> = [];
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
        blobs.push({ file, author, id, n: Number(match[3]) });
      }
      const stats = await readAll(blobs, ({ file }) => this.files.stat(file));
      for (const [i, { author, id, n }] of blobs.entries()) {
        const stat = stats[i];
        if (stat) store.restoreBlob({ room, author, id, n, size: stat.size, at: stat.mtime });
      }
    }
  }

  /** Resolves once an envelope is on disk (see MeshNode.persist). */
  persisted(env: StoredEnvelope): Promise<void> {
    const key = envelopeKey(env);
    if (!this.pendingWrites.has(key) && this.failedWrites.has(key)) {
      // A write that failed (a full disk, say) is made again: a line goes with the others of its log waiting to be written.
      if (env.k === "b") this.put(env);
      else this.append(env);
    }
    return this.pendingWrites.get(key) ?? Promise.resolve();
  }

  private track(env: StoredEnvelope, written: Promise<void>): void {
    const key = envelopeKey(env);
    this.pendingWrites.set(key, written);
    const settle = (failed: boolean) => {
      if (this.pendingWrites.get(key) === written) this.pendingWrites.delete(key);
      if (failed) this.failedWrites.add(key);
      else this.failedWrites.delete(key);
    };
    void written.then(
      () => settle(false),
      () => settle(true)
    );
  }

  private onAdded(env: UpdateEnvelope | SnapshotEnvelope): void {
    if (!this.muted) this.append(env);
  }

  /** Append an envelope to its document's log, in one write with the others waiting for it. */
  private append(env: UpdateEnvelope | SnapshotEnvelope): void {
    const path = this.docPath(env.room, env.doc);
    const lines = this.pendingLines.get(path) ?? new Map<string, string>();
    this.pendingLines.set(path, lines);
    lines.set(envelopeKey(env), JSON.stringify(env));
    if (!this.batches.has(path)) {
      this.batches.set(
        path,
        this.queue(path, async () => {
          try {
            // Failed lines stay ahead of later edits, including edits arriving while a write is pending.
            while (lines.size > 0) {
              const batch = [...lines];
              await this.ensureFolder(path);
              await this.written(path, this.files.append(path, `\n${batch.map(([, line]) => line).join("\n")}`));
              for (const [key] of batch) lines.delete(key);
            }
            this.pendingLines.delete(path);
          } finally {
            this.batches.delete(path);
          }
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
    // Locked files throw for retry; interrupted swaps recover from their other copies.
    const saved = await this.readWhole(path, true);
    if (saved === null) return null;
    try {
      const env = parseEnvelope(saved);
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
        // Never written over before it is read: what it holds isn't all in the store (written once it is, see retryUnread).
        if (this.unread.has(target)) return Promise.resolve();
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
    if (this.unreadTimer) clearTimeout(this.unreadTimer);
    this.unreadTimer = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      await this.runLater();
    }
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  /** Drop writes that haven't started (a store let go of without saving; another instance may be using the files). */
  discard(): void {
    if (this.unreadTimer) clearTimeout(this.unreadTimer);
    this.unreadTimer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.rewrites.clear();
    this.goneWrites.clear();
    this.store = null;
  }

  /** Remove everything this workspace stored on this device (leaving a workspace). */
  async wipe(): Promise<void> {
    await this.flush();
    this.folders.clear();
    if (await this.files.exists(this.root)) await this.files.rmdir(this.root, true);
  }
}

/** Versions per file of the record (see DiskStore.loadChain). */
const CHAIN_SEGMENT = 500;
const SEGMENT = /^\d{6}\.jsonl(\.tmp|\.old)?$/;

function segmentName(i: number): string {
  return `${String(i).padStart(6, "0")}.jsonl`;
}

function lines(items: unknown[]): string {
  return items.map((item) => `${JSON.stringify(item)}\n`).join("");
}

/** How many files are read at once when the store opens: a disk serves several in parallel. */
const READ_AT_ONCE = 32;

/** `read` for every item, READ_AT_ONCE at a time; the results in the items' order. */
async function readAll<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += READ_AT_ONCE) for (const result of await Promise.all(items.slice(i, i + READ_AT_ONCE).map(read))) out.push(result);
  return out;
}

function numbers(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const [key, clock] of Object.entries(value)) if (/^d[A-Za-z0-9_-]{22}$/.test(key) && Number.isSafeInteger(clock) && (clock as number) > 0) out[key] = clock as number;
  return out;
}
