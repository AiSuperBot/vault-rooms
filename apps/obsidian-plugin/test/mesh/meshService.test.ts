import { afterEach, describe, expect, it } from "vitest";
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
    expect(ana.replica(roomId)!.currentEpoch()!.n).toBe(2);
    // Ben's device never received a wrap of the new key.
    expect(ana.node.allWraps().some((w) => w.body.room === roomId && w.body.n === 2 && w.body.to === ben.me.deviceId)).toBe(false);
  });

  it("refuses to open when this device's keys are missing (a copied vault)", async () => {
    const d = deps("Copy");
    const service = await MeshService.create(d, { workspaceName: "Team", userName: "Ana", deviceName: "PC" });
    await service.stop();
    d.secretValues.clear();
    await expect(MeshService.open(d)).rejects.toThrow(/keys are missing/);
  });
});
