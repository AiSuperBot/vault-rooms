import { afterEach, describe, expect, it, vi } from "vitest";
import { doc, UiElement } from "../uiDom.js";

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

import { LinkModal, MembersModal } from "../../src/ui/modals.js";
import { RoomsView } from "../../src/ui/roomsView.js";
import { errorText, pendingAction } from "../../src/ui/actions.js";
import { refusalText } from "../../src/mesh/meshService.js";
import { SecureError } from "@vault-rooms/secure";
import { membershipLabels, personLabel } from "../../src/ui/labels.js";
import VaultRoomsPlugin from "../../src/plugin.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); doc.activeElement = null; });

function fixture(size = 2) {
  const users = Object.fromEntries(Array.from({ length: size }, (_, i) => [`u${i}`, { name: `Person ${i}`, admin: i === 0 }]));
  const devices = Object.fromEntries(Array.from({ length: size }, (_, i) => [`d${i}`, { name: `PC ${i}`, user: `u${i}` }]));
  let room: any = { id: "r1", name: "Plans", role: "manage", managed: true, members: { u0: "manage", u1: "write" } };
  const state: any = { name: "Team", roomCreation: "admins", users, devices, rooms: { r1: room }, invites: {} };
  const svc: any = { state, me: { userId: "u0", deviceId: "d0" }, node: { chain: { state } }, rooms: () => room ? [room] : [], isMember: () => true, isAdmin: () => true, replica: () => null, connectedDevices: () => [], roomsOnlyManagedBy: () => [], addresses: () => [], createDeviceInvite: vi.fn() };
  const listeners = new Set<() => void>();
  const plugin: any = { app: {}, service: svc, onChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }, hiddenRooms: () => [], folderOf: () => "Team", roomHealth: () => null };
  return { plugin, svc, state, listeners, updateRoom(value: any) { room = value; for (const listener of listeners) listener(); }, changed() { for (const listener of listeners) listener(); } };
}

describe("reported UI and folder-lifecycle regressions", () => {
  it("refreshes an open members dialog, keeps its name draft/caret, and unsubscribes on disappearance", () => {
    const f = fixture();
    const modal = new MembersModal(f.plugin, "r1");
    modal.onOpen();
    const root = modal.contentEl as unknown as UiElement;
    const name = root.querySelectorAll("input")[0]!;
    name.value = "Unfinished name";
    name.oninput?.();
    name.focus();
    name.setSelectionRange(4, 9);
    f.updateRoom({ ...f.svc.rooms()[0], members: { u0: "manage", u1: "read" } });
    expect(doc.activeElement?.value).toBe("Unfinished name");
    expect([doc.activeElement?.selectionStart, doc.activeElement?.selectionEnd]).toEqual([4, 9]);
    expect(root.querySelectorAll("select").find((element) => element.dataset.focusKey === "member:u1")?.value).toBe("read");
    // Something else changed (a peer came online, a file retried): an open dropdown stays as it is.
    const select = root.querySelectorAll("select")[0]!;
    f.changed();
    expect(root.querySelectorAll("select")[0]).toBe(select);
    root.querySelectorAll("button").find((element) => element.textContent === "Rename")!.focus();
    f.updateRoom({ ...f.svc.rooms()[0], members: { u0: "manage", u1: "write" } });
    expect(doc.activeElement?.dataset.focusKey).toBe("rename");
    expect(doc.activeElement?.textContent).toBe("Rename");
    f.updateRoom({ ...f.svc.rooms()[0], role: "read" });
    expect(root.querySelectorAll("input")).toHaveLength(0);
    f.updateRoom({ ...f.svc.rooms()[0], role: undefined });
    expect((modal as any).closed).toBe(true);
    expect(f.listeners.size).toBe(0);
    f.updateRoom({ id: "r1", name: "Plans", role: "read", managed: true, members: { u0: "read" } });
    const deleted = new MembersModal(f.plugin, "r1");
    deleted.onOpen();
    f.updateRoom(null);
    expect((deleted as any).closed).toBe(true);
    expect(f.listeners.size).toBe(0);
  });

  it("keeps a focused panel action through health/peer updates and creates only changed rows", () => {
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", globalThis);
    const f = fixture(2000);
    const view = new RoomsView({} as any, f.plugin);
    const render = () => (view as any).render();
    const root = view.contentEl as unknown as UiElement;
    const started = performance.now();
    render();
    const built = doc.created;
    const button = root.querySelectorAll("button").find((element) => element.textContent === "Members")!;
    button.focus();
    f.svc.connectedDevices = () => ["d1"];
    f.plugin.roomHealth = () => ({ stopped: null, failing: ["locked.md"], heldBack: [] });
    render();
    expect(doc.activeElement).toBe(button);
    expect(root.querySelectorAll("button")).toContain(button);
    expect(doc.created - built).toBeLessThan(2100);
    for (const missingKey of [true, false]) {
      f.svc.replica = () => ({ epochsMissing: () => missingKey ? [2] : [] });
      render();
      expect(doc.activeElement).toBe(button);
      expect(root.querySelectorAll("button")).toContain(button);
    }
    expect(membershipLabels(f.state)).toBe(membershipLabels(f.state));
    expect(personLabel(f.state, "u1999")).toBe("Person 1999");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("double-clicking the device invite action creates one invite and re-enables it after rejection", async () => {
    vi.stubGlobal("document", doc);
    const f = fixture();
    let reject!: (error: Error) => void;
    f.svc.createDeviceInvite.mockImplementation(() => new Promise((_, no) => { reject = no; }));
    const view = new RoomsView({} as any, f.plugin);
    (view as any).render();
    const root = view.contentEl as unknown as UiElement;
    const button = root.querySelectorAll("button").find((element) => element.textContent === "Add another computer of mine")!;
    const first = button.click();
    const second = button.click();
    expect(f.svc.createDeviceInvite).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    reject(new Error("forbidden:no access"));
    await Promise.all([first, second]);
    expect(button.disabled).toBe(false);
    // A refused change of the record says what was refused, in words, not its code.
    expect(errorText(new SecureError("forbidden", "no_manager:r1234"))).toBe("A room needs at least one manager: make someone else a manager first.");
    expect(errorText(new SecureError("forbidden", "device_keys:d1234"))).toBe("That change isn't allowed.");
    expect(refusalText("forbidden:invite_limit:i1234")).toMatch(/open invites/);
    expect(refusalText("fork")).toMatch(/at the same moment/);
    expect(refusalText("forbidden:time_backwards")).toMatch(/clock is behind/);
    expect(refusalText("forbidden:future")).toMatch(/clock is behind/);
    expect(refusalText("versions:incomplete")).toBe("The change wasn't applied (versions:incomplete).");
    let invited!: (link: string) => void;
    f.svc.createDeviceInvite.mockImplementation(() => new Promise((yes) => { invited = yes; }));
    const opened = vi.spyOn(LinkModal.prototype, "open");
    const success = button.click();
    const repeated = button.click();
    invited("obsidian://invite");
    await Promise.all([success, repeated]);
    expect(f.svc.createDeviceInvite).toHaveBeenCalledTimes(2); // One failed attempt and one successful attempt.
    expect(opened).toHaveBeenCalledTimes(1);
    let resolve!: () => void;
    const action = vi.fn(() => new Promise<void>((yes) => { resolve = yes; }));
    const component = { setDisabled: vi.fn() };
    const pending = pendingAction(action, component);
    await pendingAction(action, component);
    expect(action).toHaveBeenCalledTimes(1);
    resolve(); await pending;
    expect(component.setDisabled).toHaveBeenLastCalledWith(false);
  });

  it("keeps the folder of a room this computer lost access to from being shared into another room", () => {
    const plugin: any = new VaultRoomsPlugin({ vault: {} } as any, {} as any);
    plugin.settings = { mountRoot: "Rooms", mesh: { scope: "testscope", workspace: { id: "ws", rooms: { r1: { folder: "Team/HR" } } } } };
    plugin.service = { replica: () => null };
    // Its files stay on disk: a room around them would share them with its own members.
    expect(plugin.folderProblem("Team")).not.toBeNull();
    expect(plugin.folderProblem("Team/HR")).not.toBeNull();
  });
});
