import { ItemView, Notice, setIcon, TFolder, type WorkspaceLeaf } from "obsidian";
import { activeDevice } from "@vault-rooms/secure";
import type VaultRoomsPlugin from "../plugin.js";
import { confirmAction, CreateWorkspaceModal, InviteModal, JoinModal, LinkModal, MembersModal, NewRoomModal } from "./modals.js";

export const ROOMS_VIEW = "vault-rooms-panel";

const ROLE_LABEL = { read: "can read", write: "can edit", manage: "manage" } as const;

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^forbidden:/, "Not allowed: ");
}

export class RoomsView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private renderTimer: number | null = null;

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

  private async act(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      new Notice(errorText(error), 8000);
    }
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("vault-rooms-panel");
    const svc = this.plugin.service;
    if (!svc) {
      if (this.plugin.serviceError) {
        root.createEl("p", { text: this.plugin.serviceError, cls: "vault-rooms-error" });
        root.createEl("button", { text: "Leave the workspace on this computer" }).onclick = async () => {
          if (await confirmAction(this.app, "Leave the workspace", "This deletes the workspace data and this computer's keys from this vault. Your files stay. You can join again with a new invite.", "Leave")) await this.act(() => this.plugin.leaveWorkspace());
        };
        return;
      }
      root.createEl("h4", { text: "Share folders on this network" });
      root.createEl("p", { text: "Work on notes together with people on the same local network, live, without any server or cloud. Everything is end-to-end encrypted: a computer only holds readable copies of the rooms its user belongs to." });
      const buttons = root.createDiv({ cls: "vault-rooms-buttons" });
      const create = buttons.createEl("button", { text: "Create a workspace", cls: "mod-cta" });
      create.onclick = () => new CreateWorkspaceModal(this.plugin).open();
      buttons.createEl("button", { text: "Join with an invite link" }).onclick = () => new JoinModal(this.plugin).open();
      return;
    }

    const state = svc.state;
    const me = state.users[svc.me.userId];
    const online = new Set(svc.connectedDevices());
    const otherDevices = Object.entries(state.devices).filter(([deviceId]) => deviceId !== svc.me.deviceId && activeDevice(state, deviceId));

    const head = root.createDiv({ cls: "vault-rooms-head" });
    head.createEl("h4", { text: state.name });
    head.createDiv({ cls: "vault-rooms-status", text: `${online.size} of ${otherDevices.length} other computer${otherDevices.length === 1 ? "" : "s"} online` });
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
    const rooms = svc.rooms().filter((room) => room.role !== undefined);
    if (rooms.length === 0) root.createEl("p", { cls: "vault-rooms-muted", text: canCreate ? "No rooms yet. Share a folder to start one." : "No rooms shared with you yet." });
    for (const room of rooms) {
      const row = root.createDiv({ cls: "vault-rooms-room" });
      const title = row.createDiv({ cls: "vault-rooms-room-title" });
      setIcon(title.createSpan({ cls: "vault-rooms-icon" }), "folder-lock");
      title.createSpan({ text: room.name ?? "Waiting for the room key…" });
      const folder = this.plugin.folderOf(room.id);
      row.createDiv({ cls: "vault-rooms-muted", text: `You ${ROLE_LABEL[room.role!]} · ${Object.keys(room.members).length} people${folder ? ` · ${folder}` : ""}` });
      if (svc.replica(room.id)?.epochsMissing().length) row.createDiv({ cls: "vault-rooms-muted", text: "Some content is waiting for a key from a member who's online." });
      const actions = row.createDiv({ cls: "vault-rooms-actions" });
      actions.createEl("button", { text: "Members" }).onclick = () => new MembersModal(this.plugin, room.id).open();
      if (folder)
        actions.createEl("button", { text: "Show folder" }).onclick = () => {
          const target = this.app.vault.getAbstractFileByPath(folder);
          if (target instanceof TFolder) {
            const explorer = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view as unknown as { revealInFolder?: (file: TFolder) => void } | undefined;
            explorer?.revealInFolder?.(target);
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
      const row = root.createDiv({ cls: "vault-rooms-person" });
      row.createDiv({ cls: "vault-rooms-person-name", text: `${user.name}${userId === svc.me.userId ? " (you)" : ""}${user.admin ? " · admin" : ""}` });
      for (const [deviceId, device] of Object.entries(state.devices)) {
        if (device.user !== userId || device.revoked) continue;
        const line = row.createDiv({ cls: "vault-rooms-device" });
        const isMe = deviceId === svc.me.deviceId;
        line.createSpan({ cls: `vault-rooms-dot ${isMe || online.has(deviceId) ? "is-online" : ""}` });
        line.createSpan({ text: `${device.name}${isMe ? " (this computer)" : ""}` });
        if (!isMe && (svc.isAdmin() || userId === svc.me.userId))
          line.createEl("button", { text: "Revoke", cls: "vault-rooms-small" }).onclick = async () => {
            if (await confirmAction(this.app, "Revoke computer", `"${device.name}" is cut off from the workspace now, and the keys of its rooms are replaced. Use this for a lost or replaced computer.`, "Revoke")) await this.act(() => svc.revokeDevice(deviceId));
          };
      }
      if (svc.isAdmin() && userId !== svc.me.userId) {
        const actions = row.createDiv({ cls: "vault-rooms-actions" });
        actions.createEl("button", { text: user.admin ? "Remove admin" : "Make admin", cls: "vault-rooms-small" }).onclick = () => this.act(() => svc.setAdmin(userId, !user.admin));
        actions.createEl("button", { text: "Remove from workspace", cls: "vault-rooms-small" }).onclick = async () => {
          if (await confirmAction(this.app, "Remove from workspace", `${user.name} and all their computers are cut off, and the keys of their rooms are replaced. They keep what they already had.`, "Remove")) await this.act(() => svc.removeUser(userId));
        };
      }
    }

    // Open invites (visible to everyone: invites are part of the shared record)
    const invites = Object.entries(svc.node.chain.state.invites).filter(([, invite]) => invite.used === undefined);
    if (invites.length > 0) {
      root.createDiv({ cls: "vault-rooms-section" }).createEl("h5", { text: "Open invites" });
      for (const [inviteId, invite] of invites) {
        const row = root.createDiv({ cls: "vault-rooms-invite" });
        const by = state.users[invite.by]?.name ?? "?";
        const hours = Math.max(0, Math.round((invite.expires - Date.now()) / 3_600_000));
        row.createSpan({ text: `${invite.forUser ? "Another computer" : "New person"} · by ${by} · expires in ${hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`}` });
        if (svc.isAdmin() || invite.by === svc.me.userId) row.createEl("button", { text: "Withdraw", cls: "vault-rooms-small" }).onclick = () => this.act(() => svc.withdrawInvite(inviteId));
      }
    }

    // This computer
    root.createDiv({ cls: "vault-rooms-section" }).createEl("h5", { text: "This computer" });
    const addresses = svc.addresses();
    root.createDiv({ cls: "vault-rooms-muted", text: addresses.length ? `Reachable at ${addresses.join(", ")}` : `Listening on port ${svc.listeningPort}` });
    if (svc.isMember())
      root.createEl("button", { text: "Add another computer of mine" }).onclick = () =>
        this.act(async () => {
          const link = await svc.createDeviceInvite();
          new LinkModal(this.app, "Add another computer", link, "Open this link in Obsidian on your other computer (in the vault you want to use there). It works once, within a day.").open();
        });
  }
}
