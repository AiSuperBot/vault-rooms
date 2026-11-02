import { afterEach, describe, expect, it, vi } from "vitest";
import { TFolder } from "obsidian";

vi.mock("obsidian", async (original) => {
  const actual = await original<object>();
  const { UiModal, UiSetting, UiElement } = await import("../uiDom.js");
  return {
    ...actual, Modal: UiModal, Setting: UiSetting, setIcon: () => {},
    Plugin: class { constructor(public app: unknown, public manifest: unknown) {} },
    ItemView: class { contentEl = new UiElement("div"); app = {}; },
    PluginSettingTab: class {}, MarkdownView: class {}, TAbstractFile: class {}
  };
});

import VaultRoomsPlugin from "../../src/plugin.js";
import { RoomFolder } from "../../src/mesh/roomFolder.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const folderAt = (path: string): TFolder => Object.assign(Object.create(TFolder.prototype), { path });

/** A plugin whose room "r1" was last in `folder`, in a vault holding `folders`. */
function setup(folder: string, folders: string[], hidden = false) {
  const items = new Map<string, unknown>(folders.map((path) => [path, folderAt(path)]));
  const created: string[] = [];
  const app: any = {
    vault: {
      getAbstractFileByPath: (path: string) => items.get(path) ?? null,
      getAllLoadedFiles: () => [...items.values()],
      createFolder: async (path: string) => { created.push(path); items.set(path, folderAt(path)); }
    },
    workspace: { getActiveFile: () => null }
  };
  const plugin: any = new VaultRoomsPlugin(app, {} as any);
  plugin.settings = { mountRoot: "Rooms", mesh: { scope: "testscope", workspace: { id: "ws", rooms: { r1: { folder, ...(hidden ? { hidden } : {}) } } } } };
  const replica = {};
  plugin.service = { rooms: () => [{ id: "r1", name: "Plans" }], replica: () => replica, state: { devices: {}, users: {} }, me: { deviceId: "d" }, secrets: { sign: {} } };
  plugin.saveSettings = async () => {};
  plugin.syncEditors = () => {};
  plugin.editors = { unbindRoom: () => {}, isBound: () => false };
  vi.spyOn(RoomFolder.prototype, "start").mockResolvedValue();
  return { plugin, replica, items, created, room: () => plugin.settings.mesh.workspace.rooms.r1 };
}

const cleanup = (plugin: any) => { for (const presence of plugin.presences.values()) presence.destroy(); };

describe("a room's folder on this computer", () => {
  it("isn't made again when it is gone (renamed or deleted outside Obsidian): the room is hidden, not downloaded twice", async () => {
    const { plugin, replica, created, room } = setup("Team", ["Team renamed"]);
    await plugin.onReplica("r1", replica);
    expect(room().hidden).toBe(true);
    expect(created).toEqual([]);
    expect(plugin.folders.has("r1")).toBe(false);
  });

  it("places a room shared with you once, even when it is looked at twice while its folder is being made", async () => {
    const { plugin, replica, created } = setup("unused", []);
    delete plugin.settings.mesh.workspace.rooms.r1;
    plugin.saveSettings = () => new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.all([plugin.onReplica("r1", replica), plugin.onReplica("r1", replica)]);
    const room = plugin.settings.mesh.workspace.rooms.r1;
    expect(room.hidden).toBeUndefined();
    expect(room.folder).toBe("Rooms/Plans");
    expect(created).toContain("Rooms/Plans");
    expect(plugin.folders.has("r1")).toBe(true);
    cleanup(plugin);
  });

  it("follows a folder renamed only by case outside Obsidian", async () => {
    const { plugin, replica, created, room } = setup("Team", ["team"]);
    await plugin.onReplica("r1", replica);
    expect(room().folder).toBe("team");
    expect(created).toEqual([]);
    expect(plugin.folders.has("r1")).toBe(true);
    cleanup(plugin);
  });

  it("is shown again in its folder once that is back (restored from the trash)", async () => {
    const { plugin, created, room } = setup("Team", ["Team"], true);
    await plugin.showRoom("r1");
    expect(room()).toEqual({ folder: "Team" });
    expect(created).toEqual([]);
    expect(plugin.folders.has("r1")).toBe(true);
    cleanup(plugin);
  });

  it("follows two quick renames to the last name", async () => {
    vi.stubGlobal("window", { setTimeout: () => 0 });
    const { plugin, room } = setup("A", []);
    const moved = vi.fn();
    plugin.folders.set("r1", { stop: () => new Promise((resolve) => setTimeout(resolve, 30)), folderMoved: moved });
    const first = plugin.onFolderRename("B", "A");
    const second = plugin.onFolderRename("C", "B");
    await Promise.all([first, second]);
    expect(room().folder).toBe("C");
    expect(moved).toHaveBeenCalled();
  });

  it("puts an attachment of a room's note into the room, next to the note", () => {
    const { plugin, items } = setup("Team", ["Team"]);
    expect(plugin.attachmentInRoom("Pasted image.png", "Pasted image.png", "Team/Notes/Plan.md")).toBe("Team/Notes/Pasted image.png");
    items.set("Team/Notes/Pasted image.png", {});
    expect(plugin.attachmentInRoom("Pasted image.png", "Pasted image.png", "Team/Notes/Plan.md")).toBe("Team/Notes/Pasted image 2.png");
    // Already in the room, or a note outside any room: Obsidian's choice stays.
    expect(plugin.attachmentInRoom("Team/files/x.png", "x.png", "Team/Plan.md")).toBe("Team/files/x.png");
    expect(plugin.attachmentInRoom("x.png", "x.png", "Private/Plan.md")).toBe("x.png");
  });

  it("gives an attachment a name no file of that folder has, whatever its case", () => {
    const { plugin, items } = setup("Team", ["Team"]);
    items.set("Team/Notes", Object.assign(folderAt("Team/Notes"), { children: [{ path: "Team/Notes/Scan.pdf" }] }));
    expect(plugin.attachmentInRoom("scan.pdf", "scan.pdf", "Team/Notes/Plan.md")).toBe("Team/Notes/scan 2.pdf");
  });

  it("frees a deleted room's folder, to be shared again", async () => {
    const { plugin } = setup("Team", ["Team"]);
    plugin.service.replica = () => null;
    plugin.service.state = { devices: {}, users: {}, rooms: { r1: { deleted: true, members: {} } } };
    plugin.service.membershipEndedBy = () => undefined;
    await plugin.onReplica("r1", null);
    expect(plugin.settings.mesh.workspace.rooms.r1).toBeUndefined();
  });
});

describe("the plugin's settings", () => {
  it("are never saved over when data.json is there but can't be read, and nothing starts", async () => {
    const app: any = { vault: { adapter: { exists: async () => true } } };
    const plugin: any = new VaultRoomsPlugin(app, { dir: ".obsidian/plugins/vault-rooms" } as any);
    plugin.loadData = async () => null;
    plugin.saveData = vi.fn();
    await plugin.loadSettings();
    expect(plugin.settingsUnreadable).toBe(true);
    await expect(plugin.saveSettings()).rejects.toThrow("can't be read");
    await expect(plugin.leaveWorkspace()).rejects.toThrow("can't be read");
    expect(plugin.saveData).not.toHaveBeenCalled();
    // Readable again (the other program let go): read as usual on the next try.
    plugin.loadData = async () => ({ mountRoot: "Shared", mesh: { scope: "testscope0000000", workspace: null } });
    await plugin.loadSettings();
    expect(plugin.settingsUnreadable).toBe(false);
    expect(plugin.settings.mountRoot).toBe("Shared");
  });

  it("start fresh when there is no data.json yet", async () => {
    const app: any = { vault: { adapter: { exists: async () => false } } };
    const plugin: any = new VaultRoomsPlugin(app, { dir: ".obsidian/plugins/vault-rooms" } as any);
    plugin.loadData = async () => null;
    plugin.saveData = vi.fn();
    await plugin.loadSettings();
    expect(plugin.settingsUnreadable).toBe(false);
    expect(plugin.saveData).toHaveBeenCalled();
  });
});
