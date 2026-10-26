import { describe, expect, it } from "vitest";
import { MAX_FORK_DEPTH, WorkspaceChain } from "./chain.js";
import { createRoom, founder, invite, step } from "./testkit.js";
import { nextVersion, versionHash } from "./workspace.js";

describe("workspace chain", () => {
  it("appends in order, ignores duplicates and refuses gaps", () => {
    const { chain, admin } = founder();
    const v1 = step(chain, admin, (state) => (state.name = "One"));
    expect(chain.offer([v1])).toEqual({ status: "duplicate" });
    const other = WorkspaceChain.load(chain.all());
    const v2 = nextVersion(chain.workspaceId, chain.head, admin.sign, (state) => (state.name = "Two"));
    chain.offer([v2]);
    const v3 = nextVersion(chain.workspaceId, chain.head, admin.sign, (state) => (state.name = "Three"));
    expect(other.offer([v3])).toEqual({ status: "rejected", reason: "gap" });
    expect(other.offer([v2, v3])).toEqual({ status: "appended", count: 2 });
    expect(other.headHash).toBe(versionHash(v3));
  });

  it("refuses versions from another workspace", () => {
    const a = founder();
    const b = founder();
    const foreign = nextVersion(b.chain.workspaceId, b.chain.head, b.admin.sign, (state) => (state.name = "X"));
    expect(a.chain.offer([foreign])).toEqual({ status: "rejected", reason: "unknown_parent" });
  });

  it("reloads from stored versions", () => {
    const { chain, admin } = founder();
    invite(chain, admin);
    createRoom(chain, admin);
    const reloaded = WorkspaceChain.load(JSON.parse(JSON.stringify(chain.all())));
    expect(reloaded.headHash).toBe(chain.headHash);
    expect(reloaded.state).toEqual(chain.state);
  });

  it("two admins changing things at once converge on the same winner", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const benChain = WorkspaceChain.load(anaChain.all());
    const fromAna = nextVersion(anaChain.workspaceId, anaChain.head, ana.sign, (state) => (state.name = "Ana's name"));
    const fromBen = nextVersion(benChain.workspaceId, benChain.head, ben.sign, (state) => (state.name = "Ben's name"));
    anaChain.offer([fromAna]);
    benChain.offer([fromBen]);
    const anaResult = anaChain.offer([fromBen]);
    const benResult = benChain.offer([fromAna]);
    expect(anaChain.headHash).toBe(benChain.headHash);
    // Ana has been an admin longer, so her version wins, whatever the hashes; Ben is told his was replaced.
    expect(anaChain.state.name).toBe("Ana's name");
    expect(anaResult.status).toBe("rejected");
    expect(benResult).toMatchObject({ status: "replaced", lost: [fromBen] });
  });

  it("a branch that revokes the other side's signer always wins", () => {
    for (let round = 0; round < 6; round++) {
      const { chain: anaChain, admin: ana } = founder();
      const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
      const benChain = WorkspaceChain.load(anaChain.all());
      // Ben renames himself while Ana revokes his device; whatever the hashes, Ana's revocation stands.
      const revoke = nextVersion(anaChain.workspaceId, anaChain.head, ana.sign, (state) => (state.devices[ben.id]!.revoked = true));
      const rename = nextVersion(benChain.workspaceId, benChain.head, ben.sign, (state) => (state.users[ben.userId]!.name = `Ben ${round}`));
      anaChain.offer([revoke]);
      benChain.offer([rename]);
      expect(anaChain.offer([rename]).status).toBe("rejected");
      expect(benChain.offer([revoke]).status).toBe("replaced");
      expect(benChain.headHash).toBe(anaChain.headHash);
      expect(benChain.state.devices[ben.id]!.revoked).toBe(true);
    }
  });

  it("two admins revoking each other: the senior one stands, however the other grinds hashes", () => {
    for (let round = 0; round < 8; round++) {
      const { chain: anaChain, admin: ana } = founder();
      const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
      step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
      const benChain = WorkspaceChain.load(anaChain.all());
      const anaRevokesBen = nextVersion(anaChain.workspaceId, anaChain.head, ana.sign, (state) => (state.devices[ben.id]!.revoked = true));
      // Ben tries many timestamps and keeps the lowest hash he can find.
      let benRevokesAna = nextVersion(benChain.workspaceId, benChain.head, ben.sign, (state) => (state.devices[ana.id]!.revoked = true), 1);
      for (let at = 2; at < 40; at++) {
        const attempt = nextVersion(benChain.workspaceId, benChain.head, ben.sign, (state) => (state.devices[ana.id]!.revoked = true), at);
        if (versionHash(attempt) < versionHash(benRevokesAna)) benRevokesAna = attempt;
      }
      anaChain.offer([anaRevokesBen]);
      benChain.offer([benRevokesAna]);
      anaChain.offer([benRevokesAna]);
      benChain.offer([anaRevokesBen]);
      expect(anaChain.headHash).toBe(benChain.headHash);
      expect(anaChain.state.devices[ben.id]!.revoked).toBe(true);
      expect(anaChain.state.devices[ana.id]!.revoked).toBeUndefined();
    }
  });

  it("demoting an admin counts like revoking them", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const benChain = WorkspaceChain.load(anaChain.all());
    const demote = nextVersion(anaChain.workspaceId, anaChain.head, ana.sign, (state) => (state.users[ben.userId]!.admin = false));
    const revokeAna = nextVersion(benChain.workspaceId, benChain.head, ben.sign, (state) => (state.devices[ana.id]!.revoked = true));
    anaChain.offer([demote]);
    benChain.offer([revokeAna]);
    anaChain.offer([revokeAna]);
    benChain.offer([demote]);
    expect(benChain.headHash).toBe(anaChain.headHash);
    expect(benChain.state.users[ben.userId]!.admin).toBe(false);
  });

  it("refuses to rewrite history further back than the fork limit", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const benChain = WorkspaceChain.load(anaChain.all());
    const benVersion = step(benChain, ben, (state) => (state.name = "Ben's"));
    for (let i = 0; i <= MAX_FORK_DEPTH; i++) step(anaChain, ana, (state) => (state.name = `Ana ${i}`));
    expect(anaChain.offer([benVersion])).toEqual({ status: "rejected", reason: "fork_too_deep" });
    // The other way round it is an ordinary conflict, which Ana's branch wins.
    expect(benChain.offer(anaChain.since(benVersion.body.v)).status).toBe("replaced");
    expect(benChain.headHash).toBe(anaChain.headHash);
  });

  it("settles a deeper fork the same way", () => {
    const { chain: anaChain, admin: ana } = founder();
    const { joiner: ben } = invite(anaChain, ana, { userName: "Ben" });
    step(anaChain, ana, (state) => (state.users[ben.userId]!.admin = true));
    const benChain = WorkspaceChain.load(anaChain.all());
    const a1 = step(anaChain, ana, (state) => (state.name = "A1"));
    const a2 = step(anaChain, ana, (state) => (state.name = "A2"));
    const b1 = step(benChain, ben, (state) => (state.name = "B1"));
    anaChain.offer([b1]);
    benChain.offer([a1, a2]);
    expect(anaChain.headHash).toBe(benChain.headHash);
    expect(anaChain.state.name).toBe("A2");
    expect(versionHash(a1)).not.toBe(versionHash(b1));
  });
});
