import { networkInterfaces } from "node:os";
import {
  activeDevice,
  createGenesis,
  Discovery,
  foldJoinInto,
  formatInviteLink,
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
  /** Rooms shown in this vault, and the folder each lives in. */
  rooms: Record<string, { folder: string }>;
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
  private server: PeerServer | null = null;
  private manager: PeerManager | null = null;
  private discovery: Discovery | null = null;
  private port = 0;
  private timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  private automateTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private automating = false;
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
      for (const replica of this.replicas.values()) replica.refreshKeys();
      this.automateSoon();
      this.emit();
    };
    events.envelope = (env) => this.replicas.get(env.room)?.receive(env);
    events.presence = (env) => {
      for (const listener of this.presenceListeners) listener(env);
    };
    events.sessions = () => this.emit();
    events.rejected = (reason, from) => this.deps.log(`refused from ${from}: ${reason}`);
  }

  // ---- creating, joining, opening ----

  private static diskFor(deps: MeshDeps, workspaceId: string): DiskStore {
    return new DiskStore(deps.files, `${deps.dataRoot}/${workspaceId.slice(0, 16).replace(/[^A-Za-z0-9]/g, "_")}`);
  }

  static async create(deps: MeshDeps, input: { workspaceName: string; userName: string; deviceName: string }): Promise<MeshService> {
    if (deps.settings.workspace) throw new MeshServiceError("This vault already belongs to a workspace.");
    const { secrets, certPem } = await createDeviceSecrets(deps.secrets, deps.settings.scope, input.deviceName);
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
    const { secrets, certPem } = await createDeviceSecrets(deps.secrets, deps.settings.scope, input.deviceName);
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

  private emit(): void {
    for (const listener of this.listeners) listener();
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
    if (result.status === "replaced") {
      const mine = result.lost.filter((version) => version.body.by === this.settings.deviceId);
      if (mine.length > 0) this.deps.notify("A change you made to the workspace happened at the same time as another admin's, and theirs was kept. Please check it and make your change again.");
    }
    this.syncReplicas();
    this.automateSoon();
    this.emit();
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

  private async commit(change: (state: WorkspaceState) => void, joins: JoinRecord[] = []): Promise<SignedVersion> {
    const version = nextVersion(this.settings.id, this.node.chain.head, this.secrets.sign, change, Date.now(), joins);
    const result = this.node.offerVersions([version]);
    if (result.status !== "appended") throw new MeshServiceError(`The change wasn't applied (${result.status === "rejected" ? result.reason : result.status}).`);
    return version;
  }

  async createRoom(name: string, members: Record<string, Role> = {}): Promise<string> {
    const roomId = randomId("r");
    const key = newRoomKey();
    await this.commit((state) => {
      state.rooms[roomId] = {
        creator: this.settings.userId,
        name: sealRoomName(this.settings.id, roomId, 1, key, name),
        members: { ...members, [this.settings.userId]: "manage" },
        epochs: [{ n: 1, commit: keyCommitment(this.settings.id, roomId, 1, key) }]
      };
    });
    this.syncReplicas();
    this.replicas.get(roomId)?.addOwnKey(1, key);
    this.automateSoon();
    return roomId;
  }

  /** Add, change or (with null) remove a member. Removing someone also starts a new room key, in the same change. */
  async setMember(roomId: string, userId: string, role: Role | null): Promise<void> {
    let rotated: { n: number; key: Uint8Array } | null = null;
    await this.commit((state) => {
      const room = state.rooms[roomId];
      if (!room) throw new MeshServiceError("No such room.");
      if (role) {
        room.members[userId] = role;
        return;
      }
      delete room.members[userId];
      const n = room.epochs.length + 1;
      const key = newRoomKey();
      room.epochs.push({ n, commit: keyCommitment(this.settings.id, roomId, n, key) });
      rotated = { n, key };
    });
    const done = rotated as { n: number; key: Uint8Array } | null;
    if (done) this.replicas.get(roomId)?.addOwnKey(done.n, done.key);
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
    const replica = this.replicas.get(roomId);
    const epoch = replica?.currentEpoch();
    if (!epoch) throw new MeshServiceError("This device doesn't have the room's key yet.");
    await this.commit((state) => {
      const room = state.rooms[roomId];
      if (room) room.name = sealRoomName(this.settings.id, roomId, epoch.n, epoch.key, name);
    });
  }

  /** An invite link for a new person, granting `rooms` (rooms this user manages). */
  async createInvite(rooms: Record<string, Role>, days = 3): Promise<string> {
    const invite = newInvite(this.settings.userId, rooms, this.recordTime() + days * 86_400_000);
    await this.commit((state) => {
      state.invites[invite.inviteId] = invite.record;
    });
    return formatInviteLink({ workspaceId: this.settings.id, inviteId: invite.inviteId, secret: invite.secret, peers: this.addresses() });
  }

  /** An invite link for another computer of your own. */
  async createDeviceInvite(days = 1): Promise<string> {
    const invite = newInvite(this.settings.userId, {}, this.recordTime() + days * 86_400_000, this.settings.userId);
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

  async revokeDevice(deviceId: string): Promise<void> {
    await this.commit((state) => {
      const device = state.devices[deviceId];
      if (device) device.revoked = true;
    });
  }

  async removeUser(userId: string): Promise<void> {
    await this.commit((state) => {
      const user = state.users[userId];
      if (user) user.removed = true;
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
      const replica = new RoomReplica(this.node, roomId, { sign: this.secrets.sign, agree: this.secrets.agree });
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

  /** Of the devices that hold a room key and are online right now, the lowest id hands it out (fewer duplicates). */
  private isWrapper(roomId: string, n: number): boolean {
    const online = new Set([...this.connectedDevices(), this.settings.deviceId]);
    const holders = new Set(this.node.allWraps().filter((w) => w.body.room === roomId && w.body.n === n).map((w) => w.body.to));
    holders.add(this.settings.deviceId);
    const candidates = [...holders].filter((device) => online.has(device)).sort();
    return candidates[0] === this.settings.deviceId;
  }

  /** Wrap every room key this device holds for every device entitled to it that has no wrap yet (itself included). */
  private ensureWraps(): void {
    const state = this.state;
    const wrapped = new Set(this.node.allWraps().map((w) => `${w.body.room}/${w.body.n}/${w.body.to}`));
    for (const [roomId, replica] of this.replicas) {
      const room = state.rooms[roomId];
      if (!room) continue;
      for (const epoch of room.epochs) {
        const key = replica.keyFor(epoch.n);
        if (!key) continue;
        for (const [deviceId, device] of Object.entries(state.devices)) {
          if (!this.entitled(state, roomId, deviceId) || wrapped.has(`${roomId}/${epoch.n}/${deviceId}`)) continue;
          if (deviceId !== this.settings.deviceId && !this.isWrapper(roomId, epoch.n)) continue;
          this.node.addWrap(wrapRoomKey(this.settings.id, roomId, epoch.n, key, { id: deviceId, agree: device.agree }, this.secrets.sign));
          wrapped.add(`${roomId}/${epoch.n}/${deviceId}`);
        }
      }
    }
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
      if (!stale) continue;
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
      replica.addOwnKey(n + 1, key);
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
}

export function parseAddress(text: string): { host: string; port: number } | null {
  const at = text.trim().lastIndexOf(":");
  if (at <= 0) return null;
  const host = text.trim().slice(0, at).replace(/^\[|\]$/g, "");
  const port = Number(text.trim().slice(at + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}
