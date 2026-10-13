/**
 * The application shell.
 *
 * Owns document state, selection, and the viewport, and wires the keyboard model to
 * them. Kept free of any platform detail so the browser harness and the desktop
 * window mount exactly the same thing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getNode,
  setLabel,
  setCollapsed,
  type InlineDoc,
  type NodeId,
  type YDoc,
} from '@adnota/core';
import type { LayoutKind } from '@adnota/scene';
import { MathSupportReport } from './MathSupportReport.tsx';
import { NodeEditor } from './NodeEditor.tsx';
import { SceneView } from './SceneView.tsx';
import {
  useNodeCommands,
  useScene,
  useSceneBounds,
  useSelection,
} from './scene.ts';
import { buildSampleDocument } from './sample.ts';
import { detectMathSupport } from './support.ts';
import { IDENTITY_VIEWPORT, fitToContent, type Viewport } from './viewport.ts';

const LAYOUTS: readonly { readonly id: LayoutKind; readonly label: string }[] = [
  { id: 'two-sided', label: 'Two-sided' },
  { id: 'radial', label: 'Radial' },
  { id: 'left', label: 'Left' },
];

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;

export interface MindmapAppProps {
  /** Supplies the document. The harness uses a sample; the desktop app uses a file. */
  readonly createDocument?: () => YDoc;
  /** Commits a label change to the document. */
  readonly onLabelChange?: (id: NodeId, label: InlineDoc) => void;
  /** Commits a collapse toggle. */
  readonly onCollapsedChange?: (id: NodeId, collapsed: boolean) => void;
}

export function MindmapApp({
  createDocument,
  onLabelChange,
  onCollapsedChange,
}: MindmapAppProps = {}): React.JSX.Element {
  const doc = useMemo(() => (createDocument ? createDocument() : buildSampleDocument().doc), [createDocument]);
  const [kind, setKind] = useState<LayoutKind>('two-sided');
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT);
  const [showReport, setShowReport] = useState(false);

  const support = useMemo(() => detectMathSupport(), []);

  const scene = useScene({ doc, kind, revision });
  const bounds = useSceneBounds(scene);
  const selection = useSelection();
  const commands = useNodeCommands({
    doc,
    kind,
    onChange: useCallback(() => setRevision((value) => value + 1), []),
  });

  const canvasRef = useRef<HTMLDivElement | null>(null);

  // Fit the map once it has been laid out, so the student opens onto their notes
  // rather than onto empty space.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || bounds.width === 0) return;
    fitted.current = true;
    setViewport(
      fitToContent({
        minX: bounds.minX,
        minY: bounds.minY,
        contentWidth: bounds.width,
        contentHeight: bounds.height,
        viewportWidth: CANVAS_WIDTH,
        viewportHeight: CANVAS_HEIGHT,
      }),
    );
  }, [bounds.minX, bounds.minY, bounds.width, bounds.height]);

  const commitLabel = useCallback(
    (id: NodeId, label: InlineDoc) => {
      if (onLabelChange) onLabelChange(id, label);
      else setLabel(doc, id, label);
      setRevision((value) => value + 1);
    },
    [doc, onLabelChange],
  );

  const toggleCollapsed = useCallback(
    (id: NodeId) => {
      const node = getNode(doc, id);
      if (!node) return;
      if (onCollapsedChange) onCollapsedChange(id, !node.collapsed);
      else setCollapsed(doc, id, !node.collapsed);
      setRevision((value) => value + 1);
    },
    [doc, onCollapsedChange],
  );

  /**
   * The keyboard model.
   *
   * Each branch returns whether it fired. A handler that does nothing must let the
   * browser have the keystroke, otherwise Tab would stop moving focus the moment the
   * canvas has focus and the app would become a keyboard trap.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      const editingId = selection.editingId;

      // While a node is being edited the editor owns the keyboard entirely, including
      // Escape. Handling Escape at both levels meant the editor closed and the
      // selection cleared in the same keystroke in some browsers and not others, which
      // is exactly the kind of difference nobody should have to think about.
      if (editingId) return;

      if (event.key === 'Escape') {
        selection.setSelected(null);
        canvasRef.current?.focus();
        event.preventDefault();
        return;
      }

      const selected = selection.selectedId;
      if (!selected) return;

      const consumed = (): void => event.preventDefault();

      switch (event.key) {
        case 'Tab':
          if (event.shiftKey) {
            commands.outdent(selected);
            consumed();
          } else {
            const created = commands.addChild(selected);
            if (created) {
              selection.beginEditing(created);
              consumed();
            }
          }
          return;

        case 'Enter': {
          const created = commands.addSibling(selected);
          if (created) {
            selection.beginEditing(created);
            consumed();
          }
          return;
        }

        case 'Backspace':
        case 'Delete': {
          const node = getNode(doc, selected);
          // Only delete an empty node; otherwise Backspace would silently destroy a
          // label the student was about to finish typing.
          //
          // The keystroke is consumed either way. Leaving it unhandled lets the
          // browser act on it, and WebKit in particular treats an unconsumed
          // Backspace as "go back", which navigates the whole app away from the
          // document the student was working in.
          if (node && node.label.content.length === 0) {
            commands.remove(selected);
            selection.setSelected(null);
          }
          consumed();
          return;
        }

        case 'ArrowUp':
        case 'ArrowDown': {
          const next = commands.moveSelection(selected, event.key === 'ArrowUp' ? 'up' : 'down');
          if (next) {
            selection.setSelected(next);
            consumed();
          }
          return;
        }

        case 'ArrowLeft':
        case 'ArrowRight': {
          const next = commands.moveSelection(selected, event.key === 'ArrowLeft' ? 'left' : 'right');
          if (next) {
            selection.setSelected(next);
            consumed();
          }
          return;
        }

        case ' ':
          // Space collapses the branch, matching the way the space bar feels like a
          // toggle in every other outliner.
          toggleCollapsed(selected);
          consumed();
          return;

        case 'Enter+': {
          const node = getNode(doc, selected);
          if (node?.label.content.length) {
            selection.beginEditing(selected);
            consumed();
          }
          return;
        }

        default:
          return;
      }
    },
    [commands, doc, selection, toggleCollapsed],
  );

  const handleEditorCommand = useCallback(
    (command: 'split' | 'child' | 'outdent', id: NodeId) => {
      if (command === 'split') {
        const created = commands.addSibling(id);
        if (created) selection.beginEditing(created);
        return;
      }
      if (command === 'child') {
        const created = commands.addChild(id);
        if (created) selection.beginEditing(created);
        return;
      }
      commands.outdent(id);
      selection.beginEditing(id);
    },
    [commands, selection],
  );

  /**
   * Move keyboard focus to the canvas whenever a node is selected.
   *
   * The structural keystrokes are handled by the canvas element, and SVG children are
   * not focusable, so a plain click leaves focus on `<body>` and every subsequent Tab
   * or arrow key would go nowhere. The student would have to click the empty canvas
   * again before they could add a child, which reads as a broken app.
   */
  const selectAndFocus = useCallback(
    (id: NodeId) => {
      selection.setSelected(id);
      canvasRef.current?.focus();
    },
    [selection],
  );

  /**
   * Begin editing. Focus deliberately moves to the editor rather than here; the
   * overlay focuses its ProseMirror view on mount, and pulling focus back to the
   * canvas here would race it and leave the caret nowhere.
   */
  const editAndFocus = useCallback(
    (id: NodeId) => {
      selection.beginEditing(id);
    },
    [selection],
  );

  /**
   * Leave editing and hand focus back to the canvas.
   *
   * Unmounting the overlay drops focus to `<body>`, so without this the keyboard
   * model goes dead the moment a student presses Escape.
   */
  const finishEditing = useCallback(() => {
    selection.endEditing();
    canvasRef.current?.focus();
  }, [selection]);

  const editingEntry = selection.editingId ? scene.byId.get(selection.editingId) : undefined;
  const editingNode = selection.editingId ? getNode(doc, selection.editingId) : null;

  return (
    <div className="adnota-harness">
      <header className="adnota-toolbar">
        <span className="adnota-brand">Adnota</span>

        <div className="adnota-layouts" role="group" aria-label="Layout">
          {LAYOUTS.map((layout) => (
            <button
              key={layout.id}
              type="button"
              className={layout.id === kind ? 'is-active' : ''}
              aria-pressed={layout.id === kind}
              onClick={() => setKind(layout.id)}
              data-testid={`layout-${layout.id}`}
            >
              {layout.label}
            </button>
          ))}
        </div>

        <div className="adnota-layouts" role="group" aria-label="Node">
          <button
            type="button"
            onClick={() => commands.addSibling(selection.selectedId ?? ROOT_FALLBACK)}
            disabled={!selection.selectedId}
            data-testid="add-sibling"
          >
            Sibling
          </button>
          <button
            type="button"
            onClick={() => commands.addChild(selection.selectedId ?? ROOT_FALLBACK)}
            disabled={!selection.selectedId}
            data-testid="add-child"
          >
            Child
          </button>
          <button
            type="button"
            onClick={() => selection.selectedId && toggleCollapsed(selection.selectedId)}
            disabled={!selection.selectedId}
            data-testid="toggle-collapse"
          >
            Collapse
          </button>
        </div>

        <button
          type="button"
          className={showReport ? 'is-active' : ''}
          onClick={() => setShowReport((value) => !value)}
          data-testid="toggle-support"
        >
          {support.nativeMathmlInSvg ? 'MathML in SVG' : 'KaTeX + foreignObject'}
        </button>
      </header>

      <main
        className="adnota-canvas"
        data-testid="canvas"
        ref={canvasRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onClick={() => selection.setSelected(null)}
      >
        <SceneView
          scene={scene}
          kind={kind}
          viewport={viewport}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          selectedId={selection.selectedId}
          editingId={selection.editingId}
          onSelect={selectAndFocus}
          onEdit={editAndFocus}
          onViewportChange={setViewport}
        />

        {editingEntry && editingNode ? (
          <NodeEditor
            nodeId={editingNode.id}
            label={editingNode.label}
            worldX={editingEntry.x}
            worldY={editingEntry.y}
            viewport={viewport}
            onCommit={commitLabel}
            onCancel={finishEditing}
            onCommand={handleEditorCommand}
          />
        ) : null}
      </main>

      {showReport ? <MathSupportReport support={support} /> : null}
    </div>
  );
}

/** Used only to keep the disabled-guard total; a null selection never reaches it. */
const ROOT_FALLBACK = 'root';

/** Exported so tests can assert the canvas dimensions the app renders at. */
export const CANVAS_SIZE = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT } as const;