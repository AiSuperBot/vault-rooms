import { afterEach, describe, expect, it } from "vitest";
import { createJoinRecord, nextVersion, parseInviteLink } from "@vault-rooms/secure";
import { newDevice } from "@vault-rooms/secure/testkit";
import { MeshService, type MeshDeps, type MeshSettings } from "../../src/mesh/meshService.js";
import type { SecretStore } from "../../src/mesh/secrets.js";
import { MemoryFiles } from "./memoryFiles.js";

const services: MeshService[] = [];
afterEach(async () => {
  while (services.length > 0) await services.pop()!.stop();
});

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function deps(name: string): MeshDeps & { notices: string[]; secretValues: Map<string, string> } {
  const secretValues = new Map<string, string>();
  const secrets: SecretStore = { get: (id) => secretValues.get(id) ?? null, set: (id, value) => void secretValues.set(id, value), remove: (id) => void secretValues.delete(id) };
  const settings: MeshSettings = { scope: `test${name.toLowerCase()}scope`, workspace: null };
  const notices: string[] = [];
  return { files: new MemoryFiles(), dataRoot: ".obsidian/plugins/vault-rooms/mesh", secrets, settings, save: async () => {}, notify: (m) => notices.push(m), log: () => {}, notices, secretValues };
}

/** Start a service on localhost with no discovery reach: peers are given by address. */
async function started(service: MeshService): Promise<MeshService> {
  service.settings.port = 0;
  await service.start();
  services.push(service);
  return service;
}

describe("mesh service", () => {
  it("creates a workspace, invites someone, and shares an encrypted room with them", async () => {
    const anaDeps = deps("Ana");
    const ana = await started(await MeshService.create(anaDeps, { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    // Nothing secret in the settings or in the stored files.
    const stored = [...(anaDeps.files as MemoryFiles).data.values()].join("\n") + JSON.stringify(anaDeps.settings);
    for (const secret of anaDeps.secretValues.values()) expect(stored.includes(secret)).toBe(false);

    const roomId = await ana.createRoom("Plans");
    const link = (await ana.createInvite({ [roomId]: "write" })).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const benDeps = deps("Ben");
    const ben = await started(await MeshService.join(benDeps, { link, userName: "Ben", deviceName: "Ben PC" }));
    // Ana's device records the join, hands Ben the room key, and Ben's device can read the room.
    await until(() => ben.rooms().some((room) => room.id === roomId && room.name === "Plans" && room.role === "write"));
    await until(() => ana.node.chain.state.devices[ben.me.deviceId] !== undefined);

    const anaReplica = ana.replica(roomId)!;
    const fileId = "f" + "A".repeat(22);
    anaReplica.editIndex((files) => files.set(fileId, { path: "Plan.md", kind: "md" }));
    anaReplica.noteDoc(fileId).getText("content").insert(0, "Secret plan");
    await until(() => ben.replica(roomId)?.files().has(fileId) === true && ben.replica(roomId)!.noteText(fileId) === "Secret plan");
  });

  it("rotates the room key when a member is removed, so new content is out of their reach", async () => {
    const ana = await started(await MeshService.create(deps("Ana2"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const roomId = await ana.createRoom("Plans");
    const link = (await ana.createInvite({ [roomId]: "write" })).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const ben = await started(await MeshService.join(deps("Ben2"), { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ben.replica(roomId)?.keyFor(1) !== undefined);
    await ana.setMember(roomId, ben.me.userId, null);
    await until(() => ben.replica(roomId) === null);
    expect(ana.state.rooms[roomId]!.epochs).toHaveLength(2);
    expect(ana.replica(roomId)!.sealEpoch()!.n).toBe(2);
    // Ben's device never received a wrap of the new key.
    expect(ana.node.allWraps().some((w) => w.body.room === roomId && w.body.n === 2 && w.body.to === ben.me.deviceId)).toBe(false);
  });

  it("keeps the key of a room whose creation lost a race to someone ranking higher", async () => {
    const ana = await started(await MeshService.create(deps("Ana3"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    await ana.setRoomCreation("members");
    const link = (await ana.createInvite({})).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const ben = await started(await MeshService.join(deps("Ben3"), { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ben.node.chain.state.devices[ben.me.deviceId] !== undefined);
    const parent = ben.node.chain.head;
    const roomId = await ben.createRoom("Design");
    // Ana changed something else at the same moment: her version wins, and Ben's device makes the room again.
    const sibling = nextVersion(ben.settings.id, parent, ana.secrets.sign, (state) => (state.name = "Ana's team"));
    expect(ben.node.offerVersions([sibling]).status).toBe("replaced");
    await until(() => ben.state.rooms[roomId] !== undefined && ben.state.name === "Ana's team");
    await until(() => ben.rooms().find((room) => room.id === roomId)?.name === "Design");
  });

  it("makes a removal that lost a race again, with a new room key in the same change", async () => {
    const ana = await started(await MeshService.create(deps("Ana4"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const link = (await ana.createInvite({})).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const ben = await started(await MeshService.join(deps("Ben4"), { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ben.node.chain.state.devices[ben.me.deviceId] !== undefined);
    await ana.setAdmin(ben.me.userId, true);
    await until(() => ben.isAdmin());
    const roomId = await ben.createRoom("Design");
    // Mal joins the workspace, and Ben adds him to his room.
    const invite = parseInviteLink(await ana.createInvite({}));
    const mal = newDevice(`u${"M".repeat(22)}`, "Mal PC");
    ana.node.addJoin(createJoinRecord({ workspaceId: ana.settings.id, inviteId: invite.inviteId, secret: invite.secret, user: { id: mal.userId, name: "Mal" }, deviceName: mal.name, deviceKey: mal.sign, agreementPublicKey: mal.agree.publicKey, tlsFingerprint: mal.tls }));
    await until(() => ben.node.chain.state.devices[mal.id] !== undefined);
    await ben.setMember(roomId, mal.userId, "write");
    // Ben takes Mal out (with a new key) while Ana, at the same moment, makes him an admin no more: hers wins.
    const parent = ben.node.chain.head;
    await ben.setMember(roomId, mal.userId, null);
    const sibling = nextVersion(ben.settings.id, parent, ana.secrets.sign, (state) => (state.users[ben.me.userId]!.admin = false));
    expect(ben.node.offerVersions([sibling]).status).toBe("replaced");
    await until(() => ben.node.chain.since(sibling.body.v + 1).some((version) => version.body.by === ben.me.deviceId));
    const redo = ben.node.chain.since(sibling.body.v + 1).find((version) => version.body.by === ben.me.deviceId)!;
    expect(redo.body.state.rooms[roomId]!.members[mal.userId]).toBeUndefined();
    expect(redo.body.state.rooms[roomId]!.epochs).toHaveLength(2);
    await until(() => ben.replica(roomId)?.keyFor(2) !== undefined);
  });

  it("withdraws the invite of someone let in and taken back out in a branch that lost a race", async () => {
    const ana = await started(await MeshService.create(deps("Ana5"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const link = (await ana.createInvite({})).replace(/p=[^&]*/, `p=127.0.0.1%3A${ana.listeningPort}`);
    const ben = await started(await MeshService.join(deps("Ben5"), { link, userName: "Ben", deviceName: "Ben PC" }));
    await until(() => ben.node.chain.state.devices[ben.me.deviceId] !== undefined);
    await ana.setAdmin(ben.me.userId, true);
    await until(() => ben.isAdmin());
    // Ana's computer is off from now on (so Ben's device is the one recording the join).
    services.splice(services.indexOf(ana), 1);
    await ana.stop();
    // Ben's invite link leaks; Mal joins with it, Ben's device lets him in, and Ben takes him back out.
    const invite = parseInviteLink(await ben.createInvite({}));
    const parent = ben.node.chain.head;
    const mal = newDevice(`u${"L".repeat(22)}`, "Mal PC");
    ben.node.addJoin(createJoinRecord({ workspaceId: ben.settings.id, inviteId: invite.inviteId, secret: invite.secret, user: { id: mal.userId, name: "Mal" }, deviceName: mal.name, deviceKey: mal.sign, agreementPublicKey: mal.agree.publicKey, tlsFingerprint: mal.tls }));
    await until(() => ben.node.chain.state.devices[mal.id] !== undefined);
    await ben.removeUser(mal.userId);
    // At the same moment, Ana made Ben an admin no more: her change wins, and Mal's recording with it is gone.
    const sibling = nextVersion(ben.settings.id, parent, ana.secrets.sign, (state) => (state.users[ben.me.userId]!.admin = false));
    expect(ben.node.offerVersions([sibling]).status).toBe("replaced");
    await until(() => ben.node.chain.state.invites[invite.inviteId] === undefined);
    expect(ben.state.devices[mal.id]).toBeUndefined();
  });

  it("makes again at once a revocation in a losing branch it didn't sign, while its signer is away", async () => {
    const ana = await started(await MeshService.create(deps("Ana6"), { workspaceName: "Team", userName: "Ana", deviceName: "Ana PC" }));
    const join = async (name: string, letter: string) => {
      const invite = parseInviteLink(await ana.createInvite({}));
      const device = newDevice(`u${letter.repeat(22)}`, `${name} PC`);
      ana.node.addJoin(createJoinRecord({ workspaceId: ana.settings.id, inviteId: invite.inviteId, secret: invite.secret, user: { id: device.userId, name }, deviceName: device.name, deviceKey: device.sign, agreementPublicKey: device.agree.publicKey, tlsFingerprint: device.tls }));
      await until(() => ana.node.chain.state.devices[device.id] !== undefined);
      return device;
    };
    const cy = await join("Cy", "C");
    const mal = await join("Mal", "M");
    const dan = await join("Dan", "D");
    await ana.setAdmin(cy.userId, true);
    // Cy revokes Mal's computer while Ana revokes Dan's, and hers wins; Ana's computer had Cy's change first.
    const parent = ana.node.chain.head;
    expect(ana.node.offerVersions([nextVersion(ana.settings.id, parent, cy.sign, (state) => (state.devices[mal.id]!.revoked = true))]).status).toBe("appended");
    expect(ana.node.offerVersions([nextVersion(ana.settings.id, parent, ana.secrets.sign, (state) => (state.devices[dan.id]!.revoked = true))]).status).toBe("replaced");
    // Cy's computer is away: Ana's makes Cy's revocation again right away, leaving Mal no time to act against Cy.
    await until(() => ana.state.devices[mal.id]!.revoked === true, 2_000);
    expect(ana.state.devices[dan.id]!.revoked).toBe(true);
  });

  it("never goes online once stopped", async () => {
    const service = await MeshService.create(deps("Gone"), { workspaceName: "Team", userName: "Ana", deviceName: "PC" });
    service.settings.port = 0;
    await service.stop();
    await service.start();
    expect(service.listeningPort).toBe(0);
  });

  it("refuses to open when this device's keys are missing (a copied vault), and can still be left", async () => {
    const d = deps("Copy");
    const service = await MeshService.create(d, { workspaceName: "Team", userName: "Ana", deviceName: "PC" });
    await service.stop();
    d.secretValues.clear();
    await expect(MeshService.open(d)).rejects.toThrow(/keys are missing/);
    await MeshService.forgetUnopened(d);
    expect(d.settings.workspace).toBeNull();
    expect([...(d.files as MemoryFiles).data.keys()].filter((key) => key.startsWith(d.dataRoot))).toEqual([]);
  });

});
