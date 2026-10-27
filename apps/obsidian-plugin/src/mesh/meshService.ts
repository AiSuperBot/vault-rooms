import { networkInterfaces } from "node:os";
import {
  activeDevice,
  canonicalJson,
  createGenesis,
  deviceIdFor,
  Discovery,
  foldJoinInto,
  formatInviteLink,
  INDEX_DOC,
  JOIN_EXPIRY_SLACK_MS,
  joinWorkspace,
  keyCommitment,
  MeshNode,
  newInvite,
  newRoomKey,
  nextVersion,
  openRoomName,
  parseInviteLink,
  PeerManager,
  PeerServer,
  randomId,
  rebaseChange,
  roleAtLeast,
  roleIn,
  RoomReplica,
  sealRoomName,
  WorkspaceChain,
  wrapRoomKey,
  type JoinRecord,
  type MeshEvents,
  type OfferResult,
  type PresenceEnvelope,
  type Role,
  type SignedVersion,
  type TransportConfig,
  type WorkspaceState
} from "@vault-rooms/secure";
import { DiskStore, type Files } from "./diskStore.js";
import { createDeviceSecrets, forgetDeviceSecrets, loadDeviceSecrets, type DeviceSecrets, type SecretStore } from "./secrets.js";

/** What the plugin keeps in its settings about the workspace (nothing secret). */
export interface WorkspaceSettings {
  id: string;
  deviceId: string;
  userId: string;
  /** This device's TLS certificate (public; its key is in secret storage). */
  certPem: string;
  port: number;
  /** Peers given by address ("host:port"), for networks where discovery doesn't reach. */
  peers: string[];
  /** Rooms of this vault and the folder each lives in ("hidden": its folder was deleted here, so it isn't shown). */
  rooms: Record<string, { folder: string; hidden?: true }>;
}

export interface MeshSettings {
  /** Keeps this vault's secrets apart from other vaults' in Obsidian's secret storage. */
  scope: string;
  workspace: WorkspaceSettings | null;
}

export interface MeshDeps {
  files: Files;
  /** Folder (vault-relative) for the plugin's workspace data. */
  dataRoot: string;
  secrets: SecretStore;
  settings: MeshSettings;
  save(): Promise<void>;
  notify(message: string): void;
  log(message: string): void;
}

export const DEFAULT_PORT = 47880;
/** Blobs no file uses any more are dropped after this long. */
const BLOB_GRACE_MS = 7 * 86_400_000;
/** How long a device may go without confirming a key before every holder sends it one. */
const STEP_IN_MS = 60_000;

export interface RoomInfo {
  id: string;
  /** Decrypted name, or null for rooms this device can't read. */
  name: string | null;
  role: Role | undefined;
  members: Record<string, Role>;
  epochs: number;
}

export class MeshServiceError extends Error {}

export class MeshService {
  private listeners = new Set<() => void>();
  private presenceListeners = new Set<(env: PresenceEnvelope) => void>();
  private replicas = new Map<string, RoomReplica>();
  private replicaListeners = new Set<(roomId: string, replica: RoomReplica | null) => void>();
  private activityListeners = new Set<(roomId: string) => void>();
  private refusedListeners = new Set<(roomId: string, docId: string, code: string) => void>();
  private lostRoomListeners = new Set<(roomId: string) => void>();
  private server: PeerServer | null = null;
  private manager: PeerManager | null = null;
  private discovery: Discovery | null = null;
  private port = 0;
  private timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  private automateTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private automating = false;
  /** Keys of rooms this device just created, handed to the replica before anyone hears of it. */
  private ownKeys = new Map<string, { n: number; key: Uint8Array }>();
  private quotaNoticeAt = new Map<string, number>();
  /** Since when each (room, epoch, device) has been seen without a receipt for the key. */
  private missingSince = new Map<string, number>();
  private stopped = false;

  private constructor(
    readonly deps: MeshDeps,
    readonly node: MeshNode,
    readonly disk: DiskStore,
    readonly secrets: DeviceSecrets,
    readonly settings: WorkspaceSettings,
    events: MeshEvents
  ) {
    events.chain = (result) => this.onChain(result);
    events.membership = () => {
      this.saveSoon("joins", () => this.disk.saveJoins(this.node.joinEntries()));
      this.syncReplicas();
      this.automateSoon();
      this.emit();
    };
    events.wraps = () => {
      this.saveSoon("wraps", () => this.disk.saveWraps(this.node.allWraps()));
      this.refreshKeys();
      this.automateSoon();
      this.emit();
    };
    events.envelope = (env) => {
      const replica = this.replicas.get(env.room);
      if (!replica) return;
      replica.receive(env);
      this.roomActivity(env.room);
    };
    events.presence = (env) => {
      for (const listener of this.presenceListeners) listener(env);
    };
    events.stored = (env) => this.roomActivity(env.room);
    events.sessions = () => this.emit();
    events.rejected = (reason, from) => {
      this.deps.log(`refused from ${from}: ${reason}`);
      if (reason.startsWith("quota:")) this.quotaNotice(reason.slice(6));
    };
    node.persist = (env) => this.disk.persisted(env);
  }

  // ---- creating, joining, opening ----

  private static diskFor(deps: MeshDeps, workspaceId: string): DiskStore {
    return new DiskStore(deps.files, `${deps.dataRoot}/${workspaceId.slice(0, 16).replace(/[^A-Za-z0-9]/g, "_")}`);
  }

  static async create(deps: MeshDeps, input: { workspaceName: string; userName: string; deviceName: string }): Promise<MeshService> {
    if (deps.settings.workspace) throw new MeshServiceError("This vault already belongs to a workspace.");
    const { secrets, certPem } = await createDeviceSecrets(deps.secrets, deps.settings.scope);
    const { genesis, workspaceId, userId, deviceId } = createGenesis({
      workspaceName: input.workspaceName,
      userName: input.userName,
      deviceName: input.deviceName,
      deviceKey: secrets.sign,
      agreementPublicKey: secrets.agree.publicKey,
      tlsFingerprint: secrets.tls.fingerprint
    });
    await MeshService.diskFor(deps, workspaceId).saveChain([genesis]);
    deps.settings.workspace = { id: workspaceId, deviceId, userId, certPem, port: DEFAULT_PORT, peers: [], rooms: {} };
    await deps.save();
    return (await MeshService.open(deps))!;
  }

  static async join(deps: MeshDeps, input: { link: string; userName: string; deviceName: string; peers?: string[] }): Promise<MeshService> {
    if (deps.settings.workspace) throw new MeshServiceError("This vault already belongs to a workspace.");
    const invite = parseInviteLink(input.link);
    const { secrets, certPem } = await createDeviceSecrets(deps.secrets, deps.settings.scope);
    const extraPeers = (input.peers ?? []).map(parseAddress).filter((a): a is { host: string; port: number } => a !== null);
    let joined: Awaited<ReturnType<typeof joinWorkspace>>;
    try {
      joined = await joinWorkspace({ invite, extraPeers, userName: input.userName, deviceName: input.deviceName, deviceKey: secrets.sign, agreementKey: secrets.agree, tls: secrets.tls, newUserId: randomId("u") });
    } catch (error) {
      forgetDeviceSecrets(deps.secrets, deps.settings.scope);
      throw new MeshServiceError(`Couldn't reach the workspace: ${(error as Error).message}`);
    }
    const disk = MeshService.diskFor(deps, invite.workspaceId);
    await disk.saveChain(joined.chain.all());
    await disk.saveJoins([{ join: joined.join, firstSeen: Date.now() }]);
    deps.settings.workspace = { id: invite.workspaceId, deviceId: joined.join.body.device.id, userId: joined.join.body.user.id, certPem, port: DEFAULT_PORT, peers: input.peers ?? [], rooms: {} };
    await deps.save();
    const service = (await MeshService.open(deps))!;
    service.adoptFirstLink = joined.link;
    return service;
  }

  private adoptFirstLink: Parameters<PeerManager["adopt"]>[0] | null = null;

  /** Reopen the workspace this vault belongs to (null if none). */
  static async open(deps: MeshDeps): Promise<MeshService | null> {
    const settings = deps.settings.workspace;
    if (!settings) return null;
    const secrets = loadDeviceSecrets(deps.secrets, deps.settings.scope, settings.certPem);
    if (!secrets) throw new MeshServiceError("This device's keys are missing (was the vault copied from another computer?). Leave the workspace and join again from this computer.");
    if (deviceIdFor(secrets.sign.publicKey) !== settings.deviceId) throw new MeshServiceError("This device's keys don't belong to this vault's workspace. Leave the workspace and join again from this computer.");
    const disk = MeshService.diskFor(deps, settings.id);
    const versions = await disk.loadChain();
    if (!versions) throw new MeshServiceError("The workspace record is missing from this vault.");
    const chain = WorkspaceChain.load(versions);
    if (chain.workspaceId !== settings.id) throw new MeshServiceError("The stored workspace record doesn't match this vault's workspace.");
    const store = await disk.open();
    const events: MeshEvents = {};
    const node = new MeshNode(chain, settings.deviceId, events, store);
    const service = new MeshService(deps, node, disk, secrets, settings, events);
    node.restore(await disk.loadJoins(), await disk.loadWraps());
    service.syncReplicas();
    return service;
  }

  /** Leave when the workspace can't even be opened: delete its data and this device's keys, and forget it. */
  static async forgetUnopened(deps: MeshDeps): Promise<void> {
    const settings = deps.settings.workspace;
    if (settings) await MeshService.diskFor(deps, settings.id).wipe();
    forgetDeviceSecrets(deps.secrets, deps.settings.scope);
    deps.settings.workspace = null;
    await deps.save();
  }

  // ---- running ----

  async start(): Promise<void> {
    const config: TransportConfig = { workspaceId: this.settings.id, deviceId: this.settings.deviceId, deviceKey: this.secrets.sign, tls: this.secrets.tls, membership: () => this.node.effective() };
    this.manager = new PeerManager(this.node, config, () => this.settings.peers.map(parseAddress).filter((a): a is { host: string; port: number } => a !== null), {
      connected: () => this.emit(),
      disconnected: () => this.emit(),
      dialFailed: (target, reason) => this.deps.log(`dial ${target}: ${reason}`)
    });
    this.server = new PeerServer(config, (link) => this.manager?.accept(link), (reason, address) => this.deps.log(`refused ${address}: ${reason}`));
    this.port = await this.listen(this.settings.port || DEFAULT_PORT);
    if (this.port !== this.settings.port) {
      this.settings.port = this.port;
      await this.deps.save();
    }
    this.manager.start();
    if (this.adoptFirstLink) {
      this.manager.adopt(this.adoptFirstLink);
      this.adoptFirstLink = null;
    }
    this.discovery = new Discovery({
      workspaceId: this.settings.id,
      deviceId: this.settings.deviceId,
      deviceKey: this.secrets.sign,
      port: () => this.port,
      membership: () => this.node.effective(),
      onPeer: (device, host, port) => this.manager?.candidate(device, host, port)
    });
    await this.discovery.start();
    const timer = setInterval(() => this.automateSoon(), 30_000);
    this.timers.push(timer);
    this.automateSoon();
    this.emit();
  }

  private async listen(preferred: number): Promise<number> {
    for (let port = preferred; port < preferred + 10; port++) {
      try {
        return await this.server!.listen(port);
      } catch {
        // busy: try the next one
      }
    }
    return this.server!.listen(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.node.stop();
    for (const timer of this.timers) clearInterval(timer as ReturnType<typeof setInterval>);
    if (this.automateTimer) clearTimeout(this.automateTimer);
    this.discovery?.stop();
    this.manager?.stop();
    await this.server?.close();
    for (const [key, timer] of this.saveTimers) {
      clearTimeout(timer);
      this.saveTimers.delete(key);
    }
    await this.disk.saveChain(this.node.chain.all());
    await this.disk.saveJoins(this.node.joinEntries());
    await this.disk.saveWraps(this.node.allWraps());
    await this.disk.flush();
    for (const replica of this.replicas.values()) replica.destroy();
    this.replicas.clear();
  }

  /** Leave on this device: stop, and delete the workspace data and this device's keys. */
  async forget(): Promise<void> {
    await this.stop();
    await this.disk.wipe();
    forgetDeviceSecrets(this.deps.secrets, this.deps.settings.scope);
    this.deps.settings.workspace = null;
    await this.deps.save();
  }

  // ---- events ----

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onPresence(listener: (env: PresenceEnvelope) => void): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  onReplica(listener: (roomId: string, replica: RoomReplica | null) => void): () => void {
    this.replicaListeners.add(listener);
    return () => this.replicaListeners.delete(listener);
  }

  /** Something arrived for a room (content or a key): its folder should look again. */
  onRoomActivity(listener: (roomId: string) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  /** An editor's change couldn't be shared ("read_only", "too_large", "publish_refused", ...). */
  onLocalRefused(listener: (roomId: string, docId: string, code: string) => void): () => void {
    this.refusedListeners.add(listener);
    return () => this.refusedListeners.delete(listener);
  }

  /** A room this device created didn't survive a conflict and couldn't be made again. */
  onLostRoom(listener: (roomId: string) => void): () => void {
    this.lostRoomListeners.add(listener);
    return () => this.lostRoomListeners.delete(listener);
  }

  private roomActivity(roomId: string): void {
    for (const listener of this.activityListeners) listener(roomId);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private quotaNotice(roomId: string): void {
    const last = this.quotaNoticeAt.get(roomId) ?? 0;
    if (Date.now() - last < 3_600_000 || !this.replicas.has(roomId)) return;
    this.quotaNoticeAt.set(roomId, Date.now());
    const name = this.rooms().find((room) => room.id === roomId)?.name ?? "a room";
    this.deps.notify(`"${name}" has reached its storage limit on this computer; new changes to it aren't stored or shared.`);
  }

  private saveSoon(key: string, save: () => Promise<void>): void {
    if (this.saveTimers.has(key)) return;
    this.saveTimers.set(
      key,
      setTimeout(() => {
        this.saveTimers.delete(key);
        save().catch((error: Error) => this.deps.log(`save ${key}: ${error.message}`));
      }, 200)
    );
  }

  private onChain(result: OfferResult): void {
    this.saveSoon("chain", () => this.disk.saveChain(this.node.chain.all()));
    this.refreshKeys();
    // After the node has finished taking in the winning branch.
    if (result.status === "replaced") void Promise.resolve().then(() => this.reapply(result.lost));
    this.syncReplicas();
    this.automateSoon();
    this.emit();
  }

  /** Keys are checked against the record whenever it changes: one it no longer backs is dropped (see RoomReplica). */
  private refreshKeys(): void {
    for (const [roomId, replica] of this.replicas) if (replica.refreshKeys()) this.roomActivity(roomId);
  }

  /**
   * Our versions that lost a race to someone else's are made again on top of the winner, change by change. Joins and
   * key rotations are left to the automation, which redoes them if they are still needed.
   */
  private async reapply(lost: SignedVersion[]): Promise<void> {
    const failed: string[] = [];
    for (let i = 0; i < lost.length; i++) {
      const version = lost[i]!;
      if (version.body.by !== this.settings.deviceId || version.body.joins) continue;
      const base = i === 0 ? this.node.chain.versionAt(version.body.v - 1)?.body.state : lost[i - 1]!.body.state;
      if (!base) continue;
      try {
        await this.commit((state) => Object.assign(state, rebaseChange(base, version.body.state, state)));
      } catch {
        failed.push(String(version.body.v));
        for (const roomId of Object.keys(version.body.state.rooms)) if (!base.rooms[roomId] && !this.node.chain.state.rooms[roomId]) for (const listener of this.lostRoomListeners) listener(roomId);
      }
    }
    if (failed.length > 0) this.deps.notify("A change you made to the workspace clashed with someone else's at the same moment and couldn't be made again. Please check it and make it again if it's still needed.");
  }

  // ---- state for the UI ----

  get me(): { deviceId: string; userId: string } {
    return { deviceId: this.settings.deviceId, userId: this.settings.userId };
  }

  get state(): WorkspaceState {
    return this.node.effective();
  }

  get listeningPort(): number {
    return this.port;
  }

  isMember(): boolean {
    return activeDevice(this.state, this.settings.deviceId) !== null;
  }

  isAdmin(): boolean {
    return this.isMember() && this.state.users[this.settings.userId]?.admin === true;
  }

  /** Whether this is the only active device of the only admin (leaving would leave the workspace without one). */
  isLastAdminDevice(): boolean {
    const state = this.state;
    if (!this.isAdmin()) return false;
    const adminDevices = Object.entries(state.devices).filter(([deviceId, device]) => activeDevice(state, deviceId) && state.users[device.user]?.admin);
    return adminDevices.length === 1;
  }

  connectedDevices(): string[] {
    return this.manager?.connected() ?? [];
  }

  /** This device's addresses on the local network, for invite links. */
  addresses(): string[] {
    const out: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const entry of list ?? []) if (entry.family === "IPv4" && !entry.internal) out.push(`${entry.address}:${this.port}`);
    }
    return out;
  }

  rooms(): RoomInfo[] {
    const state = this.state;
    return Object.entries(state.rooms)
      .filter(([, room]) => !room.deleted)
      .map(([id, room]) => {
        const replica = this.replicas.get(id);
        const key = replica?.keyFor(room.name.n);
        let name: string | null = null;
        if (key) {
          try {
            name = openRoomName(this.settings.id, id, key, room.name);
          } catch {
            name = null;
          }
        }
        return { id, name, role: roleIn(state, id, this.settings.userId), members: { ...room.members }, epochs: room.epochs.length };
      });
  }

  replica(roomId: string): RoomReplica | null {
    return this.replicas.get(roomId) ?? null;
  }

  // ---- changes to the workspace record ----

  /** Sign and apply a change, and store the record before returning. A change that changes nothing isn't made. */
  private async commit(change: (state: WorkspaceState) => void, joins: JoinRecord[] = []): Promise<SignedVersion | null> {
    const head = this.node.chain.head;
    const draft = structuredClone(head.body.state);
    change(draft);
    if (joins.length === 0 && canonicalJson(draft) === canonicalJson(head.body.state)) return null;
    const version = nextVersion(this.settings.id, head, this.secrets.sign, change, Date.now(), joins);
    const result = this.node.offerVersions([version]);
    if (result.status !== "appended") throw new MeshServiceError(`The change wasn't applied (${result.status === "rejected" ? result.reason : result.status}).`);
    await this.disk.saveChain(this.node.chain.all());
    return version;
  }

  /**
   * A key this device made: give it to the replica, and wrap it to this device itself, stored before this returns, so
   * a crash right after can't lose the only copy.
   */
  private async keepKey(roomId: string, n: number, key: Uint8Array): Promise<void> {
    this.replicas.get(roomId)?.addOwnKey(n, key);
    this.node.addWrap(wrapRoomKey(this.settings.id, roomId, n, key, { id: this.settings.deviceId, agree: this.secrets.agree.publicKey }, this.secrets.sign));
    await this.disk.saveWraps(this.node.allWraps());
  }

  async createRoom(name: string, members: Record<string, Role> = {}, roomId = randomId("r")): Promise<string> {
    const key = newRoomKey();
    this.ownKeys.set(roomId, { n: 1, key });
    try {
      await this.commit((state) => {
        state.rooms[roomId] = {
          creator: this.settings.userId,
          name: sealRoomName(this.settings.id, roomId, 1, key, name),
          members: { ...members, [this.settings.userId]: "manage" },
          epochs: [{ n: 1, commit: keyCommitment(this.settings.id, roomId, 1, key) }]
        };
      });
      this.syncReplicas();
      await this.keepKey(roomId, 1, key);
    } finally {
      this.ownKeys.delete(roomId);
    }
    this.automateSoon();
    return roomId;
  }

  /** Add, change or (with null) remove a member. Removing someone also starts a new room key, in the same change. */
  async setMember(roomId: string, userId: string, role: Role | null): Promise<void> {
    const room = this.node.chain.state.rooms[roomId];
    if (!room) throw new MeshServiceError("No such room.");
    const rotation = role ? null : { n: room.epochs.length + 1, key: newRoomKey() };
    await this.commit((state) => {
      const next = state.rooms[roomId]!;
      if (role) {
        next.members[userId] = role;
        return;
      }
      delete next.members[userId];
      next.epochs.push({ n: rotation!.n, commit: keyCommitment(this.settings.id, roomId, rotation!.n, rotation!.key) });
    });
    if (rotation) await this.keepKey(roomId, rotation.n, rotation.key);
    this.automateSoon();
  }

  async leaveRoom(roomId: string): Promise<void> {
    await this.commit((state) => {
      delete state.rooms[roomId]?.members[this.settings.userId];
    });
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.commit((state) => {
      const room = state.rooms[roomId];
      if (room) room.deleted = true;
    });
  }

  async renameRoom(roomId: string, name: string): Promise<void> {
    const epoch = this.replicas.get(roomId)?.sealEpoch();
    if (!epoch) throw new MeshServiceError("This device doesn't have the room's newest key yet.");
    await this.commit((state) => {
      const room = state.rooms[roomId];
      if (room) room.name = sealRoomName(this.settings.id, roomId, epoch.n, epoch.key, name);
    });
  }

  /** An invite link for a new person, granting `rooms` (rooms this user manages). */
  async createInvite(rooms: Record<string, Role>, days = 3): Promise<string> {
    const invite = newInvite({ user: this.settings.userId, device: this.settings.deviceId }, rooms, this.recordTime() + days * 86_400_000);
    await this.commit((state) => {
      state.invites[invite.inviteId] = invite.record;
    });
    return formatInviteLink({ workspaceId: this.settings.id, inviteId: invite.inviteId, secret: invite.secret, peers: this.addresses() });
  }

  /** An invite link for another computer of your own. */
  async createDeviceInvite(days = 1): Promise<string> {
    const invite = newInvite({ user: this.settings.userId, device: this.settings.deviceId }, {}, this.recordTime() + days * 86_400_000, this.settings.userId);
    await this.commit((state) => {
      state.invites[invite.inviteId] = invite.record;
    });
    return formatInviteLink({ workspaceId: this.settings.id, inviteId: invite.inviteId, secret: invite.secret, peers: this.addresses(), forUser: this.settings.userId });
  }

  async withdrawInvite(inviteId: string): Promise<void> {
    await this.commit((state) => {
      delete state.invites[inviteId];
    });
  }

  /** Revoke a device, and withdraw the open invites it made. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.commit((state) => {
      const device = state.devices[deviceId];
      if (device) device.revoked = true;
      for (const [inviteId, invite] of Object.entries(state.invites)) if (invite.dev === deviceId && invite.used === undefined) delete state.invites[inviteId];
    });
  }

  /** Remove a person, and withdraw the open invites they made. */
  async removeUser(userId: string): Promise<void> {
    await this.commit((state) => {
      const user = state.users[userId];
      if (user) user.removed = true;
      for (const [inviteId, invite] of Object.entries(state.invites)) if (invite.by === userId && invite.used === undefined) delete state.invites[inviteId];
    });
  }

  async setAdmin(userId: string, admin: boolean): Promise<void> {
    await this.commit((state) => {
      const user = state.users[userId];
      if (user) user.admin = admin;
    });
  }

  async renameUser(userId: string, name: string): Promise<void> {
    await this.commit((state) => {
      const user = state.users[userId];
      if (user) user.name = name;
    });
  }

  async setRoomCreation(policy: "admins" | "members"): Promise<void> {
    await this.commit((state) => {
      state.roomCreation = policy;
    });
  }

  private recordTime(): number {
    return Math.max(Date.now(), this.node.chain.head.body.at);
  }

  // ---- replicas ----

  private syncReplicas(): void {
    if (this.stopped) return;
    const state = this.state;
    const mine = new Set(
      Object.entries(state.rooms)
        .filter(([roomId, room]) => !room.deleted && roleIn(state, roomId, this.settings.userId) !== undefined && this.isMember())
        .map(([roomId]) => roomId)
    );
    for (const [roomId, replica] of this.replicas) {
      if (mine.has(roomId)) continue;
      replica.destroy();
      this.replicas.delete(roomId);
      for (const listener of this.replicaListeners) listener(roomId, null);
    }
    for (const roomId of mine) {
      if (this.replicas.has(roomId)) continue;
      const replica = new RoomReplica(this.node, roomId, { sign: this.secrets.sign, agree: this.secrets.agree }, {
        // An editor's change that can't be shared (a reader, too large, the room full): the owner decides what to do.
        localRefused: (docId, code) => {
          for (const listener of this.refusedListeners) listener(roomId, docId, code);
        }
      });
      const own = this.ownKeys.get(roomId);
      if (own) replica.addOwnKey(own.n, own.key);
      this.replicas.set(roomId, replica);
      for (const listener of this.replicaListeners) listener(roomId, replica);
    }
  }

  // ---- automation ----

  private automateSoon(): void {
    if (this.stopped || this.automateTimer) return;
    this.automateTimer = setTimeout(() => {
      this.automateTimer = null;
      void this.automate();
    }, 300);
  }

  private async automate(): Promise<void> {
    if (this.automating || this.stopped || !this.isMember()) return;
    this.automating = true;
    try {
      this.syncReplicas();
      this.ensureWraps();
      await this.rotateWhereNeeded();
      await this.recordJoins();
      await this.withdrawExpiredInvites();
      this.collectBlobs();
    } catch (error) {
      this.deps.log(`automation: ${(error as Error).message}`);
    } finally {
      this.automating = false;
    }
  }

  private entitled(state: WorkspaceState, roomId: string, deviceId: string): boolean {
    const device = activeDevice(state, deviceId);
    return device !== null && roleIn(state, roomId, device.user) !== undefined;
  }

  /**
   * Devices that have shown they hold a room key: each device wraps a key it obtained to itself, as a receipt. A wrap
   * someone else sent proves nothing (it could carry a wrong key), so only receipts count.
   */
  private holders(roomId: string, n: number): Set<string> {
    return new Set(
      this.node
        .allWraps()
        .filter((w) => w.body.room === roomId && w.body.n === n && w.body.to === w.body.by)
        .map((w) => w.body.to)
    );
  }

  /** Of the devices that hold a room key and are online right now, the lowest id hands it out (fewer duplicates). */
  private isWrapper(roomId: string, n: number): boolean {
    const online = new Set([...this.connectedDevices(), this.settings.deviceId]);
    const holders = this.holders(roomId, n);
    holders.add(this.settings.deviceId);
    const candidates = [...holders].filter((device) => online.has(device)).sort();
    return candidates[0] === this.settings.deviceId;
  }

  /**
   * Every key this device holds goes to every entitled device that hasn't confirmed holding it (no receipt yet),
   * once from each wrapper; and this device files its own receipt. The lowest online holder wraps at once; every
   * other holder steps in once a device has gone without a receipt for a while, so no single member (who might send
   * a wrong key, or nothing) can keep a key from anyone.
   */
  private ensureWraps(): void {
    const state = this.state;
    const now = Date.now();
    const mine = new Set(this.node.allWraps().filter((w) => w.body.by === this.settings.deviceId).map((w) => `${w.body.room}/${w.body.n}/${w.body.to}`));
    const stillMissing = new Map<string, number>();
    for (const [roomId, replica] of this.replicas) {
      const room = state.rooms[roomId];
      if (!room) continue;
      for (const epoch of room.epochs) {
        const key = replica.keyFor(epoch.n);
        if (!key) continue;
        const holders = this.holders(roomId, epoch.n);
        const wrapper = this.isWrapper(roomId, epoch.n);
        for (const [deviceId, device] of Object.entries(state.devices)) {
          const slot = `${roomId}/${epoch.n}/${deviceId}`;
          if (holders.has(deviceId) || mine.has(slot) || !this.entitled(state, roomId, deviceId)) continue;
          const since = this.missingSince.get(slot) ?? now;
          stillMissing.set(slot, since);
          if (deviceId !== this.settings.deviceId && !wrapper && now - since < STEP_IN_MS) continue;
          try {
            this.node.addWrap(wrapRoomKey(this.settings.id, roomId, epoch.n, key, { id: deviceId, agree: device.agree }, this.secrets.sign));
          } catch (error) {
            this.deps.log(`wrap for ${deviceId}: ${(error as Error).message}`);
          }
        }
      }
    }
    this.missingSince = stillMissing;
  }

  /**
   * A device that held the current room key lost its access (revoked, removed, or left the room): start a new key.
   * Exactly one writer does it: the lowest device id among the room's writers that are online.
   */
  private async rotateWhereNeeded(): Promise<void> {
    const state = this.state;
    for (const [roomId, replica] of this.replicas) {
      const room = state.rooms[roomId];
      if (!room || room.deleted || !roleAtLeast(roleIn(state, roomId, this.settings.userId), "write")) continue;
      const n = room.epochs.length;
      const stale = this.node.allWraps().some((w) => w.body.room === roomId && w.body.n === n && !this.entitled(state, roomId, w.body.to));
      if (!stale || !replica.keyFor(n)) continue;
      const online = new Set([...this.connectedDevices(), this.settings.deviceId]);
      const writers = Object.entries(state.devices)
        .filter(([deviceId, device]) => online.has(deviceId) && activeDevice(state, deviceId) && roleAtLeast(roleIn(state, roomId, device.user), "write"))
        .map(([deviceId]) => deviceId)
        .sort();
      if (writers[0] !== this.settings.deviceId) continue;
      const key = newRoomKey();
      await this.commit((next) => {
        next.rooms[roomId]!.epochs.push({ n: n + 1, commit: keyCommitment(this.settings.id, roomId, n + 1, key) });
      });
      await this.keepKey(roomId, n + 1, key);
      this.ensureWraps();
    }
  }

  /** Write proven joins into the record. Done by admins and by the invite's creator, once each. */
  private async recordJoins(): Promise<void> {
    const state = this.node.chain.state;
    for (const join of this.node.pendingJoinRecords()) {
      const invite = state.invites[join.body.invite];
      if (!invite || invite.used !== undefined) continue;
      if (!(this.isAdmin() || invite.by === this.settings.userId)) continue;
      try {
        await this.commit((next) => foldJoinInto(next, join), [join]);
      } catch (error) {
        this.deps.log(`record join: ${(error as Error).message}`);
      }
    }
  }

  /** Admins withdraw invites that expired by the record's clock, which also closes the window for late joins. */
  private async withdrawExpiredInvites(): Promise<void> {
    if (!this.isAdmin()) return;
    const now = this.recordTime();
    const expired = Object.entries(this.node.chain.state.invites).filter(([, invite]) => invite.used === undefined && invite.expires + JOIN_EXPIRY_SLACK_MS < now);
    if (expired.length === 0) return;
    await this.commit((state) => {
      for (const [inviteId] of expired) delete state.invites[inviteId];
    });
  }

  /**
   * Blobs no file of the room uses any more (older versions, deleted files) are dropped after a grace period, and a
   * blob a file needs again is fetched again. Only with the whole index decrypted, so nothing in use is ever taken.
   */
  private collectBlobs(): void {
    const store = this.node.store;
    let refetch = false;
    for (const [roomId, replica] of this.replicas) {
      if (!replica.isComplete(INDEX_DOC) || replica.epochsMissing().length > 0) continue;
      const used = new Set<string>();
      for (const entry of replica.files().values()) if (entry.blob) used.add(`${entry.blob.by}/${entry.blob.id}`);
      const cutoff = Date.now() - BLOB_GRACE_MS;
      store.dropBlobs(
        roomId,
        store
          .blobsOf(roomId)
          .filter((meta) => meta.at < cutoff && !used.has(`${meta.author}/${meta.id}`))
          .map((meta) => `${meta.author}/${meta.id}`)
      );
      for (const [key] of store.gone(roomId)) {
        if (!used.has(key)) continue;
        store.undrop(roomId, key);
        refetch = true;
      }
    }
    if (refetch) this.node.resync();
  }
}

export function parseAddress(text: string): { host: string; port: number } | null {
  const at = text.trim().lastIndexOf(":");
  if (at <= 0) return null;
  const host = text.trim().slice(0, at).replace(/^\[|\]$/g, "");
  const port = Number(text.trim().slice(at + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}
