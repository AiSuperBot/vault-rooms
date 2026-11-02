import { ItemView, Notice, setIcon, TFolder, type WorkspaceLeaf } from "obsidian";
import { activeDevice, roleIn } from "@vault-rooms/secure";
import type VaultRoomsPlugin from "../plugin.js";
import { deviceLabel, membershipLabels, personLabel } from "./labels.js";
import { pendingAction } from "./actions.js";
import { updateChildren } from "./updateChildren.js";
import { confirmAction, CreateWorkspaceModal, deleteRoom, InviteModal, JoinModal, LinkModal, MembersModal, NewRoomModal, UNMANAGED } from "./modals.js";

export const ROOMS_VIEW = "vault-rooms-panel";

const ROLE_LABEL = { read: "can read", write: "can edit", manage: "manage" } as const;

const count = (n: number, thing: string) => `${n} ${thing}${n === 1 ? "" : "s"}`;

export class RoomsView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private renderTimer: number | null = null;
  private rowVersions = new Map<string, string>();
  private seenRows = new Set<string>();
  private membership: object | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: VaultRoomsPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return ROOMS_VIEW;
  }

  getDisplayText(): string {
    return "Vault Rooms";
  }

  getIcon(): string {
    return "users";
  }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.plugin.onChange(() => this.renderSoon());
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
  }

  private renderSoon(): void {
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 150);
  }

  private async act(action: () => Promise<unknown>, button?: HTMLButtonElement): Promise<void> {
    await pendingAction(action, button);
    this.render();
  }

  private render(): void {
    const root = document.createElement("div");
    this.seenRows.clear();
    this.build(root);
    updateChildren(this.contentEl, root);
    this.contentEl.addClass("vault-rooms-panel");
    for (const key of this.rowVersions.keys()) if (!this.seenRows.has(key)) this.rowVersions.delete(key);
  }

  private row(root: HTMLElement, key: string, value: unknown): HTMLDivElement | null {
    this.seenRows.add(key);
    const signature = JSON.stringify(value);
    const row = root.createDiv();
    row.dataset.key = key;
    if (this.rowVersions.get(key) === signature) { row.setAttribute("data-keep", ""); return null; }
    this.rowVersions.set(key, signature);
    return row;
  }

  private build(root: HTMLElement): void {
    root.addClass("vault-rooms-panel");
    const svc = this.plugin.service;
    // Whatever stopped the workspace, or sharing, from starting: shown until it starts, whether or not the rest shows.
    if (this.plugin.serviceError) {
      root.createEl("p", { text: this.plugin.serviceError, cls: "vault-rooms-error" });
      const buttons = root.createDiv({ cls: "vault-rooms-buttons" });
      const retry = buttons.createEl("button", { text: "Try again", cls: "mod-cta" });
      retry.onclick = () => {
        retry.disabled = true;
        void this.act(() => this.plugin.restartService());
      };
      // Unreadable settings: leaving would act on a guess, so only Try again.
      if (!svc && this.plugin.settingsUnreadable) return;
      if (!svc) {
        buttons.createEl("button", { text: "Leave the workspace on this computer" }).onclick = async () => {
          if (await confirmAction(this.app, "Leave the workspace", "This deletes the workspace data and this computer's keys from this vault. Your files stay. You can join again with a new invite.\n\nIf this vault is also opened on another computer (a network share, or a synced folder), don't: the data is the other computer's, and Vault Rooms would stop working there. Use a vault of this computer's own instead.", "Leave")) await this.act(() => this.plugin.leaveWorkspace());
        };
        return;
      }
    }
    if (!svc) {
      root.createEl("h4", { text: "Share folders on this network" });
      root.createEl("p", { text: "Work on notes together with people on the same local network, live, without any server or cloud. Everything is end-to-end encrypted: a computer only holds readable copies of the rooms its user belongs to." });
      const buttons = root.createDiv({ cls: "vault-rooms-buttons" });
      const create = buttons.createEl("button", { text: "Create a workspace", cls: "mod-cta" });
      create.onclick = () => new CreateWorkspaceModal(this.plugin).open();
      buttons.createEl("button", { text: "Join with an invite link" }).onclick = () => new JoinModal(this.plugin).open();
      return;
    }

    const state = svc.state;
    if (this.membership !== state) { this.membership = state; this.rowVersions.clear(); }
    const { devicesByUser } = membershipLabels(state);
    const me = state.users[svc.me.userId];
    const label = (userId: string) => personLabel(state, userId);
    const roomName = (roomId: string) => `"${svc.rooms().find((room) => room.id === roomId)?.name ?? `a room you aren't in (${roomId.slice(1, 5)})`}"`;
    const online = new Set(svc.connectedDevices());
    const otherDevices = Object.entries(state.devices).filter(([deviceId]) => deviceId !== svc.me.deviceId && activeDevice(state, deviceId));

    const head = root.createDiv({ cls: "vault-rooms-head" });
    head.createEl("h4", { text: state.name });
    head.createDiv({ cls: "vault-rooms-status", text: otherDevices.length === 0 ? "No other computers yet" : `${online.size} of ${count(otherDevices.length, "other computer")} online` });
    if (!svc.isMember()) {
      // Cut off: nothing here would be accepted any more, so offer only the clean-up.
      root.createEl("p", { cls: "vault-rooms-error", text: "This computer is no longer part of the workspace (it was revoked or its user removed). Rooms don't sync any more; their files stay on this computer." });
      root.createEl("button", { text: "Remove the workspace from this computer" }).onclick = async () => {
        if (await confirmAction(this.app, "Remove the workspace", "This deletes the workspace data and this computer's keys from this vault. Your files stay.", "Remove")) await this.act(() => this.plugin.leaveWorkspace());
      };
      return;
    }
    root.createDiv({ cls: "vault-rooms-me", text: `You: ${me?.name ?? "?"}${me?.admin ? " (admin)" : ""} · ${state.devices[svc.me.deviceId]?.name ?? ""}` });

    // Rooms
    const roomsHead = root.createDiv({ cls: "vault-rooms-section" });
    roomsHead.createEl("h5", { text: "Rooms" });
    const canCreate = svc.isMember() && (state.roomCreation === "members" || svc.isAdmin());
    if (canCreate) roomsHead.createEl("button", { text: "Share a folder" }).onclick = () => new NewRoomModal(this.plugin).open();
    // Rooms of yours, and (for admins) rooms no one can manage any more, which only an admin can delete.
    const rooms = svc.rooms().filter((room) => room.role !== undefined || (!room.managed && svc.isAdmin()));
    const hidden = new Set(this.plugin.hiddenRooms());
    if (rooms.length === 0) root.createEl("p", { cls: "vault-rooms-muted", text: canCreate ? "No rooms yet. Share a folder to start one." : "No rooms shared with you yet." });
    for (const room of rooms) {
      const folder = this.plugin.folderOf(room.id);
      const health = this.plugin.roomHealth(room.id);
      const missing = svc.replica(room.id)?.epochsMissing().length;
      const row = this.row(root, `room:${room.id}`, [room, folder, health, missing, hidden.has(room.id)]);
      if (!row) continue;
      row.addClass("vault-rooms-room");
      const title = row.createDiv({ cls: "vault-rooms-room-title" });
      setIcon(title.createSpan({ cls: "vault-rooms-icon" }), "folder-lock");
      title.createSpan({ text: room.name ?? (room.role ? "Waiting for the room key…" : `A room you aren't in (${room.id.slice(1, 5)})`) });
      row.createDiv({ cls: "vault-rooms-muted", text: `${room.role ? `You ${ROLE_LABEL[room.role]}` : "You aren't in it"} · ${Object.keys(room.members).length} people${folder ? ` · ${folder}` : hidden.has(room.id) ? " · not shown in this vault" : ""}` });
      if (!room.managed) row.createDiv({ cls: "vault-rooms-error", text: UNMANAGED });
      if (missing) row.createDiv({ cls: "vault-rooms-muted", text: "Part of this room can't be read here yet: it needs a room key from a member's computer, and arrives when one of them is online." });
      if (health?.syncing) row.createDiv({ cls: "vault-rooms-muted", text: `Syncing… ${count(health.syncing, "file")} to go.` });
      if (health?.stopped) row.createDiv({ cls: "vault-rooms-error", text: `Not syncing here: ${health.stopped}.` });
      else if (health?.failing.length) row.createDiv({ cls: "vault-rooms-error", text: `${count(health.failing.length, "file")} couldn't be written or read here: open in another program, or the disk full? Vault Rooms keeps trying.` });
      if (health?.heldBack.length) row.createDiv({ cls: "vault-rooms-muted", text: `${count(health.heldBack.length, "file")} of yours ${health.heldBack.length === 1 ? "stays" : "stay"} here without being shared. Open Details for the reason.` });
      // Buttons after what they act on.
      const actions = row.createDiv({ cls: "vault-rooms-actions" });
      actions.dataset.key = "actions";
      if (health && (health.stopped || health.failing.length || health.heldBack.length)) {
        actions.createEl("button", { text: "Try again" }).onclick = (event) => this.act(() => this.plugin.retryRoom(room.id), event.currentTarget as HTMLButtonElement);
        actions.createEl("button", { text: "Details" }).onclick = () => {
          const reasons = new Map(health.rejected?.map(({ path, reason }) => [path, reason]));
          const details = [...health.failing.slice(0, 20).map((path) => `Failing: ${path}`), ...health.heldBack.slice(0, 20).map((path) => `Not shared: ${path}${reasons.has(path) ? `: ${reasons.get(path)}` : ""}`)];
          new Notice(details.slice(0, 20).join("\n") || (health.stopped ?? ""), 15000);
        };
      }
      if (room.role) actions.createEl("button", { text: "Members" }).onclick = () => new MembersModal(this.plugin, room.id).open();
      else actions.createEl("button", { text: "Delete room" }).onclick = () => deleteRoom(this.plugin, room.id, () => this.render());
      if (hidden.has(room.id)) actions.createEl("button", { text: "Show in this vault" }).onclick = (event) => this.act(() => this.plugin.showRoom(room.id), event.currentTarget as HTMLButtonElement);
      if (folder)
        actions.createEl("button", { text: "Show folder" }).onclick = () => {
          const target = this.app.vault.getAbstractFileByPath(folder);
          if (target instanceof TFolder) {
            const explorer = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view as unknown as { revealInFolder?: (file: TFolder) => void } | undefined;
            if (explorer?.revealInFolder) explorer.revealInFolder(target);
            else new Notice(`Open the file explorer to see "${folder}".`);
          }
        };
    }

    // People
    const peopleHead = root.createDiv({ cls: "vault-rooms-section" });
    peopleHead.createEl("h5", { text: "People" });
    // Only admins can invite new people (anyone can add another computer of their own, below).
    if (svc.isAdmin()) peopleHead.createEl("button", { text: "Invite someone" }).onclick = () => new InviteModal(this.plugin).open();
    for (const [userId, user] of Object.entries(state.users)) {
      if (user.removed) continue;
      const devices = devicesByUser.get(userId) ?? [];
      const row = this.row(root, `person:${userId}`, devices.map(([id]) => online.has(id)));
      if (!row) continue;
      row.addClass("vault-rooms-person");
      row.createDiv({ cls: "vault-rooms-person-name", text: `${label(userId)}${userId === svc.me.userId ? " (you)" : ""}${user.admin ? " · admin" : ""}` });
      for (const [deviceId, device] of devices) {
        const line = row.createDiv({ cls: "vault-rooms-device" });
        const isMe = deviceId === svc.me.deviceId;
        const on = isMe || online.has(deviceId);
        // Said, not only coloured.
        line.createSpan({ cls: `vault-rooms-dot ${on ? "is-online" : ""}`, attr: { role: "img", "aria-label": on ? "online" : "offline", title: on ? "Online" : "Offline" } });
        line.createSpan({ text: `${device.name}${isMe ? " (this computer)" : ""}` });
        if (!isMe && (svc.isAdmin() || userId === svc.me.userId))
          line.createEl("button", { text: "Revoke", cls: "vault-rooms-small", attr: { "aria-label": `Revoke ${deviceLabel(state, deviceId)}` } }).onclick = async () => {
            const orphaned = svc.roomsLeftUnmanaged(deviceId).map(roomName);
            const warning = orphaned.length ? `

It is the last computer of the managers of ${orphaned.join(", ")}: no one could change their members any more (an admin could only delete them). If you can, make someone else a manager there first.` : "";
            if (await confirmAction(this.app, "Revoke computer", `${deviceLabel(state, deviceId)} is cut off from the workspace now, and invites it made stop working. Its rooms get new keys as soon as someone who can edit them is online, so it can't read anything added after that. Use this for a lost or replaced computer.${warning}`, "Revoke")) await this.act(() => svc.revokeDevice(deviceId));
          };
      }
      if (svc.isAdmin() && userId !== svc.me.userId) {
        const actions = row.createDiv({ cls: "vault-rooms-actions" });
        actions.createEl("button", { text: user.admin ? "Remove admin" : "Make admin", cls: "vault-rooms-small", attr: { "aria-label": `${user.admin ? "Remove admin" : "Make admin"}: ${label(userId)}` } }).onclick = async () => {
          if (user.admin || (await confirmAction(this.app, "Make admin", `${label(userId)} can then invite and remove people and computers, delete any room, and change the workspace's settings.`, "Make admin"))) await this.act(() => svc.setAdmin(userId, !user.admin));
        };
        actions.createEl("button", { text: "Remove from workspace", cls: "vault-rooms-small", attr: { "aria-label": `Remove ${label(userId)} from the workspace` } }).onclick = async () => {
          const managesAlone = svc.roomsOnlyManagedBy(userId).map(roomName);
          if (managesAlone.length) return void new Notice(`${label(userId)} is the only manager of ${managesAlone.join(", ")}: make someone else a manager there first (or delete those rooms).`, 10000);
          if (await confirmAction(this.app, "Remove from workspace", `${label(userId)} and all their computers are cut off now, and invites they made stop working. Their rooms get new keys as soon as someone who can edit them is online. They keep what they already had.`, "Remove")) await this.act(() => svc.removeUser(userId));
        };
      }
    }

    // Open invites (visible to everyone: invites are part of the shared record)
    const invites = Object.entries(svc.node.chain.state.invites).filter(([, invite]) => invite.used === undefined);
    if (invites.length > 0) {
      root.createDiv({ cls: "vault-rooms-section" }).createEl("h5", { text: "Open invites" });
      for (const [inviteId, invite] of invites) {
        const row = root.createDiv({ cls: "vault-rooms-invite" });
        const by = label(invite.by);
        const hours = Math.ceil((invite.expires - Date.now()) / 3_600_000);
        row.createSpan({ text: `${invite.forUser ? "Another computer" : "New person"} · by ${by} · ${hours <= 0 ? "expired" : `expires in ${hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`}`}` });
        const granted = Object.keys(invite.rooms);
        const managesGranted = granted.length > 0 && granted.every((roomId) => roleIn(state, roomId, svc.me.userId) === "manage");
        if (svc.isAdmin() || invite.by === svc.me.userId || managesGranted) row.createEl("button", { text: "Withdraw", cls: "vault-rooms-small" }).onclick = () => this.act(() => svc.withdrawInvite(inviteId));
      }
    }

    // This computer
    root.createDiv({ cls: "vault-rooms-section" }).createEl("h5", { text: "This computer" });
    const addresses = svc.addresses();
    root.createDiv({ cls: "vault-rooms-muted", text: addresses.length ? `Reachable at ${addresses.join(", ")}` : svc.listeningPort ? `Listening on port ${svc.listeningPort}` : "Not reachable: other computers can't connect to this one now." });
    if (svc.isMember())
      root.createEl("button", { text: "Add another computer of mine" }).onclick = (event) =>
        this.act(async () => {
          const link = await svc.createDeviceInvite();
          new LinkModal(this.app, "Add another computer", link, "Open this link in Obsidian on your other computer. It opens in the vault last used there: if that isn't the one you want, open that vault and paste the link under Join with an invite link. It works once, within a day. Keep this computer on, with Obsidian open, until the other one has joined.").open();
        }, event.currentTarget as HTMLButtonElement);
  }
}
