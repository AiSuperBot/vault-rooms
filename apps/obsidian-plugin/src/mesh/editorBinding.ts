import { createHash } from "node:crypto";
import { Compartment, EditorState, Prec, Transaction, type Extension } from "@codemirror/state";
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

function sha(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("base64url");
}

export class EditorBinding {
  readonly compartment = new Compartment();
  private bound = new Map<EditorView, Bound>();

  constructor(
    private readonly resolve: (vaultPath: string) => BindTarget | null,
    /** Ask the owner to call sync() soon (with the editors open then). */
    private readonly requestSync: () => void
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

  /** Bring the bindings in line with the editors that are open now. Safe to call often. */
  sync(open: Array<{ path: string; view: EditorView }>): void {
    const targets = new Map<EditorView, BindTarget | null>();
    for (const { path, view } of open) targets.set(view, this.resolve(path));
    for (const [view, bound] of [...this.bound]) {
      const target = targets.get(view);
      // The editor's state was replaced (a file was loaded into it): the binding is gone, make it again.
      if (this.compartment.get(view.state) !== bound.extension) {
        this.forget(view);
        continue;
      }
      if (!targets.has(view) || !target || target.ytext !== bound.ytext || target.readOnly !== bound.readOnly) this.unbind(view);
    }
    for (const [view, target] of targets) {
      if (!target || this.bound.has(view)) continue;
      this.bind(view, target);
    }
  }

  private bind(view: EditorView, target: BindTarget): void {
    const editorText = view.state.doc.toString();
    const sharedText = target.ytext.toString();
    // Text in the editor that was never synced is a local edit: fold it into the shared text first, so binding
    // (which shows the shared text) can't throw it away. Otherwise the editor just shows an older copy.
    if (editorText !== sharedText && !target.readOnly && target.syncedHash !== null && sha(editorText) !== target.syncedHash) {
      reconcileYTextWithDiskText(target.ytext, editorText, "editor");
    }
    const undo = new Y.UndoManager(target.ytext);
    const facade = target.presence.facade(target.fileId, target.ytext.doc!);
    const now = view.state.doc.toString();
    const shared = target.ytext.toString();
    const extension: Extension = [yCollab(target.ytext, facade, { undoManager: undo }), target.readOnly ? READ_ONLY : []];
    try {
      view.dispatch({
        ...(now === shared ? {} : { changes: { from: 0, to: now.length, insert: shared } }),
        effects: this.compartment.reconfigure(extension)
      });
    } catch {
      facade.destroy();
      undo.destroy();
      return;
    }
    this.bound.set(view, { extension, roomId: target.roomId, fileId: target.fileId, ytext: target.ytext, readOnly: target.readOnly, facade, undo });
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

  unbindAll(): void {
    for (const view of [...this.bound.keys()]) this.unbind(view);
  }
}
