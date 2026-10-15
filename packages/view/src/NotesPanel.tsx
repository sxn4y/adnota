/**
 * Notes panel.
 *
 * The label is what a mindmap is scannable by; the notes body is where a student
 * actually writes. It uses the block schema rather than the inline one, so it can hold
 * headings, lists, quotes, code, and display maths without inventing a second
 * storage format.
 *
 * The editor is rebuilt only when the *selected node* changes. Switching tabs or
 * re-rendering the canvas must not tear it down, or the caret and the undo stack would
 * be lost every time the outline updated underneath it.
 */

import { useLayoutEffect, useRef } from 'react';
import { EditorView } from 'prosemirror-view';
import { createBlockEditorState, LOCAL_ORIGIN } from '@adnota/editor';
import type { BlockDoc, NodeId } from '@adnota/core';

export interface NotesPanelProps {
  /** The node whose notes are being edited, or null when nothing is selected. */
  readonly nodeId: NodeId | null;
  readonly notes: BlockDoc | null;
  readonly onChange: (id: NodeId, notes: BlockDoc) => void;
  /** Called when the editor surrenders focus, so the canvas can take it back. */
  readonly onExit?: () => void;
}

const EMPTY: BlockDoc = { type: 'doc', content: [] };

export function NotesPanel({ nodeId, notes, onChange, onExit }: NotesPanelProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  /**
   * The notes the editor was built from.
   *
   * Captured once on mount and deliberately *not* tracked afterwards. The owner writes
   * every keystroke straight back to the document, which re-renders this panel with a
   * brand new `notes` object each time; depending on it would rebuild the editor after
   * every character and throw away the caret and the undo stack mid-sentence. Switching
   * nodes remounts the panel instead, which is handled by the owner's `key`.
   */
  const initialNotes = useRef(notes).current;

  const callbacks = useRef({ onChange, onExit, nodeId });
  callbacks.current = { onChange, onExit, nodeId };

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || nodeId === null) return undefined;

    const state = createBlockEditorState({
      doc: initialNotes ?? EMPTY,
      onChange: (next) => {
        const { onChange: commit, nodeId: id } = callbacks.current;
        if (id !== null) commit(id, next);
      },
      onExit: () => callbacks.current.onExit?.(),
    });

    const view = new EditorView(host, {
      state,
      dispatchTransaction(transaction) {
        // `setMeta` is applied before `updateState`: `apply` is what the view re-reads
        // for its meta, so stamping it afterwards would leave the view believing this
        // was a collaborator's edit.
        if (transaction.docChanged && !transaction.getMeta(REMOTE_MARK)) {
          transaction.setMeta(LOCAL_ORIGIN, true);
        }

        view.updateState(view.state.apply(transaction));
      },
    });

    viewRef.current = view;
    view.focus();

    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [nodeId, initialNotes]);

  if (nodeId === null) {
    return (
      <div className="adnota-notes is-empty" data-testid="notes-panel">
        <p className="adnota-notes-empty">Select a node to write notes against it.</p>
      </div>
    );
  }

  return (
    <div className="adnota-notes" data-testid="notes-panel">
      <div ref={hostRef} className="adnota-notes-host" data-testid="notes-editor" />
      <p className="adnota-notes-hint">
        Markdown-ish: <code>##</code> heading, <code>-</code> list, <code>```</code> code,{' '}
        <code>$$ </code> display maths, <code>$</code> inline maths
      </p>
    </div>
  );
}

/** Kept local so the panel does not depend on the collaboration layer's constants. */
const REMOTE_MARK = 'adnota.remote';