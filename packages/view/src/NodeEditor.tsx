/**
 * Node editing overlay.
 *
 * While a node is being edited it is covered by a real ProseMirror instance
 * positioned over its canvas position. On commit the overlay is destroyed and the
 * canvas re-renders the settled SVG scene.
 *
 * That split is the whole reason the maths rendering path looks the way it does.
 * The overlay can afford KaTeX's HTML output and a live caret inside a formula,
 * because it exists for one node at a time and is never exported. The settled scene
 * stays pure SVG so that export and vector output remain possible.
 */

import { useLayoutEffect, useRef } from 'react';
import { EditorView } from 'prosemirror-view';
import {
  LOCAL_ORIGIN,
  createEditorState,
  inlineDocFromEditor,
  type EditorOptions,
} from '@adnota/editor';
import type { InlineDoc, NodeId } from '@adnota/core';
import { measureLabelBox } from './scene.ts';
import { toScreen, type Viewport } from './viewport.ts';

export interface NodeEditorProps {
  readonly nodeId: NodeId;
  readonly label: InlineDoc;
  /** World-space centre of the node being edited. */
  readonly worldX: number;
  readonly worldY: number;
  readonly viewport: Viewport;
  /** Commit the new label and leave editing. */
  readonly onCommit: (id: NodeId, label: InlineDoc) => void;
  /** Abandon editing without writing. */
  readonly onCancel: () => void;
  /** Structural intent raised from inside the editor, e.g. Enter or Tab. */
  readonly onCommand: (command: 'split' | 'child' | 'outdent', id: NodeId) => void;
}

export function NodeEditor({
  nodeId,
  label,
  worldX,
  worldY,
  viewport,
  onCommit,
  onCancel,
  onCommand,
}: NodeEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Callbacks are captured in refs rather than listed as effect dependencies. The
  // editor must not be torn down and rebuilt every time the parent re-renders, which
  // would drop the caret and the undo stack mid-sentence.
  const callbacks = useRef({ onCommit, onCancel, onCommand });
  callbacks.current = { onCommit, onCancel, onCommand };

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const options: EditorOptions = {
      doc: label,
      onSplit: () => callbacks.current.onCommand('split', nodeId),
      onExit: () => callbacks.current.onCancel(),
    };

    const state = createEditorState(options);

    const view = new EditorView(host, {
      state,
      dispatchTransaction(transaction) {
        const next = view.state.apply(transaction);
        view.updateState(next);

        if (!transaction.docChanged) return;

        // Everything dispatched from inside this editor is the student's own edit, so
        // it carries the local origin that autosave keys on. Remote updates arrive
        // through the collaboration layer and are marked there instead.
        transaction.setMeta(LOCAL_ORIGIN, true);
        callbacks.current.onCommit(nodeId, inlineDocFromEditor(next.doc));
      },
      attributes: {
        class: 'adnota-editor',
        'data-testid': 'node-editor',
        // The overlay is a real text field; screen readers and the on-screen keyboard
        // need it to be focusable and labelled rather than a decorative div.
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Node text',
      },
    });

    viewRef.current = view;
    // Placing the caret at the end means double-clicking a node to edit continues
    // from where the student was already writing.
    view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Deliberately node-id only: re-creating on label changes would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const size = measureLabelBox(label);
  const topLeft = toScreen(viewport, worldX, worldY);

  return (
    <div
      className="adnota-editor-overlay"
      data-testid="editor-overlay"
      // The overlay lives inside the canvas, whose click handler clears the selection.
      // Without this, clicking into the text you are editing tears the editor down
      // underneath the caret, which is the single most broken-feeling thing this
      // component could do.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        left: `${topLeft.x - size.width / 2}px`,
        top: `${topLeft.y - size.height / 2}px`,
        width: `${size.width}px`,
        minHeight: `${size.height}px`,
      }}
    >
      <div ref={hostRef} className="adnota-editor-host" />
    </div>
  );
}