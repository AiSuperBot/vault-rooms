import { App, Modal, Notice, Setting, TFolder } from "obsidian";
import { cleanName, parseInviteLink, ROLES, roleIn, type Role } from "@vault-rooms/secure";
import type VaultRoomsPlugin from "../plugin.js";
import { personLabel } from "./labels.js";
import { errorText, pendingAction } from "./actions.js";

const ROLE_LABEL: Record<Role, string> = { read: "Can read", write: "Can edit", manage: "Manages" };

/** Ask before doing something that can't be undone. Resolves true if confirmed. */
export function confirmAction(app: App, title: string, body: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let answered = false;
    modal.titleEl.setText(title);
    for (const paragraph of body.split("\n\n")) modal.contentEl.createEl("p", { text: paragraph });
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => modal.close()))
      .addButton((button) =>
        button
          .setButtonText(action)
          .setWarning()
          .onClick(() => {
            answered = true;
            resolve(true);
            modal.close();
          })
      );
    modal.onClose = () => {
      if (!answered) resolve(false);
    };
    modal.open();
  });
}

/** Said of a room whose managers have no computer left in the workspace (see RoomInfo.managed). */
export const UNMANAGED = "No one can change this room's members any more: its managers have no computer left in the workspace. It keeps syncing for its members; an admin can delete it (its files stay on every computer), and share its folder again as a new room.";

/** Delete a room for everyone, once confirmed (managers and admins may). */
export async function deleteRoom(plugin: VaultRoomsPlugin, roomId: string, done?: () => void): Promise<void> {
  const svc = plugin.service;
  if (!svc) return;
  const name = svc.rooms().find((room) => room.id === roomId)?.name;
  if (!(await confirmAction(plugin.app, "Delete room", `${name ? `"${name}"` : "This room"} is deleted for everyone: its files stay on every computer that has them, but stop syncing, and no one can open the room again. This can't be undone.`, "Delete"))) return;
  await pendingAction(() => svc.deleteRoom(roomId), undefined, done);
}

export class CreateWorkspaceModal extends Modal {
  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Create a workspace");
    const values = { workspaceName: "Team", userName: "", deviceName: this.plugin.defaultDeviceName() };
    this.contentEl.createEl("p", { text: "A workspace is the group of people you share rooms (folders) with on this network. You'll be its first admin." });
    new Setting(this.contentEl).setName("Workspace name").addText((text) => text.setValue(values.workspaceName).onChange((v) => (values.workspaceName = cleanName(v))));
    new Setting(this.contentEl).setName("Your name").setDesc("How others see you.").addText((text) => text.onChange((v) => (values.userName = cleanName(v))));
    new Setting(this.contentEl).setName("This computer").addText((text) => text.setValue(values.deviceName).onChange((v) => (values.deviceName = cleanName(v))));
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Create")
        .setCta()
        .onClick(async () => {
          if (!values.workspaceName || !values.userName || !values.deviceName) return new Notice("Please fill in every field.");
          await pendingAction(() => this.plugin.createWorkspace(values), button, () => this.close());
        })
    );
  }
}

export class JoinModal extends Modal {
  constructor(
    private readonly plugin: VaultRoomsPlugin,
    private readonly params?: Record<string, string>
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Join a workspace");
    if (this.plugin.settings.mesh.workspace) {
      this.contentEl.createEl("p", { text: "This vault already belongs to a workspace. To join another one, use another vault." });
      return;
    }
    const link = this.params ? `obsidian://vault-rooms?${new URLSearchParams(this.params).toString()}` : "";
    const values = { link, userName: "", deviceName: this.plugin.defaultDeviceName(), address: "" };
    this.contentEl.createEl("p", { text: "Paste the invite link someone in the workspace sent you. This computer gets its own keys; nothing secret is in the link beyond the one-time invite." });
    new Setting(this.contentEl).setName("Invite link").addTextArea((text) => {
      text.setValue(link).onChange((v) => (values.link = v.trim()));
      text.inputEl.rows = 3;
      text.inputEl.style.width = "100%";
    });
    // A link for another computer of someone's own names them already.
    new Setting(this.contentEl).setName("Your name").setDesc(this.params?.u ? "Not needed: this link adds another computer of yours." : "How others see you. Not needed for a link to add another computer of yours.").addText((text) => text.onChange((v) => (values.userName = cleanName(v))));
    new Setting(this.contentEl).setName("This computer").addText((text) => text.setValue(values.deviceName).onChange((v) => (values.deviceName = cleanName(v))));
    new Setting(this.contentEl)
      .setName("Computer address (optional)")
      .setDesc("Only if joining fails: the address of a computer in the workspace, e.g. 192.168.1.20:47880 (shown in its Vault Rooms panel).")
      .addText((text) => text.onChange((v) => (values.address = v.trim())));
    const status = this.contentEl.createEl("p", { cls: "vault-rooms-status" });
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Join")
        .setCta()
        .onClick(async () => {
          const forUser = (() => {
            try {
              return parseInviteLink(values.link).forUser;
            } catch {
              return undefined; // said by joining, below
            }
          })();
          // The record keeps the name it has for that person: this one only fills the join record.
          const userName = values.userName || (forUser ? values.deviceName : "");
          if (!values.link || !userName || !values.deviceName) return new Notice("Please fill in the link, your name and this computer's name.");
          button.setDisabled(true);
          status.setText("Connecting…");
          try {
            await this.plugin.joinWorkspace({ link: values.link, userName, deviceName: values.deviceName, peers: values.address ? [values.address] : [] });
            new Notice("Joined. Rooms shared with you appear as their keys arrive.", 8000);
            this.close();
          } catch (error) {
            status.setText(errorText(error));
            button.setDisabled(false);
          }
        })
    );
  }
}

export class LinkModal extends Modal {
  constructor(
    app: App,
    private readonly heading: string,
    private readonly link: string,
    private readonly note: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl("p", { text: this.note });
    const area = this.contentEl.createEl("textarea", { cls: "vault-rooms-link" });
    area.value = this.link;
    area.readOnly = true;
    area.rows = 4;
    area.style.width = "100%";
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Copy link")
        .setCta()
        .onClick(async () => {
          await navigator.clipboard.writeText(this.link);
          new Notice("Invite link copied.");
        })
    );
  }
}

export class InviteModal extends Modal {
  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const svc = this.plugin.service;
    this.titleEl.setText("Invite someone");
    if (!svc) return;
    const managed = svc.rooms().filter((room) => room.role === "manage");
    const grants: Record<string, Role> = {};
    let days = 3;
    this.contentEl.createEl("p", { text: "The link lets one new person join the workspace, with the rooms you pick here. You can give them more rooms later." });
    if (managed.length === 0) this.contentEl.createEl("p", { text: "You don't manage any rooms yet, so this invite brings no rooms; a room's managers can add the person afterwards." });
    for (const room of managed) {
      new Setting(this.contentEl).setName(room.name ?? "Room").addDropdown((dropdown) => {
        dropdown.addOption("", "No access");
        for (const role of ROLES) dropdown.addOption(role, ROLE_LABEL[role]);
        dropdown.onChange((value) => {
          if (value) grants[room.id] = value as Role;
          else delete grants[room.id];
        });
      });
    }
    new Setting(this.contentEl).setName("Link expires after").addDropdown((dropdown) =>
      dropdown
        .addOptions({ "1": "1 day", "3": "3 days", "7": "7 days" })
        .setValue("3")
        .onChange((value) => (days = Number(value)))
    );
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Create invite link")
        .setCta()
        .onClick(async () => {
          await pendingAction(async () => {
            const link = await svc.createInvite(grants, days);
            this.close();
            new LinkModal(this.app, "Invite link", link, `Send this link privately (not in a public channel): whoever has it can join until it is used or expires in ${days} day${days > 1 ? "s" : ""}. Keep this computer on, with Obsidian open, until they have joined: it is the one they connect to.`).open();
          }, button);
        })
    );
  }
}

export class NewRoomModal extends Modal {
  constructor(private readonly plugin: VaultRoomsPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.titleEl.setText("Share a folder as a room");
    // The folders sharing would take: the same check it makes (names, dot folders, other rooms' folders).
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && file.path !== "/")
      .map((folder) => folder.path)
      .filter((path) => this.plugin.folderProblem(path) === null)
      .sort();
    if (folders.length === 0) {
      this.contentEl.createEl("p", { text: "There is no folder to share yet. Make a folder in your vault (in the file explorer), put the notes to share in it, then come back here." });
      return;
    }
    const values = { folder: folders[0] ?? "", name: folders[0]?.split("/").pop() ?? "" };
    this.contentEl.createEl("p", { text: "Everything in the folder is shared, end-to-end encrypted, with the people you add. You manage the room; add people under Members afterwards." });
    let nameField: { setValue(value: string): unknown } | null = null;
    new Setting(this.contentEl).setName("Folder").addDropdown((dropdown) => {
      for (const path of folders) dropdown.addOption(path, path);
      dropdown.setValue(values.folder).onChange((value) => {
        values.folder = value;
        values.name = value.split("/").pop() ?? value;
        nameField?.setValue(values.name);
      });
    });
    new Setting(this.contentEl).setName("Room name").addText((text) => {
      nameField = text;
      text.setValue(values.name).onChange((value) => (values.name = cleanName(value)));
    });
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("Share folder")
        .setCta()
        .onClick(async () => {
          if (!values.folder || !values.name) return new Notice("Pick a folder and a name.");
          await pendingAction(() => this.plugin.createRoom(values.folder, values.name), button, () => this.close());
        })
    );
  }
}

export class MembersModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private nameDraft: string | undefined;
  private chosen: string | undefined;
  private addRole: Role = "write";
  /** What the dialog was last drawn from: redrawn only when that changes, so an open dropdown isn't closed under the user. */
  private shown: [unknown, unknown, string] | null = null;
  constructor(
    private readonly plugin: VaultRoomsPlugin,
    private readonly roomId: string
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.unsubscribe = this.plugin.onChange(() => {
      const svc = this.plugin.service;
      const now = [svc, svc?.state, JSON.stringify(svc?.rooms().find((r) => r.id === this.roomId) ?? null)];
      if (!this.shown || now.some((value, i) => value !== this.shown![i])) this.render();
    });
    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private render(): void {
    const active = this.contentEl.ownerDocument.activeElement as HTMLInputElement | HTMLSelectElement | null;
    const focus = active && this.contentEl.contains(active) ? active.dataset.focusKey : undefined;
    const selection = active?.tagName === "INPUT" ? [(active as HTMLInputElement).selectionStart, (active as HTMLInputElement).selectionEnd] : null;
    const svc = this.plugin.service;
    this.contentEl.empty();
    if (!svc) return this.close();
    const room = svc.rooms().find((r) => r.id === this.roomId);
    this.shown = [svc, svc.state, JSON.stringify(room ?? null)];
    if (!room || room.role === undefined) return this.close();
    this.titleEl.setText(`Members of ${room.name ?? "this room"}`);
    const state = svc.state;
    const iManage = room.role === "manage";
    if (!room.managed) this.contentEl.createEl("p", { cls: "vault-rooms-error", text: UNMANAGED });
    for (const [userId, role] of Object.entries(room.members)) {
      const user = state.users[userId];
      if (!user || user.removed) continue;
      const row = new Setting(this.contentEl).setName(`${personLabel(state, userId)}${userId === svc.me.userId ? " (you)" : ""}`);
      if (iManage) {
        row.addDropdown((dropdown) => {
          for (const option of ROLES) dropdown.addOption(option, ROLE_LABEL[option]);
          dropdown.selectEl.dataset.focusKey = `member:${userId}`;
          dropdown.setValue(role).onChange(async (value) => {
            // Giving up managing can't be undone by oneself: asked first (redrawn as it was if not).
            if (userId === svc.me.userId && role === "manage" && !(await confirmAction(this.app, "Stop managing this room", "You'll no longer manage this room, and can't change that back yourself (being an admin doesn't let you either): another manager would have to.", "Change"))) return this.render();
            await this.run(() => svc.setMember(this.roomId, userId, value as Role));
          });
        });
        if (userId !== svc.me.userId)
          row.addButton((button) => {
            button.buttonEl.dataset.focusKey = `remove:${userId}`;
            button.setButtonText("Remove").onClick(async () => {
              if (await confirmAction(this.app, "Remove from room", `${personLabel(state, userId)} loses access to this room. A new room key is made, so they can't read anything added from now on (they keep what they already have).`, "Remove")) await this.run(() => svc.setMember(this.roomId, userId, null));
            });
          });
      } else row.setDesc(ROLE_LABEL[role]);
    }
    if (iManage) {
      const candidates = Object.entries(state.users).filter(([userId, user]) => !user.removed && roleIn(state, this.roomId, userId) === undefined);
      if (candidates.length > 0) {
        if (!candidates.some(([id]) => id === this.chosen)) this.chosen = candidates[0]![0];
        new Setting(this.contentEl)
          .setName("Add a person")
          .addDropdown((dropdown) => {
            for (const [userId] of candidates) dropdown.addOption(userId, personLabel(state, userId));
            dropdown.selectEl.dataset.focusKey = "add-person";
            dropdown.setValue(this.chosen!).onChange((value) => (this.chosen = value));
          })
          .addDropdown((dropdown) => {
            for (const option of ROLES) dropdown.addOption(option, ROLE_LABEL[option]);
            dropdown.selectEl.dataset.focusKey = "add-role";
            dropdown.setValue(this.addRole).onChange((value) => (this.addRole = value as Role));
          })
          .addButton((button) => {
            button.buttonEl.dataset.focusKey = "add";
            button.setButtonText("Add").onClick(async () => {
              const chosen = this.chosen!;
              const role = this.addRole;
              if (await confirmAction(this.app, "Add to room", `${personLabel(state, chosen)} is added to this room (${ROLE_LABEL[role].toLowerCase()}), and gets everything already in it.`, "Add")) await this.run(() => svc.setMember(this.roomId, chosen, role));
            });
          });
      }
      new Setting(this.contentEl)
        .setName("Room name")
        .addText((text) => {
          text.inputEl.dataset.focusKey = "room-name";
          text.setValue(this.nameDraft ?? room.name ?? "").onChange((value) => (this.nameDraft = value));
        })
        .addButton((button) => {
          button.buttonEl.dataset.focusKey = "rename";
          button.setButtonText("Rename").onClick(() => {
            const name = cleanName(this.nameDraft ?? room.name ?? "");
            return name ? this.run(async () => { await svc.renameRoom(this.roomId, name); this.nameDraft = undefined; }) : undefined;
          });
        });
    }
    const actions = new Setting(this.contentEl);
    if (svc.roomsOnlyManagedBy(svc.me.userId).includes(this.roomId)) {
      // Leaving would leave no one to manage it: the record wouldn't take it.
      actions.setDesc("You're this room's only manager: to leave it, make someone else a manager first, or delete the room.");
    } else
      actions.addButton((button) => {
        button.buttonEl.dataset.focusKey = "leave";
        button.setButtonText("Leave this room").onClick(async () => {
          if (await confirmAction(this.app, "Leave room", "You stop receiving this room. Its folder stays on this computer but no longer syncs.", "Leave")) await this.run(() => svc.leaveRoom(this.roomId));
        });
      });
    if (iManage || svc.isAdmin()) actions.addButton((button) => {
      button.buttonEl.dataset.focusKey = "delete";
      button.setButtonText("Delete room").setWarning().onClick(() => deleteRoom(this.plugin, this.roomId, () => this.close()));
    });
    if (focus) {
      const target = Array.from(this.contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-focus-key]")).find((element) => element.dataset.focusKey === focus);
      target?.focus();
      if (target?.tagName === "INPUT" && selection) (target as HTMLInputElement).setSelectionRange(selection[0] ?? null, selection[1] ?? null);
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    await pendingAction(action);
    this.render();
  }
}
