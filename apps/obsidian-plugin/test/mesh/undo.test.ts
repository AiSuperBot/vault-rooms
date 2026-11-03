// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { EditorBinding, type BindTarget } from "../../src/mesh/editorBinding.js";

describe("undo in a co-edited note", () => {
  it("takes back only what was typed in this editor, and Ctrl+Y puts it back", () => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, "start\n");
    // No presence: the test needs no cursors of others.
    const target = { roomId: "r", fileId: "f", ytext, readOnly: false, complete: true, fromShared: () => true, presence: { facade: () => null } } as unknown as BindTarget;
    const bindings = new EditorBinding(() => target, () => {});
    const view = new EditorView({ state: EditorState.create({ doc: "start\n", extensions: [bindings.extension()] }), parent: document.body });
    bindings.sync([{ path: "Team/Plan.md", view, disk: "start\n" }]);
    expect(bindings.isBound("r", "f")).toBe(true);

    view.dispatch({ changes: { from: 6, insert: "mine\n" }, userEvent: "input.type" });
    // Someone else's edit arriving, and this computer's own change (another program's, read from disk).
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    other.getText("content").insert(0, "theirs\n");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), Symbol("remote"));
    doc.transact(() => ytext.insert(ytext.length, "disk\n"));
    expect(ytext.toString()).toBe("theirs\nstart\nmine\ndisk\n");

    const [undo, redo] = [yUndoManagerKeymap.find((b) => b.key === "Mod-z")!, yUndoManagerKeymap.find((b) => b.key === "Mod-y")!];
    undo.run!(view);
    expect(ytext.toString()).toBe("theirs\nstart\ndisk\n");
    expect(view.state.doc.toString()).toBe("theirs\nstart\ndisk\n");
    // Nothing more of this person's to take back: the others' text stays.
    undo.run!(view);
    expect(ytext.toString()).toBe("theirs\nstart\ndisk\n");
    redo.run!(view);
    expect(ytext.toString()).toBe("theirs\nstart\nmine\ndisk\n");
    view.destroy();
  });
});
