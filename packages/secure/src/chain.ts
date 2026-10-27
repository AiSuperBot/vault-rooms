import { fail, SecureError } from "./errors.js";
import { activeDevice, MAX_CLOCK_SKEW_MS, roleAtLeast, roleIn, verifyGenesis, verifyNext, versionHash, type SignedVersion, type WorkspaceState } from "./workspace.js";

export type OfferResult =
  | { status: "appended"; count: number }
  | { status: "duplicate" }
  /** Our versions from `lost[0].body.v` on were replaced by a winning branch; their authors should re-apply them. */
  | { status: "replaced"; lost: SignedVersion[]; count: number }
  /** We keep our chain: the branch is invalid, loses, or starts after a gap (fetch the missing versions first). */
  | { status: "rejected"; reason: string };

/**
 * A verified workspace chain. Versions only ever come in through `offer`, which verifies each one against its
 * predecessor. When a peer's branch conflicts with ours (two admins changed things at the same time while apart),
 * every peer picks the same winner (`preferBranch`), so everyone converges.
 */
export class WorkspaceChain {
  readonly workspaceId: string;
  private versions: SignedVersion[];
  private hashes: string[];

  constructor(genesis: SignedVersion) {
    this.workspaceId = verifyGenesis(genesis);
    this.versions = [genesis];
    this.hashes = [this.workspaceId];
  }

  /** Rebuild from versions (each is verified again). With `now`, versions dated too far ahead of it are refused. */
  static load(versions: SignedVersion[], now?: number): WorkspaceChain {
    if (versions.length === 0) fail("empty_chain");
    const chain = new WorkspaceChain(versions[0]!);
    const result = chain.offer(versions.slice(1), now);
    if (versions.length > 1 && result.status !== "appended") fail("bad_chain", result.status === "rejected" ? result.reason : result.status);
    return chain;
  }

  get head(): SignedVersion {
    return this.versions[this.versions.length - 1]!;
  }

  get headHash(): string {
    return this.hashes[this.hashes.length - 1]!;
  }

  get state(): WorkspaceState {
    return this.head.body.state;
  }

  get length(): number {
    return this.versions.length;
  }

  versionAt(v: number): SignedVersion | undefined {
    return this.versions[v];
  }

  hashAt(v: number): string | undefined {
    return this.hashes[v];
  }

  /** Versions from `fromV` to the head, for a peer that is behind. */
  since(fromV: number): SignedVersion[] {
    return this.versions.slice(Math.max(1, fromV));
  }

  all(): SignedVersion[] {
    return [...this.versions];
  }

  /**
   * Offer consecutive versions from a peer. They must start right after a version we have (`branch[0].body.prev`
   * is the hash of our version `branch[0].body.v - 1`). With `now` (this peer's clock), a version dated more than
   * MAX_CLOCK_SKEW_MS after it is refused for now, so no one can push the record's time far into the future.
   */
  offer(branch: SignedVersion[], now?: number): OfferResult {
    if (branch.length === 0) return { status: "duplicate" };
    const start = branch[0]!.body.v;
    if (start < 1) return { status: "rejected", reason: "genesis" };
    if (start > this.versions.length) return { status: "rejected", reason: "gap" };
    if (branch[0]!.body.prev !== this.hashes[start - 1]) return { status: "rejected", reason: "unknown_parent" };

    // Skip the prefix we already have (by hash, before any costly check), then verify only the rest.
    const hashes = branch.map(versionHash);
    let same = 0;
    while (same < branch.length && this.hashes[start + same] === hashes[same]) same++;
    if (same === branch.length) return { status: "duplicate" };
    const divergeAt = start + same;
    const theirs = branch.slice(same);
    const theirHashes = hashes.slice(same);
    let parent = this.versions[divergeAt - 1]!;
    let parentHash = this.hashes[divergeAt - 1]!;
    try {
      for (let i = 0; i < theirs.length; i++) {
        const version = theirs[i]!;
        if (now !== undefined && version.body.at > now + MAX_CLOCK_SKEW_MS) fail("forbidden", "future");
        verifyNext(this.workspaceId, parent, parentHash, version);
        parent = version;
        parentHash = theirHashes[i]!;
      }
    } catch (error) {
      return { status: "rejected", reason: error instanceof SecureError ? `${error.code}:${error.message}` : "invalid" };
    }

    const ours = this.versions.slice(divergeAt);
    if (ours.length === 0) {
      this.versions.push(...theirs);
      this.hashes.push(...theirHashes);
      return { status: "appended", count: theirs.length };
    }
    // A conflict reaching far back is refused: only a long partition with admins busy on both sides produces one
    // legitimately, while a once-trusted signer could otherwise try to rewrite old history.
    if (ours.length > MAX_FORK_DEPTH) return { status: "rejected", reason: "fork_too_deep" };
    const forkState = this.versions[divergeAt - 1]!.body.state;
    const seniority = this.seniority(divergeAt - 1);
    if (!preferBranch(forkState, seniority, theirs, theirHashes[0]!, ours, this.hashes[divergeAt]!)) return { status: "rejected", reason: "loses" };
    this.versions.splice(divergeAt, ours.length, ...theirs);
    this.hashes.splice(divergeAt, ours.length, ...theirHashes);
    return { status: "replaced", lost: ours, count: theirs.length };
  }

  /** For each user present at version `upTo`, the version that first listed them (lower = more senior). */
  private seniority(upTo: number): Map<string, number> {
    const firstSeen = new Map<string, number>();
    for (let v = 0; v <= upTo; v++) for (const userId of Object.keys(this.versions[v]!.body.state.users)) if (!firstSeen.has(userId)) firstSeen.set(userId, v);
    return firstSeen;
  }
}

export const MAX_FORK_DEPTH = 64;

/**
 * Whether branch `a` takes away standing that a version of branch `b` relied on: it revokes a device that signed in
 * `b`, removes that device's user, demotes them as an admin, or lowers or ends their role in a room (deleting the room
 * included). Only what someone else does to them counts: a user can't win a race by giving something of theirs up.
 */
function reducesSignersOf(forkState: WorkspaceState, a: SignedVersion[], b: SignedVersion[]): boolean {
  const signers = new Map<string, string>();
  for (const version of b) {
    const device = activeDevice(forkState, version.body.by);
    if (device) signers.set(version.body.by, device.user);
  }
  const users = new Set(signers.values());
  let prev = forkState;
  for (const version of a) {
    const next = version.body.state;
    const actor = activeDevice(prev, version.body.by)?.user;
    for (const [deviceId, userId] of signers) if (userId !== actor && activeDevice(prev, deviceId) && !activeDevice(next, deviceId)) return true;
    for (const userId of users) {
      if (userId === actor) continue;
      if (prev.users[userId]?.admin && !next.users[userId]?.admin) return true;
      for (const roomId of Object.keys(prev.rooms)) {
        const was = roleIn(prev, roomId, userId);
        if (was === undefined) continue;
        const now = roleIn(next, roomId, userId);
        if (now === undefined || !roleAtLeast(now, was)) return true;
      }
    }
    prev = next;
  }
  return false;
}

/** Ordering of a branch's first signer: admins first, then the user listed earliest. */
function rank(forkState: WorkspaceState, seniority: Map<string, number>, first: SignedVersion): { user: string; order: [number, number] } {
  const device = activeDevice(forkState, first.body.by)!;
  return { user: device.user, order: [forkState.users[device.user]!.admin ? 0 : 1, seniority.get(device.user) ?? Number.MAX_SAFE_INTEGER] };
}

/**
 * True if branch `a` should replace branch `b` (both start right after the same version, which has `forkState`).
 *
 * 1. A branch that takes away standing a version of the other relied on wins (`reducesSignersOf`), so nobody can race
 *    a branch of their own past their removal from the workspace, as an admin, or from a room.
 * 2. Otherwise the branch whose first signer ranks higher wins (`rank`). Rank can't be changed by the signer, unlike a
 *    hash, which a signer can grind by re-signing with small changes. (A key rotation that loses is simply made again
 *    by the automation, which still sees that it is needed.)
 * 3. Two branches started by the same user (on two of their devices): the one carrying more versions by other people
 *    wins, so one user can't throw away others' changes; then the lower device id, then the lower hash.
 */
export function preferBranch(
  forkState: WorkspaceState,
  seniority: Map<string, number>,
  a: SignedVersion[],
  aFirstHash: string,
  b: SignedVersion[],
  bFirstHash: string
): boolean {
  const aReduces = reducesSignersOf(forkState, a, b);
  const bReduces = reducesSignersOf(forkState, b, a);
  if (aReduces !== bReduces) return aReduces;
  const ra = rank(forkState, seniority, a[0]!);
  const rb = rank(forkState, seniority, b[0]!);
  for (let i = 0; i < ra.order.length; i++) if (ra.order[i] !== rb.order[i]) return ra.order[i]! < rb.order[i]!;
  if (ra.user === rb.user) {
    const others = (branch: SignedVersion[]) => branch.filter((version) => activeDevice(forkState, version.body.by)?.user !== ra.user).length;
    const oa = others(a);
    const ob = others(b);
    if (oa !== ob) return oa > ob;
  }
  if (a[0]!.body.by !== b[0]!.body.by) return a[0]!.body.by < b[0]!.body.by;
  return aFirstHash < bFirstHash;
}
