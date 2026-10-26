import { fail, SecureError } from "./errors.js";
import { activeDevice, verifyGenesis, verifyNext, versionHash, type SignedVersion, type WorkspaceState } from "./workspace.js";

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

  /** Rebuild from stored versions (each is verified again). */
  static load(versions: SignedVersion[]): WorkspaceChain {
    if (versions.length === 0) fail("empty_chain");
    const chain = new WorkspaceChain(versions[0]!);
    const result = chain.offer(versions.slice(1));
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
   * is the hash of our version `branch[0].body.v - 1`).
   */
  offer(branch: SignedVersion[]): OfferResult {
    if (branch.length === 0) return { status: "duplicate" };
    const start = branch[0]!.body.v;
    if (start < 1) return { status: "rejected", reason: "genesis" };
    if (start > this.versions.length) return { status: "rejected", reason: "gap" };
    const forkHash = this.hashes[start - 1]!;
    if (branch[0]!.body.prev !== forkHash) return { status: "rejected", reason: "unknown_parent" };

    // Verify the whole branch on top of our version start-1.
    const hashes: string[] = [];
    let parent = this.versions[start - 1]!;
    let parentHash = forkHash;
    try {
      for (const version of branch) {
        verifyNext(this.workspaceId, parent, parentHash, version);
        parent = version;
        parentHash = versionHash(version);
        hashes.push(parentHash);
      }
    } catch (error) {
      return { status: "rejected", reason: error instanceof SecureError ? `${error.code}:${error.message}` : "invalid" };
    }

    // Skip the prefix we already have.
    let same = 0;
    while (same < branch.length && this.hashes[start + same] === hashes[same]) same++;
    if (same === branch.length) return { status: "duplicate" };
    const divergeAt = start + same;
    const ours = this.versions.slice(divergeAt);
    const theirs = branch.slice(same);
    const theirHashes = hashes.slice(same);

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
 * Whether branch `a` takes away authority that a version in `b` relied on: it revokes that version's signing
 * device, removes its user, or demotes an admin signer.
 */
function removesAuthorityOf(forkState: WorkspaceState, a: SignedVersion[], b: SignedVersion[]): boolean {
  const finalState = a[a.length - 1]!.body.state;
  return b.some((version) => {
    const signer = activeDevice(forkState, version.body.by);
    if (!signer) return false;
    if (activeDevice(finalState, version.body.by) === null) return true;
    return forkState.users[signer.user]!.admin && !finalState.users[signer.user]?.admin;
  });
}

/** Ordering of a branch's first signer: admins first, then the user listed earliest, then the device id. */
function rank(forkState: WorkspaceState, seniority: Map<string, number>, first: SignedVersion): [number, number, string] {
  const device = activeDevice(forkState, first.body.by)!;
  return [forkState.users[device.user]!.admin ? 0 : 1, seniority.get(device.user) ?? Number.MAX_SAFE_INTEGER, first.body.by];
}

/**
 * True if branch `a` should replace branch `b` (both start right after the same version, which has `forkState`).
 *
 * 1. A branch that takes away authority a version of the other relied on wins, so a device or admin being removed
 *    can't race a branch of its own past the removal.
 * 2. If both or neither do, the branch whose first signer ranks higher wins (`rank`). Rank can't be changed by the
 *    signer, unlike a hash, which a signer can grind by re-signing with small changes.
 * 3. Only two versions from the same device (which has no one to outrank) fall back to the lower hash.
 */
export function preferBranch(
  forkState: WorkspaceState,
  seniority: Map<string, number>,
  a: SignedVersion[],
  aFirstHash: string,
  b: SignedVersion[],
  bFirstHash: string
): boolean {
  const aRemovesB = removesAuthorityOf(forkState, a, b);
  const bRemovesA = removesAuthorityOf(forkState, b, a);
  if (aRemovesB !== bRemovesA) return aRemovesB;
  const ra = rank(forkState, seniority, a[0]!);
  const rb = rank(forkState, seniority, b[0]!);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! < rb[i]!;
  return aFirstHash < bFirstHash;
}
