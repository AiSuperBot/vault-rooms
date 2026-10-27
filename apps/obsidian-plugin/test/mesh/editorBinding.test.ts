import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import * as Y from "yjs";
import { WHOLE_CHARACTERS } from "../../src/mesh/editorBinding.js";

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
