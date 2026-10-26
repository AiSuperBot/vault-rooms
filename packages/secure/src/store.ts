import { b64u, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { hashTagged } from "./crypto.js";
import { envelopeKey, type BlobEnvelope, type DocId, type SnapshotEnvelope, type StoredEnvelope, type UpdateEnvelope } from "./envelope.js";

/** For each author device, the highest clock up to which every update of a document is held (or covered by a snapshot). */
export type VersionVector = Record<string, number>;

export function vvDominates(a: VersionVector, b: VersionVector): boolean {
  return Object.entries(b).every(([author, clock]) => (a[author] ?? 0) >= clock);
}

interface DocEntry {
  updates: Map<string, Map<number, UpdateEnvelope>>;
  /** Kept snapshots by envelope key; none of them dominated by another. */
  snapshots: Map<string, SnapshotEnvelope>;
}

export type AddResult = "added" | "duplicate" | "conflict";

export interface StoreListener {
  added?(env: StoredEnvelope): void;
  removed?(env: StoredEnvelope): void;
}

/**
 * Encrypted envelopes of every room this peer relays, members or not. Pure bookkeeping: callers verify envelopes
 * (`verifyEnvelope`) before adding them. A listener mirrors additions and removals to disk.
 */
export class EnvelopeStore {
  private docsByRoom = new Map<string, Map<DocId, DocEntry>>();
  private blobsByRoom = new Map<string, Map<string, BlobEnvelope>>();
  private signatures = new Map<string, string>();

  constructor(private readonly listener: StoreListener = {}) {}

  private entry(room: string, doc: DocId): DocEntry {
    let docs = this.docsByRoom.get(room);
    if (!docs) this.docsByRoom.set(room, (docs = new Map()));
    let entry = docs.get(doc);
    if (!entry) docs.set(doc, (entry = { updates: new Map(), snapshots: new Map() }));
    return entry;
  }

  /** "conflict": an envelope with the same identity but different content (an author equivocating); the first one stays. */
  add(env: StoredEnvelope): AddResult {
    const key = envelopeKey(env);
    const existing = this.signatures.get(key);
    if (existing !== undefined) return existing === env.sig ? "duplicate" : "conflict";
    if (env.k === "u") {
      const entry = this.entry(env.room, env.doc);
      // Already covered by a kept snapshot: nothing to store.
      if (this.coveredBySnapshot(entry, env.author, env.clock)) return "duplicate";
      let byClock = entry.updates.get(env.author);
      if (!byClock) entry.updates.set(env.author, (byClock = new Map()));
      byClock.set(env.clock, env);
    } else if (env.k === "s") {
      const entry = this.entry(env.room, env.doc);
      for (const kept of entry.snapshots.values()) if (vvDominates(kept.covers, env.covers)) return "duplicate";
      for (const [keptKey, kept] of entry.snapshots) {
        if (vvDominates(env.covers, kept.covers)) {
          entry.snapshots.delete(keptKey);
          this.signatures.delete(keptKey);
          this.listener.removed?.(kept);
        }
      }
      entry.snapshots.set(key, env);
      this.pruneCovered(entry, env.covers);
    } else {
      let blobs = this.blobsByRoom.get(env.room);
      if (!blobs) this.blobsByRoom.set(env.room, (blobs = new Map()));
      blobs.set(env.id, env);
    }
    this.signatures.set(key, env.sig);
    this.listener.added?.(env);
    return "added";
  }

  private coveredBySnapshot(entry: DocEntry, author: string, clock: number): boolean {
    for (const snapshot of entry.snapshots.values()) if ((snapshot.covers[author] ?? 0) >= clock) return true;
    return false;
  }

  private pruneCovered(entry: DocEntry, covers: VersionVector): void {
    for (const [author, upTo] of Object.entries(covers)) {
      const byClock = entry.updates.get(author);
      if (!byClock) continue;
      for (const [clock, update] of byClock) {
        if (clock > upTo) continue;
        byClock.delete(clock);
        this.signatures.delete(envelopeKey(update));
        this.listener.removed?.(update);
      }
      if (byClock.size === 0) entry.updates.delete(author);
    }
  }

  has(env: StoredEnvelope): boolean {
    return this.signatures.has(envelopeKey(env));
  }

  rooms(): string[] {
    return [...new Set([...this.docsByRoom.keys(), ...this.blobsByRoom.keys()])].sort();
  }

  docs(room: string): DocId[] {
    return [...(this.docsByRoom.get(room)?.keys() ?? [])].sort();
  }

  /** Contiguous coverage per author: snapshots first, then consecutive updates after them. */
  vv(room: string, doc: DocId): VersionVector {
    const entry = this.docsByRoom.get(room)?.get(doc);
    const vv: VersionVector = {};
    if (!entry) return vv;
    for (const snapshot of entry.snapshots.values()) for (const [author, clock] of Object.entries(snapshot.covers)) vv[author] = Math.max(vv[author] ?? 0, clock);
    for (const [author, byClock] of entry.updates) {
      let clock = vv[author] ?? 0;
      while (byClock.has(clock + 1)) clock++;
      if (clock > 0) vv[author] = clock;
    }
    return vv;
  }

  /** Highest clock this store holds for one author of a document (to continue numbering after a restart). */
  maxClock(room: string, doc: DocId, author: string): number {
    const entry = this.docsByRoom.get(room)?.get(doc);
    let max = 0;
    for (const snapshot of entry?.snapshots.values() ?? []) max = Math.max(max, snapshot.covers[author] ?? 0);
    for (const clock of entry?.updates.get(author)?.keys() ?? []) max = Math.max(max, clock);
    return max;
  }

  maxSnapshotSeq(room: string, doc: DocId, author: string): number {
    let max = 0;
    for (const snapshot of this.docsByRoom.get(room)?.get(doc)?.snapshots.values() ?? []) if (snapshot.author === author) max = Math.max(max, snapshot.seq);
    return max;
  }

  /** Everything held for a document: snapshots, then updates in clock order per author. */
  envelopesOf(room: string, doc: DocId): { snapshots: SnapshotEnvelope[]; updates: UpdateEnvelope[] } {
    const entry = this.docsByRoom.get(room)?.get(doc);
    if (!entry) return { snapshots: [], updates: [] };
    const updates = [...entry.updates.values()].flatMap((byClock) => [...byClock.values()].sort((a, b) => a.clock - b.clock));
    return { snapshots: [...entry.snapshots.values()], updates };
  }

  /** What a peer that holds `theirs` lacks of this document. */
  missingFor(room: string, doc: DocId, theirs: VersionVector): StoredEnvelope[] {
    const { snapshots, updates } = this.envelopesOf(room, doc);
    return [...snapshots.filter((s) => !vvDominates(theirs, s.covers)), ...updates.filter((u) => u.clock > (theirs[u.author] ?? 0))];
  }

  blob(room: string, id: string): BlobEnvelope | undefined {
    return this.blobsByRoom.get(room)?.get(id);
  }

  blobIds(room: string): string[] {
    return [...(this.blobsByRoom.get(room)?.keys() ?? [])].sort();
  }

  deleteBlob(room: string, id: string): void {
    const env = this.blobsByRoom.get(room)?.get(id);
    if (!env) return;
    this.blobsByRoom.get(room)!.delete(id);
    this.signatures.delete(envelopeKey(env));
    this.listener.removed?.(env);
  }

  snapshotKeys(room: string, doc: DocId): string[] {
    return [...(this.docsByRoom.get(room)?.get(doc)?.snapshots.keys() ?? [])].sort();
  }

  snapshotByKey(room: string, doc: DocId, key: string): SnapshotEnvelope | undefined {
    return this.docsByRoom.get(room)?.get(doc)?.snapshots.get(key);
  }

  /** A short summary of a room's exact contents; two peers with equal digests hold the same envelopes. */
  digest(room: string): string {
    const parts = this.docs(room).map((doc) => {
      const entry = this.docsByRoom.get(room)!.get(doc)!;
      const updates = [...entry.updates].map(([author, byClock]) => [author, [...byClock.keys()].sort((a, b) => a - b)]).sort();
      return [doc, updates, this.snapshotKeys(room, doc)];
    });
    return b64u(hashTagged("room-digest", utf8(canonicalJson({ docs: parts, blobs: this.blobIds(room) }))));
  }
}
