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

import { INDEX_DOC } from "@vault-rooms/secure";
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
      getRoot: () => Object.assign(folderAt(""), { children: [] }),
      getAllLoadedFiles: () => [...items.values()],
      createFolder: async (path: string) => { created.push(path); items.set(path, folderAt(path)); }
    },
    workspace: { getActiveFile: () => null }
  };
  const plugin: any = new VaultRoomsPlugin(app, {} as any);
  plugin.settings = { mountRoot: "Rooms", mesh: { scope: "testscope", workspace: { id: "ws", rooms: { r1: { folder, ...(hidden ? { hidden } : {}) } } } } };
  const replica = {};
  plugin.service = { rooms: () => [{ id: "r1", name: "Plans" }], roomName(id: string) { return this.rooms().find((r: { id: string }) => r.id === id)?.name ?? null; }, replica: () => replica, state: { devices: {}, users: {} }, me: { deviceId: "d" }, secrets: { sign: {} } };
  plugin.saveSettings = async () => {};
  plugin.syncEditors = () => {};
  plugin.editors = { unbindRoom: () => {}, isBound: () => false };
  vi.spyOn(RoomFolder.prototype, "start").mockResolvedValue();
  return { plugin, replica, items, created, room: () => plugin.settings.mesh.workspace.rooms.r1 };
}

const cleanup = (plugin: any) => { for (const presence of plugin.presences.values()) presence.destroy(); };

describe("a change the room refused", () => {
  it("holds back the note it was about, but not the room's file list, and reloads both", () => {
    const { plugin } = setup("Rooms/Plans", ["Rooms/Plans"]);
    const reloaded: string[] = [];
    plugin.service = { replica: () => ({ reload: (docId: string) => void reloaded.push(docId) }) };
    const held: string[] = [];
    plugin.folders.set("r1", { holdBackNote: (id: string) => void held.push(id), remoteChanged: () => {} });
    plugin.editors = { unbindNote: () => {} };
    plugin.syncEditorsSoon = () => {};
    const note = `f${"a".repeat(22)}`;
    plugin.handleRefused("r1", note, "publish_refused");
    plugin.handleRefused("r1", INDEX_DOC, "publish_refused");
    expect(held).toEqual([note]);
    expect(reloaded).toEqual([note, INDEX_DOC]);
    cleanup(plugin);
  });
});

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
    // Obsidian's choice is in a room the note isn't in (attachments set to go there): next to the note instead.
    expect(plugin.attachmentInRoom("Team/Images/scan.png", "scan.png", "Diary/Today.md")).toBe("Diary/scan.png");
    expect(plugin.attachmentInRoom("Team/Images/scan.png", "scan.png", "Today.md")).toBe("scan.png");
  });

  it("puts a note made from a room note's link into the room, next to that note", () => {
    const { plugin } = setup("Team", ["Team", "Team/Notes"]);
    let writable = true;
    plugin.service.replica = () => ({ canWrite: () => writable });
    plugin.app.metadataCache = { unresolvedLinks: { "Team/Notes/Board.md": { "Connection pool": 1 }, "Private/Plan.md": { "Connection pool": 1 } } };
    const root = folderAt("/");
    expect(plugin.linkedNoteFolder(root, "Team/Notes/Board.md", "Connection pool")?.path).toBe("Team/Notes");
    expect(plugin.linkedNoteFolder(root, "Team/Notes/Board.md", "Connection pool#Steps")?.path).toBe("Team/Notes");
    expect(plugin.linkedNoteFolder(folderAt("Elsewhere"), "Team/Notes/Board.md", "Connection pool")?.path).toBe("Team/Notes");
    // Obsidian's choice already in the room, a note outside rooms, a new note no link asked for: Obsidian's choice stays.
    expect(plugin.linkedNoteFolder(folderAt("Team/Inbox"), "Team/Notes/Board.md", "Connection pool")).toBeNull();
    expect(plugin.linkedNoteFolder(root, "Private/Plan.md", "Connection pool")).toBeNull();
    expect(plugin.linkedNoteFolder(root, "Team/Notes/Board.md", "Untitled")).toBeNull();
    expect(plugin.linkedNoteFolder(root, "Team/Notes/Board.md")).toBeNull();
    expect(plugin.linkedNoteFolder(root, "", "Connection pool")).toBeNull();
    // A room you may only read would refuse the note.
    writable = false;
    expect(plugin.linkedNoteFolder(root, "Team/Notes/Board.md", "Connection pool")).toBeNull();
  });

  it("puts a note Kanban makes from a card of a room's board into the room, next to the board", () => {
    const { plugin } = setup("Team", ["Team", "Team/Notes"]);
    let writable = true;
    plugin.service.replica = () => ({ canWrite: () => writable });
    const boards = new Set(["Team/Notes/Board.md", "Private/Board.md"]);
    plugin.app.metadataCache = { unresolvedLinks: {}, getCache: (p: string) => ({ frontmatter: boards.has(p) ? { "kanban-plugin": "basic" } : {} }) };
    const root = folderAt("/");
    const kanban = "Error\n    at onClick (plugin:obsidian-kanban:67:20000)";
    expect(plugin.cardNoteFolder(root, "Team/Notes/Board.md", undefined, kanban)?.path).toBe("Team/Notes");
    expect(plugin.cardNoteFolder(folderAt("Elsewhere"), "Team/Notes/Board.md", undefined, kanban)?.path).toBe("Team/Notes");
    // Obsidian's own New note, Kanban's new board, a note that isn't a board, a board outside rooms, a link to follow (the
    // link rule's case) and Obsidian's choice already in the room: Obsidian's choice stays.
    expect(plugin.cardNoteFolder(root, "Team/Notes/Board.md", undefined, "Error\n    at JI.executeCommand (app://obsidian.md/app.js:585:12523)")).toBeNull();
    expect(plugin.cardNoteFolder(root, "Team/Notes/Board.md", undefined, "Error\n    at wf.newKanban (plugin:obsidian-kanban:67:11381)")).toBeNull();
    // Kanban wraps the command runner, so it is deeper in every command's stack: only the immediate caller counts.
    const command = "Error\n    at Object.callback (app://obsidian.md/app.js:585:10910)\n    at JI.<anonymous> (plugin:obsidian-kanban:67:17160)";
    expect(plugin.cardNoteFolder(root, "Team/Notes/Board.md", undefined, command)).toBeNull();
    // vault-rooms' own frames (this wrapper) are skipped when finding the caller.
    expect(plugin.cardNoteFolder(root, "Team/Notes/Board.md", undefined, `Error\n    at files.getNewFileParent (plugin:vault-rooms:1:1)${kanban.slice(5)}`)?.path).toBe("Team/Notes");
    expect(plugin.cardNoteFolder(root, "Team/Notes/Plan.md", undefined, kanban)).toBeNull();
    expect(plugin.cardNoteFolder(root, "Private/Board.md", undefined, kanban)).toBeNull();
    expect(plugin.cardNoteFolder(root, "Team/Notes/Board.md", "Connection pool", kanban)).toBeNull();
    expect(plugin.cardNoteFolder(folderAt("Team/Inbox"), "Team/Notes/Board.md", undefined, kanban)).toBeNull();
    // A room you may only read would refuse the note.
    writable = false;
    expect(plugin.cardNoteFolder(root, "Team/Notes/Board.md", undefined, kanban)).toBeNull();
  });

  it("hooks attachments where Obsidian's paste and drop and Kanban ask for their path: the vault", async () => {
    const { plugin, items } = setup("Team", ["Team", "Team/Notes"]);
    items.set("Team/Notes", Object.assign(folderAt("Team/Notes"), { children: [] }));
    plugin.register = () => {};
    plugin.app.vault.getAvailablePathForAttachments = async (name: string, ext: string) => `${name}.${ext}`;
    plugin.hookAttachments();
    expect(await plugin.app.vault.getAvailablePathForAttachments("Pasted image", "png", { path: "Team/Notes/Plan.md" })).toBe("Team/Notes/Pasted image.png");
    expect(await plugin.app.vault.getAvailablePathForAttachments("Pasted image", "png", { path: "Private/Plan.md" })).toBe("Pasted image.png");
    expect(await plugin.app.vault.getAvailablePathForAttachments("Pasted image", "png", null)).toBe("Pasted image.png");
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

describe("whether another plugin may change a file", () => {
  it("follows the room's role: false for a reader, true for an editor, null outside rooms or while the room isn't loaded", () => {
    const { plugin, replica } = setup("Team", ["Team"]);
    (replica as any).canWrite = () => false;
    expect(plugin.canWrite("Team/Plan.md")).toBe(false);
    (replica as any).canWrite = () => true;
    expect(plugin.canWrite("Team/Sub/Plan.md")).toBe(true);
    expect(plugin.canWrite("Elsewhere/Plan.md")).toBeNull();
    expect(plugin.canWrite("Teamwork/Plan.md")).toBeNull();
    plugin.service.replica = () => null;
    expect(plugin.canWrite("Team/Plan.md")).toBeNull();
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
    await expect(plugin.createWorkspace({ workspaceName: "Team", userName: "Ana", deviceName: "PC" })).rejects.toThrow("can't be read");
    await expect(plugin.joinWorkspace({ link: "x", userName: "Ana", deviceName: "PC" })).rejects.toThrow("can't be read");
    expect(plugin.saveData).not.toHaveBeenCalled();
    // Readable again (the other program let go): read as usual on the next try.
    plugin.loadData = async () => ({ mountRoot: "Shared", mesh: { scope: "testscope0000000", workspace: null } });
    await plugin.loadSettings();
    expect(plugin.settingsUnreadable).toBe(false);
    expect(plugin.settings.mountRoot).toBe("Shared");
  });

  it("aren't written again at start when nothing in them changed", async () => {
    const app: any = { vault: { adapter: { exists: async () => true } } };
    const plugin: any = new VaultRoomsPlugin(app, { dir: ".obsidian/plugins/vault-rooms" } as any);
    plugin.loadData = async () => ({ mesh: { scope: "testscope0000000", workspace: null }, mountRoot: "Shared" });
    plugin.saveData = vi.fn();
    await plugin.loadSettings();
    expect(plugin.settings.mountRoot).toBe("Shared");
    expect(plugin.saveData).not.toHaveBeenCalled();
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
