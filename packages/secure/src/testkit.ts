// Test helpers (not exported from the package).
import { b64u } from "./bytes.js";
import { WorkspaceChain } from "./chain.js";
import { hashTagged, newAgreementKeyPair, newSigningKeyPair, randomBytes, type KeyPair } from "./crypto.js";
import { deviceIdFor, randomId } from "./ids.js";
import { createJoinRecord, foldJoinInto, newInvite, type JoinRecord } from "./invite.js";
import { keyCommitment, newRoomKey, sealRoomName } from "./keys.js";
import { createGenesis, nextVersion, type Role, type SignedVersion, type WorkspaceState } from "./workspace.js";

export interface TestDevice {
  id: string;
  userId: string;
  name: string;
  sign: KeyPair;
  agree: KeyPair;
  tls: string;
}

export function newDevice(userId: string, name = "PC"): TestDevice {
  const sign = newSigningKeyPair();
  return { id: deviceIdFor(sign.publicKey), userId, name, sign, agree: newAgreementKeyPair(), tls: b64u(hashTagged("tls-test", randomBytes(16))) };
}

export function founder(workspaceName = "Team", userName = "Ana"): { chain: WorkspaceChain; ws: string; admin: TestDevice } {
  const sign = newSigningKeyPair();
  const agree = newAgreementKeyPair();
  const tls = b64u(hashTagged("tls-test", randomBytes(16)));
  const { genesis, workspaceId, userId, deviceId } = createGenesis({ workspaceName, userName, deviceName: "Ana PC", deviceKey: sign, agreementPublicKey: agree.publicKey, tlsFingerprint: tls });
  return { chain: new WorkspaceChain(genesis), ws: workspaceId, admin: { id: deviceId, userId, name: "Ana PC", sign, agree, tls } };
}

/** Sign the next version with `device`, apply it to `chain`, and return it. Throws if the change isn't allowed. */
export function step(chain: WorkspaceChain, device: TestDevice, change: (state: WorkspaceState) => void, now = Date.now()): SignedVersion {
  const version = nextVersion(chain.workspaceId, chain.head, device.sign, change, now);
  const result = chain.offer([version]);
  if (result.status !== "appended") throw new Error(`step not appended: ${JSON.stringify(result)}`);
  return version;
}

export function createRoom(chain: WorkspaceChain, device: TestDevice, name = "Design", members: Record<string, Role> = {}): { roomId: string; key: Uint8Array } {
  const roomId = randomId("r");
  const key = newRoomKey();
  step(chain, device, (state) => {
    state.rooms[roomId] = {
      creator: device.userId,
      name: sealRoomName(chain.workspaceId, roomId, 1, key, name),
      members: { [device.userId]: "manage", ...members },
      epochs: [{ n: 1, commit: keyCommitment(chain.workspaceId, roomId, 1, key) }]
    };
  });
  return { roomId, key };
}

/** An admin invites someone; the new device makes its join record. Optionally the admin folds it into the chain. */
export function invite(
  chain: WorkspaceChain,
  admin: TestDevice,
  options: { rooms?: Record<string, Role>; userName?: string; fold?: boolean; forUser?: TestDevice; expires?: number } = {}
): { joiner: TestDevice; join: JoinRecord; inviteId: string; secret: Uint8Array } {
  const forUser = options.forUser;
  const fresh = newInvite(admin.userId, options.rooms ?? {}, options.expires ?? Date.now() + 86_400_000, forUser?.userId);
  step(chain, admin, (state) => {
    state.invites[fresh.inviteId] = fresh.record;
  });
  const joiner = newDevice(forUser?.userId ?? randomId("u"), `${options.userName ?? "Ben"} PC`);
  const join = createJoinRecord({
    workspaceId: chain.workspaceId,
    inviteId: fresh.inviteId,
    secret: fresh.secret,
    user: { id: joiner.userId, name: forUser ? chain.state.users[forUser.userId]!.name : (options.userName ?? "Ben") },
    deviceName: joiner.name,
    deviceKey: joiner.sign,
    agreementPublicKey: joiner.agree.publicKey,
    tlsFingerprint: joiner.tls
  });
  if (options.fold !== false) step(chain, admin, (state) => foldJoinInto(state, join));
  return { joiner, join, inviteId: fresh.inviteId, secret: fresh.secret };
}
