import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { EditorBinding, safeToBind, SHARED_UNDO, WHOLE_CHARACTERS, type BindTarget } from "../../src/mesh/editorBinding.js";

describe("binding an editor", () => {
  it("undoes only this person's typing: Ctrl+Z goes to the shared undo, others' edits stay out of the editor's history", () => {
    const state = EditorState.create({ doc: "a", extensions: [SHARED_UNDO] });
    expect(state.facet(keymap).flat().some((binding) => binding.key === "Mod-z")).toBe(true);
    const remote = state.update({ changes: { from: 1, insert: "R" } });
    expect(remote.annotation(Transaction.addToHistory)).toBe(false);
    const typed = remote.state.update({ changes: { from: 2, insert: "t" }, userEvent: "input.type" });
    expect(typed.annotation(Transaction.addToHistory)).toBeUndefined();
  });

  it("keeps an existing binding while dependencies wait and delays new bindings", () => {
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "OLD");
    const target = { roomId: "r", fileId: "f", ytext: doc.getText("content"), readOnly: false, complete: false, fromShared: () => true, presence: { facade: () => ({ destroy() {} }) } } as unknown as BindTarget;
    const bindings = new EditorBinding(() => target, () => {});
    const view = {
      state: EditorState.create({ doc: "OLD", extensions: [bindings.extension()] }),
      dispatch(spec: TransactionSpec) { this.state = this.state.update(spec).state; }
    };
    const sync = () => bindings.sync([{ path: "Team/Plan.md", view: view as unknown as EditorView, disk: "OLD" }]);
    sync();
    expect(bindings.isBound("r", "f")).toBe(false);
    target.complete = true; sync();
    expect(bindings.isBound("r", "f")).toBe(true);
    const extension = bindings.compartment.get(view.state);
    target.complete = false; sync();
    expect(bindings.isBound("r", "f")).toBe(true);
    expect(bindings.compartment.get(view.state)).toBe(extension);
    bindings.unbindAll(); doc.destroy();
  });

  it("replaces what the editor shows only when nothing in it can be lost", () => {
    const synced = createHash("sha256").update("old\n").digest("base64url");
    const fromShared = (hash: string) => hash === synced;
    expect(safeToBind("same\n", "same\n", null, fromShared)).toBe(true);
    // The editor shows its file, which holds a version that came from the shared note: just outdated.
    expect(safeToBind("old\n", "new\n", "old\n", fromShared)).toBe(true);
    // Still loading (empty for a moment), or typing not saved yet.
    expect(safeToBind("", "new\n", "old\n", fromShared)).toBe(false);
    expect(safeToBind("old\ntyped", "new\n", "old\n", fromShared)).toBe(false);
    // Changed while not co-edited: the room folder shares it (or keeps it as a copy) first.
    expect(safeToBind("mine\n", "new\n", "mine\n", fromShared)).toBe(false);
  });
});

describe("editor changes", () => {
  it("are widened so they never cut an emoji in two, and the shared text stays intact", () => {
    const state = EditorState.create({ doc: "a😀b", extensions: [WHOLE_CHARACTERS] });
    // What Obsidian does when the file changed elsewhere: replace only the low half of the pair.
    const tr = state.update({ changes: { from: 2, to: 3, insert: "\uDE03" } });
    expect(tr.state.doc.toString()).toBe("a😃b");
    const changes: Array<[number, number, string]> = [];
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push([fromA, toA, inserted.toString()]));
    expect(changes).toEqual([[1, 3, "😃"]]);
    // Applied to the shared text the way the binding does, and sent to another computer: no U+FFFD anywhere.
    const local = new Y.Doc();
    local.getText("content").insert(0, "a😀b");
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
    local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));
    const text = local.getText("content");
    local.transact(() => {
      for (const [from, to, insert] of changes) {
        text.delete(from, to - from);
        text.insert(from, insert);
      }
    });
    expect(text.toString()).toBe("a😃b");
    expect(remote.getText("content").toString()).toBe("a😃b");
  });

  it("leave ordinary changes alone", () => {
    const state = EditorState.create({ doc: "a😀b", extensions: [WHOLE_CHARACTERS] });
    const tr = state.update({ changes: { from: 3, to: 4, insert: "c" } });
    expect(tr.state.doc.toString()).toBe("a😀c");
  });
});
