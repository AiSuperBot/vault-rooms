import { hostname } from "node:os";
import { MarkdownView, Notice, normalizePath, Plugin, TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { pathKey, randomId, type Role, type RoomReplica } from "@vault-rooms/secure";
import { EditorBinding, type BindTarget } from "./mesh/editorBinding.js";
import { MeshService, MeshServiceError, type MeshDeps, type MeshSettings } from "./mesh/meshService.js";
import { adapterFiles, ObsidianVault } from "./mesh/obsidianVault.js";
import { RoomPresence } from "./mesh/presence.js";
import { RoomFolder, type RoomFolderState } from "./mesh/roomFolder.js";
import { isScope, obsidianSecrets } from "./mesh/secrets.js";
import { JoinModal } from "./ui/modals.js";
import { ROOMS_VIEW, RoomsView } from "./ui/roomsView.js";
import { RoomsSettingTab } from "./ui/settingsTab.js";

export interface PluginSettings {
  mesh: MeshSettings;
  /** Where rooms shared with you are put, unless you choose a folder. */
  mountRoot: string;
}

function randomScope(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("");
}

export default class VaultRoomsPlugin extends Plugin {
  declare settings: PluginSettings;
  service: MeshService | null = null;
  serviceError: string | null = null;
  private folders = new Map<string, RoomFolder>();
  private presences = new Map<string, RoomPresence>();
  private editors!: EditorBinding;
  private changeListeners = new Set<() => void>();
  private unsubscribers: Array<() => void> = [];
  private pausedFolders = new Set<string>();
  /** Rooms shared with us whose name we can't read yet (no key): mounted once the key arrives. */
  private pendingMounts = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.editors = new EditorBinding(
      (path) => this.bindTarget(path),
      () => this.syncEditorsSoon()
    );
    this.registerEditorExtension(this.editors.extension());
    this.registerView(ROOMS_VIEW, (leaf) => new RoomsView(leaf, this));
    this.addRibbonIcon("users", "Vault Rooms", () => void this.openPanel());
    this.addSettingTab(new RoomsSettingTab(this.app, this));
    this.addCommand({ id: "open-panel", name: "Open rooms panel", callback: () => void this.openPanel() });
    this.addCommand({ id: "join", name: "Join a workspace with an invite link", callback: () => new JoinModal(this).open() });
    this.registerObsidianProtocolHandler("vault-rooms", (params) => {
      if (params.mode === "join-secure") new JoinModal(this, params).open();
    });

    // Vault events: each goes to the room folder that contains the path.
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultWrite(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultWrite(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultDelete(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath)));
    // Editors: bind every open note of a room, whichever pane it is in.
    for (const event of ["active-leaf-change", "file-open", "layout-change"] as const) this.registerEvent(this.app.workspace.on(event as "layout-change", () => this.syncEditors()));

    this.app.workspace.onLayoutReady(() => void this.startService());
  }

  async onunload(): Promise<void> {
    await this.stopService();
  }

  // ---- settings ----

  async loadSettings(): Promise<void> {
    const raw = ((await this.loadData()) ?? {}) as Partial<PluginSettings>;
    const mesh = raw.mesh && isScope(raw.mesh.scope) ? raw.mesh : { scope: randomScope(), workspace: null };
    this.settings = { mesh, mountRoot: typeof raw.mountRoot === "string" && raw.mountRoot ? raw.mountRoot : "Rooms" };
    await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private deps(): MeshDeps {
    return {
      files: adapterFiles(this.app.vault.adapter),
      dataRoot: normalizePath(`${this.manifest.dir}/mesh`),
      secrets: obsidianSecrets(this.app.secretStorage as unknown as Parameters<typeof obsidianSecrets>[0]),
      settings: this.settings.mesh,
      save: () => this.saveSettings(),
      notify: (message) => new Notice(message, 8000),
      log: (message) => console.debug(`Vault Rooms: ${message}`)
    };
  }

  // ---- service lifecycle ----

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.changeListeners) listener();
  }

  async startService(service?: MeshService): Promise<void> {
    this.serviceError = null;
    try {
      this.service = service ?? (await MeshService.open(this.deps()));
    } catch (error) {
      this.service = null;
      this.serviceError = error instanceof MeshServiceError ? error.message : `Couldn't open the workspace: ${(error as Error).message}`;
      this.changed();
      return;
    }
    const svc = this.service;
    if (!svc) return this.changed();
    this.unsubscribers.push(
      svc.onChange(() => {
        this.retryPendingMounts();
        this.changed();
      }),
      svc.onReplica((roomId, replica) => void this.onReplica(roomId, replica)),
      svc.onRoomActivity((roomId) => {
        if (this.pendingMounts.has(roomId)) this.retryPendingMounts();
        this.folders.get(roomId)?.remoteChanged();
      }),
      svc.onPresence((env) => this.presences.get(env.room)?.receive(env)),
      svc.onLocalRefused((roomId, docId) => {
        // Throw the stray edit away: rebuild the note from the shared history and rebind its editors to it.
        svc.replica(roomId)?.reload(docId);
        this.folders.get(roomId)?.remoteChanged();
        this.syncEditorsSoon();
      })
    );
    for (const room of svc.rooms()) {
      const replica = svc.replica(room.id);
      if (replica) await this.onReplica(room.id, replica);
    }
    try {
      await svc.start();
    } catch (error) {
      this.serviceError = `Couldn't start sharing on this computer: ${(error as Error).message}`;
    }
    this.syncEditors();
    this.changed();
  }

  async stopService(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.editors.unbindAll();
    for (const folder of this.folders.values()) await folder.stop();
    this.folders.clear();
    for (const presence of this.presences.values()) presence.destroy();
    this.presences.clear();
    await this.service?.stop();
    this.service = null;
  }

  async createWorkspace(input: { workspaceName: string; userName: string; deviceName: string }): Promise<void> {
    const service = await MeshService.create(this.deps(), input);
    await this.startService(service);
  }

  async joinWorkspace(input: { link: string; userName: string; deviceName: string; peers?: string[] }): Promise<void> {
    const service = await MeshService.join(this.deps(), input);
    await this.startService(service);
  }

  /** Leave on this computer: stop syncing and delete the workspace data and this device's keys. Folders stay. */
  async leaveWorkspace(): Promise<void> {
    const service = this.service;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.editors.unbindAll();
    for (const folder of this.folders.values()) await folder.stop();
    this.folders.clear();
    for (const presence of this.presences.values()) presence.destroy();
    this.presences.clear();
    this.service = null;
    await service?.forget();
    this.changed();
  }

  defaultDeviceName(): string {
    try {
      return hostname().slice(0, 60) || "This computer";
    } catch {
      return "This computer";
    }
  }

  async openPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(ROOMS_VIEW)[0];
    const leaf: WorkspaceLeaf = existing ?? this.app.workspace.getRightLeaf(false)!;
    if (!existing) await leaf.setViewState({ type: ROOMS_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  // ---- rooms in this vault ----

  /** A folder for a room shared with you: under the mount root, named after the room, not clashing with anything. */
  private freeFolder(name: string): string {
    const base = normalizePath(`${this.settings.mountRoot}/${name.replace(/[\\/:*?"<>|#^[\]]/g, "-")}`);
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? base : `${base} ${i}`;
      const existing = this.app.vault.getAbstractFileByPath(candidate);
      if (!existing || (existing instanceof TFolder && existing.children.length === 0)) return candidate;
    }
  }

  folderOf(roomId: string): string | null {
    return this.settings.mesh.workspace?.rooms[roomId]?.folder ?? null;
  }

  /** Share an existing folder as a new room. The folder is assigned before the room exists, so its files are shared from there. */
  async createRoom(folder: string, name: string, members: Record<string, Role> = {}): Promise<string> {
    const svc = this.service;
    const ws = this.settings.mesh.workspace;
    if (!svc || !ws) throw new Error("No workspace.");
    const path = normalizePath(folder);
    for (const room of Object.values(ws.rooms)) {
      if (pathKey(room.folder) === pathKey(path) || path.startsWith(`${room.folder}/`) || room.folder.startsWith(`${path}/`)) throw new Error(`"${path}" overlaps a folder that is already a room.`);
    }
    const roomId = randomId("r");
    ws.rooms[roomId] = { folder: path };
    await this.saveSettings();
    try {
      return await svc.createRoom(name, members, roomId);
    } catch (error) {
      delete ws.rooms[roomId];
      await this.saveSettings();
      throw error;
    }
  }

  private async onReplica(roomId: string, replica: RoomReplica | null): Promise<void> {
    const svc = this.service;
    const ws = this.settings.mesh.workspace;
    if (!svc || !ws) return;
    if (!replica) {
      // Access ended (or the room was deleted): stop syncing; the files stay on this computer.
      this.editors.unbindRoom(roomId);
      await this.folders.get(roomId)?.stop();
      this.folders.delete(roomId);
      this.presences.get(roomId)?.destroy();
      this.presences.delete(roomId);
      // Keep the folder assignment: if access comes back, the room returns to the same folder.
      const folder = ws.rooms[roomId]?.folder;
      if (folder) new Notice(`You no longer have access to the room in "${folder}". Its files stay on this computer but no longer sync.`, 10000);
      this.changed();
      return;
    }
    if (this.folders.has(roomId)) return;
    if (!ws.rooms[roomId]) {
      // Name the folder after the room, which needs the room key: wait for it rather than invent a name.
      const name = svc.rooms().find((room) => room.id === roomId)?.name;
      if (!name) {
        this.pendingMounts.add(roomId);
        return;
      }
      this.pendingMounts.delete(roomId);
      ws.rooms[roomId] = { folder: this.freeFolder(name) };
      await this.saveSettings();
    }
    const folderPath = ws.rooms[roomId]!.folder;
    if (!this.app.vault.getAbstractFileByPath(folderPath)) await this.app.vault.createFolder(folderPath).catch(() => {});
    const presence = new RoomPresence({
      workspaceId: ws.id,
      roomId,
      replica,
      me: svc.secrets.sign,
      publish: (env) => void svc.node.publish(env),
      userOf: (deviceId) => {
        const device = svc.state.devices[deviceId];
        const user = device ? svc.state.users[device.user] : undefined;
        return device && user ? { id: device.user, name: user.name } : null;
      }
    });
    this.presences.set(roomId, presence);
    const folder = new RoomFolder({
      folder: folderPath,
      replica,
      vault: new ObsidianVault(this.app),
      deviceName: svc.state.devices[svc.me.deviceId]?.name ?? this.defaultDeviceName(),
      isBound: (fileId) => this.editors.isBound(roomId, fileId),
      loadState: () => svc.disk.loadRoomState<RoomFolderState>(roomId),
      saveState: (state) => svc.disk.saveRoomState(roomId, state),
      notify: (message) => new Notice(message, 8000),
      log: (message) => console.debug(`Vault Rooms: ${message}`)
    });
    this.folders.set(roomId, folder);
    await folder.start();
    this.syncEditors();
    this.changed();
  }

  private retryPendingMounts(): void {
    for (const roomId of [...this.pendingMounts]) {
      const replica = this.service?.replica(roomId);
      if (!replica) this.pendingMounts.delete(roomId);
      else if (replica.currentEpoch()) void this.onReplica(roomId, replica);
    }
  }

  private folderFor(path: string): { roomId: string; folder: RoomFolder } | null {
    for (const [roomId, folder] of this.folders) {
      const root = this.folderOf(roomId);
      if (root && path.startsWith(`${root}/`) && !this.pausedFolders.has(roomId)) return { roomId, folder };
    }
    return null;
  }

  private onVaultWrite(file: TAbstractFile): void {
    if (file instanceof TFile) void this.folderFor(file.path)?.folder.onLocalWrite(file.path);
  }

  private onVaultDelete(file: TAbstractFile): void {
    if (file instanceof TFile) void this.folderFor(file.path)?.folder.onLocalDelete(file.path);
  }

  private onVaultRename(file: TAbstractFile, oldPath: string): void {
    if (file instanceof TFolder) return void this.onFolderRename(file.path, oldPath);
    const from = this.folderFor(oldPath);
    const to = this.folderFor(file.path);
    if (from && to && from.roomId === to.roomId) return void from.folder.onLocalRename(oldPath, file.path);
    // Between rooms, or in or out of one: a deletion in one and a new file in the other.
    if (from) void from.folder.onLocalDelete(oldPath);
    if (to) void to.folder.onLocalWrite(file.path);
    this.syncEditors();
  }

  /** A room's folder was renamed or moved: follow it, ignoring the per-file events the move produces. */
  private async onFolderRename(newPath: string, oldPath: string): Promise<void> {
    const ws = this.settings.mesh.workspace;
    if (!ws) return;
    for (const [roomId, room] of Object.entries(ws.rooms)) {
      if (pathKey(room.folder) !== pathKey(oldPath) && !room.folder.startsWith(`${oldPath}/`)) continue;
      const folder = this.folders.get(roomId);
      const replica = this.service?.replica(roomId);
      this.pausedFolders.add(roomId);
      await folder?.stop();
      this.folders.delete(roomId);
      this.presences.get(roomId)?.destroy();
      this.presences.delete(roomId);
      room.folder = newPath + room.folder.slice(oldPath.length);
      await this.saveSettings();
      // Let the file events of the move pass before watching again.
      window.setTimeout(() => {
        this.pausedFolders.delete(roomId);
        if (replica) void this.onReplica(roomId, replica);
      }, 800);
    }
  }

  // ---- editors ----

  private bindTarget(path: string): BindTarget | null {
    const hit = this.folderFor(path);
    const replica = hit ? this.service?.replica(hit.roomId) : null;
    const presence = hit ? this.presences.get(hit.roomId) : null;
    if (!hit || !replica || !presence) return null;
    const fileId = hit.folder.noteIdAt(path);
    if (!fileId) return null;
    return { roomId: hit.roomId, fileId, ytext: replica.noteDoc(fileId).getText("content"), presence, readOnly: !replica.canWrite(), syncedHash: hit.folder.syncedHash(fileId) };
  }

  private syncTimer: number | null = null;

  /** Coalesce sync requests (editors get new states in bursts while Obsidian opens files). */
  syncEditorsSoon(): void {
    if (this.syncTimer !== null) return;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.syncEditors();
    }, 30);
  }

  syncEditors(): void {
    const open: Array<{ path: string; view: EditorView }> = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (cm) open.push({ path: view.file.path, view: cm });
    }
    this.editors.sync(open);
  }
}
