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
    const forkState = this.versions[divergeAt - 1]!.body.state;
    if (!preferBranch(forkState, theirs, theirHashes[0]!, ours, this.hashes[divergeAt]!)) return { status: "rejected", reason: "loses" };
    this.versions.splice(divergeAt, ours.length, ...theirs);
    this.hashes.splice(divergeAt, ours.length, ...theirHashes);
    return { status: "replaced", lost: ours, count: theirs.length };
  }
}

/** Whether `a` removes the signer of any version in `b`: revokes its device or removes its user. */
function revokesSignerOf(forkState: WorkspaceState, a: SignedVersion[], b: SignedVersion[]): boolean {
  const finalState = a[a.length - 1]!.body.state;
  return b.some((version) => {
    const signer = activeDevice(forkState, version.body.by);
    return signer !== null && activeDevice(finalState, version.body.by) === null;
  });
}

/**
 * True if branch `a` should replace branch `b` (both start at the same version after the fork).
 * A branch that removes a signer of the other wins, so a device or admin being removed can't race a branch of
 * its own past the removal. Otherwise the branch whose first version has the lower hash wins.
 */
export function preferBranch(forkState: WorkspaceState, a: SignedVersion[], aFirstHash: string, b: SignedVersion[], bFirstHash: string): boolean {
  const aRemovesB = revokesSignerOf(forkState, a, b);
  const bRemovesA = revokesSignerOf(forkState, b, a);
  if (aRemovesB !== bRemovesA) return aRemovesB;
  return aFirstHash < bFirstHash;
}
