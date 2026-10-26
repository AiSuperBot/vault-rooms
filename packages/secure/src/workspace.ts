import { b64u, utf8 } from "./bytes.js";
import { canonicalJson } from "./canonical.js";
import { hashTagged, sign, verify, type KeyPair } from "./crypto.js";
import { fail } from "./errors.js";
import { deviceIdFor, randomId } from "./ids.js";
import { JOIN_EXPIRY_SLACK_MS, parseJoinRecord, verifyJoinProof, type JoinRecord } from "./invite.js";
import * as v from "./validate.js";

/**
 * The workspace record: who is in, their devices, the rooms and who may do what in each, and open invites.
 * It is a linear chain of full-state versions. Version n+1 is valid only if it extends version n, is signed by
 * a device that version n lists as active, and every change it makes is one that device's user may make
 * (`authorize`). Every peer checks every version, so a peer can't fake membership, roles or keys.
 */

export type Role = "read" | "write" | "manage";
export const ROLES: readonly Role[] = ["read", "write", "manage"];
const RANK: Record<Role, number> = { read: 1, write: 2, manage: 3 };

export function roleAtLeast(role: Role | undefined, minimum: Role): boolean {
  return role !== undefined && RANK[role] >= RANK[minimum];
}

export interface UserRecord {
  name: string;
  admin: boolean;
  removed?: true;
}

export interface DeviceRecord {
  user: string;
  name: string;
  /** Ed25519 signing key (raw, base64url). The device id is derived from it. */
  sign: string;
  /** X25519 key that room keys are wrapped to. */
  agree: string;
  /** SHA-256 of the device's TLS certificate (DER), base64url; peers pin it. */
  tls: string;
  revoked?: true;
}

export interface InviteRecord {
  /** The admin who created it. */
  by: string;
  /** Ed25519 key derived from the invite secret; a joiner proves the secret by signing with it. */
  key: string;
  expires: number;
  /** Rooms the joiner gets, each a room the creator manages. */
  rooms: Record<string, Role>;
  /** Join as another device of this existing user instead of as a new user. */
  forUser?: string;
  /** Set when an admin records the join; the invite can't be used again. */
  used?: string;
}

export interface KeyEpoch {
  n: number;
  /** Commitment to the room key of this epoch (see keys.ts). */
  commit: string;
}

/** A room name sealed under one of the room's key epochs, so non-members can't read it. */
export interface SealedName {
  n: number;
  nonce: string;
  ct: string;
}

export interface RoomRecord {
  creator: string;
  name: SealedName;
  members: Record<string, Role>;
  epochs: KeyEpoch[];
  deleted?: true;
}

export interface WorkspaceState {
  name: string;
  roomCreation: "admins" | "members";
  users: Record<string, UserRecord>;
  devices: Record<string, DeviceRecord>;
  invites: Record<string, InviteRecord>;
  rooms: Record<string, RoomRecord>;
}

export interface WorkspaceBody {
  kind: "vr-ws-v1";
  /** Workspace id ("" in the genesis version, whose hash becomes the id). */
  ws: string;
  v: number;
  /** Hash of version v-1 ("" in genesis). */
  prev: string;
  /** Signing device. */
  by: string;
  /** Signer's clock, informational only. */
  at: number;
  state: WorkspaceState;
  /** Join records this version writes into the record (each invite it marks used needs its joiner's proof). */
  joins?: JoinRecord[];
}

export interface SignedVersion {
  body: WorkspaceBody;
  sig: string;
}

const SIG_PURPOSE = "workspace-version";
export const LIMITS = { users: 500, devices: 2000, invites: 500, rooms: 1000, members: 500, epochs: 1000, inviteDays: 30 };

export function versionHash(version: SignedVersion): string {
  return b64u(hashTagged("workspace-version-hash", utf8(canonicalJson(version))));
}

export function signVersion(body: WorkspaceBody, deviceKey: KeyPair): SignedVersion {
  return { body, sig: sign(deviceKey.secretKey, SIG_PURPOSE, utf8(canonicalJson(body))) };
}

// ---- schema ----

function parseRole(value: unknown, field: string): Role {
  return v.oneOf(value, field, ROLES);
}

function parseSealedName(value: unknown, field: string): SealedName {
  const o = v.obj(value, field, ["n", "nonce", "ct"]);
  return { n: v.int(o.n, `${field}.n`, 1, 1e9), nonce: v.b64(o.nonce, `${field}.nonce`, 12), ct: v.b64(o.ct, `${field}.ct`, 16 + 4 * 80 + 16, false) };
}

function parseMembers(value: unknown, field: string): Record<string, Role> {
  const o = v.idMap(value, field, "u", LIMITS.members);
  const out: Record<string, Role> = {};
  for (const [user, role] of Object.entries(o)) out[user] = parseRole(role, `${field}.${user}`);
  return out;
}

/** Validates the shape of an untrusted state and returns a clean copy (no extra keys, no prototype tricks). */
export function parseState(value: unknown): WorkspaceState {
  const o = v.obj(value, "state", ["name", "roomCreation", "users", "devices", "invites", "rooms"]);
  const users: Record<string, UserRecord> = {};
  for (const [userId, raw] of Object.entries(v.idMap(o.users, "users", "u", LIMITS.users))) {
    const u = v.obj(raw, `users.${userId}`, ["name", "admin", "removed"]);
    const removed = v.flag(u.removed, `users.${userId}.removed`);
    users[userId] = { name: v.name(u.name, `users.${userId}.name`), admin: v.bool(u.admin, `users.${userId}.admin`), ...(removed ? { removed } : {}) };
  }
  const devices: Record<string, DeviceRecord> = {};
  for (const [deviceId, raw] of Object.entries(v.idMap(o.devices, "devices", "d", LIMITS.devices))) {
    const d = v.obj(raw, `devices.${deviceId}`, ["user", "name", "sign", "agree", "tls", "revoked"]);
    const signKey = v.b64(d.sign, `devices.${deviceId}.sign`, 32);
    if (deviceIdFor(signKey) !== deviceId) v.bad(`devices.${deviceId}.id`);
    const revoked = v.flag(d.revoked, `devices.${deviceId}.revoked`);
    devices[deviceId] = {
      user: v.id(d.user, `devices.${deviceId}.user`, "u"),
      name: v.name(d.name, `devices.${deviceId}.name`),
      sign: signKey,
      agree: v.b64(d.agree, `devices.${deviceId}.agree`, 32),
      tls: v.hash(d.tls, `devices.${deviceId}.tls`),
      ...(revoked ? { revoked } : {})
    };
  }
  const invites: Record<string, InviteRecord> = {};
  for (const [inviteId, raw] of Object.entries(v.idMap(o.invites, "invites", "i", LIMITS.invites))) {
    const i = v.obj(raw, `invites.${inviteId}`, ["by", "key", "expires", "rooms", "forUser", "used"]);
    const rooms: Record<string, Role> = {};
    for (const [roomId, role] of Object.entries(v.idMap(i.rooms, `invites.${inviteId}.rooms`, "r", 50))) rooms[roomId] = parseRole(role, `invites.${inviteId}.rooms.${roomId}`);
    invites[inviteId] = {
      by: v.id(i.by, `invites.${inviteId}.by`, "u"),
      key: v.b64(i.key, `invites.${inviteId}.key`, 32),
      expires: v.int(i.expires, `invites.${inviteId}.expires`, 0, Number.MAX_SAFE_INTEGER),
      rooms,
      ...(i.forUser !== undefined ? { forUser: v.id(i.forUser, `invites.${inviteId}.forUser`, "u") } : {}),
      ...(i.used !== undefined ? { used: v.id(i.used, `invites.${inviteId}.used`, "d") } : {})
    };
  }
  const rooms: Record<string, RoomRecord> = {};
  for (const [roomId, raw] of Object.entries(v.idMap(o.rooms, "rooms", "r", LIMITS.rooms))) {
    const r = v.obj(raw, `rooms.${roomId}`, ["creator", "name", "members", "epochs", "deleted"]);
    if (!Array.isArray(r.epochs) || r.epochs.length === 0 || r.epochs.length > LIMITS.epochs) v.bad(`rooms.${roomId}.epochs`);
    const epochs = r.epochs.map((e: unknown, index: number) => {
      const eo = v.obj(e, `rooms.${roomId}.epochs.${index}`, ["n", "commit"]);
      const n = v.int(eo.n, `rooms.${roomId}.epochs.${index}.n`, 1, 1e9);
      if (n !== index + 1) v.bad(`rooms.${roomId}.epochs.${index}.n`);
      return { n, commit: v.hash(eo.commit, `rooms.${roomId}.epochs.${index}.commit`) };
    });
    const name = parseSealedName(r.name, `rooms.${roomId}.name`);
    if (name.n > epochs.length) v.bad(`rooms.${roomId}.name.n`);
    const deleted = v.flag(r.deleted, `rooms.${roomId}.deleted`);
    rooms[roomId] = {
      creator: v.id(r.creator, `rooms.${roomId}.creator`, "u"),
      name,
      members: parseMembers(r.members, `rooms.${roomId}.members`),
      epochs,
      ...(deleted ? { deleted } : {})
    };
  }
  return {
    name: v.name(o.name, "name"),
    roomCreation: v.oneOf(o.roomCreation, "roomCreation", ["admins", "members"] as const),
    users,
    devices,
    invites,
    rooms
  };
}

export function parseSignedVersion(value: unknown): SignedVersion {
  const o = v.obj(value, "version", ["body", "sig"]);
  const b = v.obj(o.body, "body", ["kind", "ws", "v", "prev", "by", "at", "state", "joins"]);
  if (b.kind !== "vr-ws-v1") v.bad("body.kind");
  const version = v.int(b.v, "body.v", 0, 1e12);
  const body: WorkspaceBody = {
    kind: "vr-ws-v1",
    ws: version === 0 ? (b.ws === "" ? "" : v.bad("body.ws")) : v.hash(b.ws, "body.ws"),
    v: version,
    prev: version === 0 ? (b.prev === "" ? "" : v.bad("body.prev")) : v.hash(b.prev, "body.prev"),
    by: v.id(b.by, "body.by", "d"),
    at: v.int(b.at, "body.at", 0, Number.MAX_SAFE_INTEGER),
    state: parseState(b.state)
  };
  if (b.joins !== undefined) {
    if (!Array.isArray(b.joins) || b.joins.length === 0 || b.joins.length > 20) v.bad("body.joins");
    body.joins = b.joins.map(parseJoinRecord);
  }
  return { body, sig: v.b64(o.sig, "sig", 64) };
}

// ---- helpers over a state ----

/** A device that may act: listed, not revoked, and its user is listed and not removed. */
export function activeDevice(state: WorkspaceState, deviceId: string): (DeviceRecord & { id: string }) | null {
  const device = state.devices[deviceId];
  if (!device || device.revoked) return null;
  const user = state.users[device.user];
  if (!user || user.removed) return null;
  return { id: deviceId, ...device };
}

export function liveRoom(state: WorkspaceState, roomId: string): RoomRecord | null {
  const room = state.rooms[roomId];
  return room && !room.deleted ? room : null;
}

export function roleIn(state: WorkspaceState, roomId: string, userId: string): Role | undefined {
  const room = liveRoom(state, roomId);
  const user = state.users[userId];
  if (!room || !user || user.removed) return undefined;
  return room.members[userId];
}

function hasActiveAdmin(state: WorkspaceState): boolean {
  return Object.entries(state.users).some(
    ([userId, user]) => user.admin && !user.removed && Object.entries(state.devices).some(([, d]) => d.user === userId && !d.revoked)
  );
}

function hasManager(state: WorkspaceState, room: RoomRecord): boolean {
  return Object.entries(room.members).some(([userId, role]) => role === "manage" && state.users[userId] !== undefined && !state.users[userId]!.removed);
}

// ---- genesis ----

export interface FounderInput {
  workspaceName: string;
  userName: string;
  deviceName: string;
  deviceKey: KeyPair;
  agreementPublicKey: string;
  tlsFingerprint: string;
  roomCreation?: "admins" | "members";
  now?: number;
}

export function createGenesis(input: FounderInput): { genesis: SignedVersion; workspaceId: string; userId: string; deviceId: string } {
  const userId = randomId("u");
  const deviceId = deviceIdFor(input.deviceKey.publicKey);
  const body: WorkspaceBody = {
    kind: "vr-ws-v1",
    ws: "",
    v: 0,
    prev: "",
    by: deviceId,
    at: input.now ?? Date.now(),
    state: {
      name: input.workspaceName,
      roomCreation: input.roomCreation ?? "admins",
      users: { [userId]: { name: input.userName, admin: true } },
      devices: { [deviceId]: { user: userId, name: input.deviceName, sign: input.deviceKey.publicKey, agree: input.agreementPublicKey, tls: input.tlsFingerprint } },
      invites: {},
      rooms: {}
    }
  };
  parseState(body.state);
  const genesis = signVersion(body, input.deviceKey);
  return { genesis, workspaceId: versionHash(genesis), userId, deviceId };
}

/** Checks a genesis version and returns its workspace id. */
export function verifyGenesis(genesis: SignedVersion): string {
  const { body } = genesis;
  if (body.v !== 0 || body.ws !== "" || body.prev !== "") fail("bad_genesis");
  const userIds = Object.keys(body.state.users);
  const deviceIds = Object.keys(body.state.devices);
  if (userIds.length !== 1 || deviceIds.length !== 1 || deviceIds[0] !== body.by) fail("bad_genesis");
  const user = body.state.users[userIds[0]!]!;
  const device = body.state.devices[body.by]!;
  if (!user.admin || user.removed || device.revoked || device.user !== userIds[0]) fail("bad_genesis");
  if (Object.keys(body.state.invites).length !== 0 || Object.keys(body.state.rooms).length !== 0) fail("bad_genesis");
  if (!verify(device.sign, SIG_PURPOSE, utf8(canonicalJson(body)), genesis.sig)) fail("bad_signature");
  return versionHash(genesis);
}

// ---- authorization of one step ----

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function keysOf(...records: Record<string, unknown>[]): string[] {
  return [...new Set(records.flatMap((record) => Object.keys(record)))];
}

function deny(reason: string): never {
  return fail("forbidden", reason);
}

/**
 * Throws SecureError("forbidden", <reason>) unless the signer may make every change from `prev` to `next`.
 * `signerUserId` is the user of an active device in `prev`.
 *
 * The rules, chosen so that no single role can quietly read a room it isn't in:
 * - Admins manage the workspace: its settings, new users, removing users, revoking devices, and invites for new people.
 * - A device is only ever added through an invite marked used in the same version, together with the joiner's record
 *   signed with the invite secret's key; the device and user added must match that record exactly. A new device of
 *   an existing user needs an invite this same user created. So nobody, admins included, can put a device of their
 *   choosing into an invite (which would make the invite's rooms, or that user's rooms, share their keys with it).
 * - Room membership is changed by the room's managers only. An admin's invite may grant rooms the admin manages.
 *   Anyone may leave a room. Writers may add a key epoch (key rotation) but change nothing else.
 * - Users may rename themselves and revoke their own devices.
 */
export function authorize(prev: WorkspaceState, next: WorkspaceState, signerUserId: string, at: number, workspaceId: string, joins: readonly JoinRecord[] = []): void {
  const signer = prev.users[signerUserId]!;
  const admin = signer.admin;

  if ((next.name !== prev.name || next.roomCreation !== prev.roomCreation) && !admin) deny("settings");

  // Invites marked used in this version: with their joiner's proof they justify the devices, users and room grants they bring.
  const newDevices = new Map<string, InviteRecord>();
  const newUsers = new Set<string>();
  const foldedInvites = new Set<string>();
  const grants = new Map<string, Role>();
  for (const inviteId of keysOf(prev.invites, next.invites)) {
    const before = prev.invites[inviteId];
    const after = next.invites[inviteId];
    if (before && after && sameJson(before, after)) continue;
    if (!after) {
      if (!(admin || before!.by === signerUserId)) deny(`invite_withdraw:${inviteId}`);
      continue;
    }
    if (!before) {
      if (after.by !== signerUserId) deny(`invite_by:${inviteId}`);
      if (after.used !== undefined) deny(`invite_used:${inviteId}`);
      if (after.expires > at + LIMITS.inviteDays * 86_400_000) deny(`invite_expiry:${inviteId}`);
      if (after.forUser !== undefined) {
        // A user invites another device of their own; it brings no rooms of its own (the user already has them).
        if (after.forUser !== signerUserId || Object.keys(after.rooms).length !== 0) deny(`invite_device:${inviteId}`);
      } else {
        if (!admin) deny(`invite:${inviteId}`);
        for (const roomId of Object.keys(after.rooms)) if (roleIn(prev, roomId, signerUserId) !== "manage") deny(`invite_room:${inviteId}`);
      }
      continue;
    }
    // The only change to an existing invite: recording the device that used it. Any member may record it, but only
    // with the joiner's own record, signed with the invite secret's key, and only exactly what that record says.
    const { used: usedAfter, ...restAfter } = after;
    const { used: usedBefore, ...restBefore } = before;
    if (!sameJson(restAfter, restBefore) || usedBefore !== undefined || usedAfter === undefined) deny(`invite_changed:${inviteId}`);
    const proofs = joins.filter((join) => join.body.invite === inviteId);
    if (proofs.length !== 1) deny(`invite_proof:${inviteId}`);
    const join = proofs[0]!;
    try {
      verifyJoinProof(workspaceId, inviteId, before, join);
    } catch {
      deny(`invite_proof:${inviteId}`);
    }
    if (at > before.expires + JOIN_EXPIRY_SLACK_MS) deny(`invite_expired:${inviteId}`);
    const { user: joiner, device: joinDevice } = join.body;
    const device = next.devices[usedAfter];
    const expected: DeviceRecord = { user: joiner.id, name: joinDevice.name, sign: joinDevice.sign, agree: joinDevice.agree, tls: joinDevice.tls };
    if (joinDevice.id !== usedAfter || !device || prev.devices[usedAfter] || newDevices.has(usedAfter) || !sameJson(device, expected)) deny(`invite_device:${inviteId}`);
    if (before.forUser !== undefined) {
      if (device.user !== before.forUser) deny(`invite_device_user:${inviteId}`);
    } else {
      if (prev.users[device.user] !== undefined || newUsers.has(device.user)) deny(`invite_device_user:${inviteId}`);
      if (!sameJson(next.users[device.user], { name: joiner.name, admin: false })) deny(`invite_user:${inviteId}`);
      newUsers.add(device.user);
    }
    newDevices.set(usedAfter, before);
    foldedInvites.add(inviteId);
    for (const [roomId, role] of Object.entries(before.rooms)) grants.set(`${roomId}:${device.user}`, role);
  }

  for (const join of joins) if (!foldedInvites.has(join.body.invite)) deny("join_unused");

  for (const userId of keysOf(prev.users, next.users)) {
    const before = prev.users[userId];
    const after = next.users[userId];
    if (!after) deny(`user_deleted:${userId}`);
    if (before && sameJson(before, after)) continue;
    if (!before) {
      if (!(admin || newUsers.has(userId)) || after.removed) deny(`user_add:${userId}`);
      continue;
    }
    if (before.removed && !after.removed) deny(`user_restored:${userId}`);
    const renameOnly = before.admin === after.admin && before.removed === after.removed;
    if (!(admin || (renameOnly && userId === signerUserId))) deny(`user:${userId}`);
  }

  for (const deviceId of keysOf(prev.devices, next.devices)) {
    const before = prev.devices[deviceId];
    const after = next.devices[deviceId];
    if (!after) deny(`device_deleted:${deviceId}`);
    if (before && sameJson(before, after)) continue;
    if (!before) {
      if (!newDevices.has(deviceId) || after.revoked) deny(`device_add:${deviceId}`);
      const owner = next.users[after.user];
      if (!owner || owner.removed) deny(`device_user:${deviceId}`);
      continue;
    }
    if (before.user !== after.user || before.sign !== after.sign || before.agree !== after.agree || before.tls !== after.tls) deny(`device_keys:${deviceId}`);
    if (before.revoked && !after.revoked) deny(`device_restored:${deviceId}`);
    const revokeOnly = before.name === after.name && !before.revoked && after.revoked;
    const renameOnly = before.revoked === after.revoked;
    if (!(admin || (before.user === signerUserId && (revokeOnly || renameOnly)))) deny(`device:${deviceId}`);
  }

  for (const roomId of keysOf(prev.rooms, next.rooms)) {
    const before = prev.rooms[roomId];
    const after = next.rooms[roomId];
    if (!after) deny(`room_deleted:${roomId}`);
    if (before && sameJson(before, after)) continue;
    if (!before) {
      if (prev.roomCreation === "admins" && !admin) deny(`room_create:${roomId}`);
      if (after.creator !== signerUserId || after.members[signerUserId] !== "manage") deny(`room_creator:${roomId}`);
      if (after.deleted || after.epochs.length !== 1) deny(`room_new:${roomId}`);
      for (const member of Object.keys(after.members)) if (!prev.users[member] || prev.users[member]!.removed) deny(`room_member:${roomId}`);
      continue;
    }
    if (before.deleted) deny(`room_gone:${roomId}`);
    const role = roleIn(prev, roomId, signerUserId);
    if (after.creator !== before.creator) deny(`room_creator:${roomId}`);
    if (after.deleted) {
      if (!(admin || role === "manage")) deny(`room_delete:${roomId}`);
      continue;
    }
    // Key epochs are append-only; writers may rotate keys, not only managers.
    if (after.epochs.length < before.epochs.length || !sameJson(after.epochs.slice(0, before.epochs.length), before.epochs)) deny(`room_epochs:${roomId}`);
    if (after.epochs.length > before.epochs.length && !roleAtLeast(role, "write")) deny(`room_rotate:${roomId}`);
    if (!sameJson(after.name, before.name) && role !== "manage") deny(`room_name:${roomId}`);
    for (const member of keysOf(before.members, after.members)) {
      const was = before.members[member];
      const now = after.members[member];
      if (was === now) continue;
      if (now !== undefined && (!next.users[member] || next.users[member]!.removed)) deny(`room_member:${roomId}`);
      if (role === "manage") continue;
      if (now === undefined && member === signerUserId) continue; // anyone may leave
      if (now !== undefined && was === undefined && grants.get(`${roomId}:${member}`) === now) continue;
      deny(`room_members:${roomId}`);
    }
  }

  if (!hasActiveAdmin(next)) deny("no_admin");
  for (const [roomId, room] of Object.entries(next.rooms)) if (!room.deleted && !hasManager(next, room)) deny(`no_manager:${roomId}`);
}

/** Checks `next` as the successor of `prev` (whose hash is `prevHash`). Returns nothing; throws on any problem. */
export function verifyNext(workspaceId: string, prev: SignedVersion, prevHash: string, next: SignedVersion): void {
  const { body } = next;
  if (body.ws !== workspaceId || body.v !== prev.body.v + 1 || body.prev !== prevHash) fail("not_successor");
  const device = activeDevice(prev.body.state, body.by);
  if (!device) fail("forbidden", "signer");
  if (!verify(device.sign, SIG_PURPOSE, utf8(canonicalJson(body)), next.sig)) fail("bad_signature");
  authorize(prev.body.state, body.state, device.user, body.at, workspaceId, body.joins ?? []);
}

/** Build the next version from the current head. `change` edits a deep copy of the state. */
export function nextVersion(
  workspaceId: string,
  head: SignedVersion,
  deviceKey: KeyPair,
  change: (state: WorkspaceState) => void,
  now = Date.now(),
  joins: JoinRecord[] = []
): SignedVersion {
  const state = structuredClone(head.body.state);
  change(state);
  const body: WorkspaceBody = { kind: "vr-ws-v1", ws: workspaceId, v: head.body.v + 1, prev: versionHash(head), by: deviceIdFor(deviceKey.publicKey), at: now, state: parseState(state) };
  if (joins.length > 0) body.joins = joins;
  const next = signVersion(body, deviceKey);
  verifyNext(workspaceId, head, versionHash(head), next);
  return next;
}
