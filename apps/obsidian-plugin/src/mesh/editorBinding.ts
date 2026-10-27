import { createHash } from "node:crypto";
import { Compartment, EditorState, Prec, Transaction, type Annotation, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { reconcileYTextWithDiskText } from "../crdtReconcile.js";
import type { AwarenessFacade, RoomPresence } from "./presence.js";

/**
 * Live co-editing: every open editor showing a note of a room is bound to that note's shared text with
 * y-codemirror's yCollab (shared text, other people's cursors, undo of your own edits only). One Compartment is
 * registered globally and reconfigured per editor. Notes in rooms you may only read are shown read-only.
 */

export interface BindTarget {
  roomId: string;
  fileId: string;
  ytext: Y.Text;
  presence: RoomPresence;
  readOnly: boolean;
  /** Hash of the content last synced to disk, to tell unsaved local text from an outdated copy. */
  syncedHash: string | null;
}

interface Bound {
  /** The exact extension put into the compartment, to notice when the editor's state was replaced. */
  extension: Extension;
  roomId: string;
  fileId: string;
  ytext: Y.Text;
  readOnly: boolean;
  facade: AwarenessFacade;
  undo: Y.UndoManager;
}

/**
 * A room you may only read: no editing from the keyboard, and any change that carries a user-input marker (typing,
 * paste, drop, delete, undo) is dropped before it reaches the document. Remote updates from yCollab carry none.
 */
const READ_ONLY: Extension = Prec.highest([
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorState.transactionFilter.of((tr) => (tr.docChanged && tr.annotation(Transaction.userEvent) !== undefined ? [] : tr))
]);

/** Whether `pos` falls between the two halves of a surrogate pair (inside an emoji, say). */
function splitsPair(doc: Text, pos: number): boolean {
  if (pos <= 0 || pos >= doc.length) return false;
  const pair = doc.sliceString(pos - 1, pos + 1);
  const high = pair.charCodeAt(0);
  const low = pair.charCodeAt(1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * A change that would cut a surrogate pair in two (Obsidian applies a file changed elsewhere as a minimal diff, which
 * can replace half an emoji) is widened to whole characters, with the same result. The shared text can't hold half a
 * pair: Yjs would turn both halves into U+FFFD, for everyone.
 */
export const WHOLE_CHARACTERS: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const doc = tr.startState.doc;
  let splits = false;
  tr.changes.iterChanges((fromA, toA) => {
    if (splitsPair(doc, fromA) || splitsPair(doc, toA)) splits = true;
  });
  if (!splits) return tr;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let from = fromA;
    let to = toA;
    let insert = inserted.toString();
    if (splitsPair(doc, from)) insert = doc.sliceString(--from, fromA) + insert;
    if (splitsPair(doc, to)) insert += doc.sliceString(to, ++to);
    changes.push({ from, to, insert });
  });
  for (let i = 1; i < changes.length; i++) if (changes[i]!.from < changes[i - 1]!.to) return tr;
  // Every annotation goes along (the one y-codemirror marks its own changes with included, which isn't exported).
  const all = (tr as unknown as { annotations?: unknown }).annotations;
  const userEvent = tr.annotation(Transaction.userEvent);
  const addToHistory = tr.annotation(Transaction.addToHistory);
  const remote = tr.annotation(Transaction.remote);
  const annotations = Array.isArray(all)
    ? (all as Annotation<unknown>[])
    : [
        ...(userEvent !== undefined ? [Transaction.userEvent.of(userEvent)] : []),
        ...(addToHistory !== undefined ? [Transaction.addToHistory.of(addToHistory)] : []),
        ...(remote !== undefined ? [Transaction.remote.of(remote)] : [])
      ];
  return { changes, selection: tr.selection, effects: tr.effects, scrollIntoView: tr.scrollIntoView, annotations };
});

function sha(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("base64url");
}

export class EditorBinding {
  readonly compartment = new Compartment();
  private bound = new Map<EditorView, Bound>();

  constructor(
    private readonly resolve: (vaultPath: string) => BindTarget | null,
    /** Ask the owner to call sync() soon (with the editors open then). */
    private readonly requestSync: (delayMs?: number) => void
  ) {}

  /**
   * The global extension: the compartment, plus a tiny plugin that is created whenever an editor gets a new state.
   * Obsidian replaces an editor's whole state when it loads a file into it, which resets the compartment, so a
   * binding made a moment earlier would silently vanish; this asks for a re-sync each time that happens.
   */
  extension(): Extension {
    const requestSync = this.requestSync;
    return [
      this.compartment.of([]),
      ViewPlugin.define(() => {
        requestSync();
        return {};
      })
    ];
  }

  isBound(roomId: string, fileId: string): boolean {
    for (const bound of this.bound.values()) if (bound.roomId === roomId && bound.fileId === fileId) return true;
    return false;
  }

  /** Whether an editor showing this note still has to be bound (so its file's text is needed for `sync`). */
  needsBinding(view: EditorView): boolean {
    return !this.bound.has(view) || this.compartment.get(view.state) !== this.bound.get(view)!.extension;
  }

  /**
   * Bring the bindings in line with the editors that are open now. Safe to call often. `disk` is the note's text as
   * the file holds it, for editors not bound yet (null if unknown).
   */
  sync(open: Array<{ path: string; view: EditorView; disk: string | null; synced?: string | null }>): void {
    const targets = new Map<EditorView, { target: BindTarget | null; disk: string | null; synced?: string | null }>();
    for (const { path, view, disk, synced } of open) targets.set(view, { target: this.resolve(path), disk, synced });
    for (const [view, bound] of [...this.bound]) {
      const target = targets.get(view)?.target;
      // The editor's state was replaced (a file was loaded into it): the binding is gone, make it again.
      if (this.compartment.get(view.state) !== bound.extension) {
        this.forget(view);
        continue;
      }
      if (!targets.has(view) || !target || target.ytext !== bound.ytext || target.readOnly !== bound.readOnly) this.unbind(view);
    }
    let waiting = false;
    for (const [view, { target, disk, synced }] of targets) {
      if (!target || this.bound.has(view)) continue;
      if (!this.bind(view, target, disk, synced === undefined ? target.syncedHash : synced)) waiting = true;
    }
    if (waiting) this.requestSync(500);
  }

  /**
   * Binding shows the shared text in the editor. What the editor held first is only folded into the shared text when
   * it is exactly the file's text and that text was never shared (changed while not co-edited). An editor holding
   * anything else is still loading the file, or has typing not saved yet: it is left alone and bound a moment later,
   * once it matches its file (Obsidian saves typing within seconds), so neither half-loaded nor stale text can ever
   * take anything away from the shared note.
   */
  private bind(view: EditorView, target: BindTarget, disk: string | null, synced: string | null): boolean {
    const editorText = view.state.doc.toString();
    // An editor holds "\n" line endings only; the shared text has to match it character for character.
    if (target.ytext.toString().includes("\r")) {
      if (target.readOnly) return true; // left unbound: a reader can't fix the shared text
      reconcileYTextWithDiskText(target.ytext, target.ytext.toString().replace(/\r\n?/g, "\n"), "editor");
    }
    const sharedText = target.ytext.toString();
    if (editorText !== sharedText) {
      if (disk === null || editorText !== disk) return false;
      if (!target.readOnly && synced !== null && sha(disk) !== synced) reconcileYTextWithDiskText(target.ytext, editorText, "editor");
    }
    const undo = new Y.UndoManager(target.ytext);
    const facade = target.presence.facade(target.fileId, target.ytext.doc!);
    const now = view.state.doc.toString();
    const shared = target.ytext.toString();
    const extension: Extension = [WHOLE_CHARACTERS, yCollab(target.ytext, facade, { undoManager: undo }), target.readOnly ? READ_ONLY : []];
    try {
      view.dispatch({
        ...(now === shared ? {} : { changes: { from: 0, to: now.length, insert: shared } }),
        effects: this.compartment.reconfigure(extension)
      });
    } catch {
      facade.destroy();
      undo.destroy();
      return true;
    }
    this.bound.set(view, { extension, roomId: target.roomId, fileId: target.fileId, ytext: target.ytext, readOnly: target.readOnly, facade, undo });
    return true;
  }

  /** Drop our record of a binding whose editor state is gone (nothing to reconfigure). */
  private forget(view: EditorView): void {
    const bound = this.bound.get(view);
    if (!bound) return;
    this.bound.delete(view);
    bound.facade.destroy();
    bound.undo.destroy();
  }

  private unbind(view: EditorView): void {
    const bound = this.bound.get(view);
    if (!bound) return;
    this.forget(view);
    try {
      view.dispatch({ effects: this.compartment.reconfigure([]) });
    } catch {
      // the view is gone
    }
  }

  unbindRoom(roomId: string): void {
    for (const [view, bound] of [...this.bound]) if (bound.roomId === roomId) this.unbind(view);
  }

  /** Stop co-editing one note; its editors keep the text they show. */
  unbindNote(roomId: string, fileId: string): void {
    for (const [view, bound] of [...this.bound]) if (bound.roomId === roomId && bound.fileId === fileId) this.unbind(view);
  }

  unbindAll(): void {
    for (const view of [...this.bound.keys()]) this.unbind(view);
  }
}
