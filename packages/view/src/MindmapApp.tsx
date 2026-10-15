/**
 * The application shell.
 *
 * Owns document state, selection, and the viewport, and wires the keyboard model to
 * them. Kept free of any platform detail so the browser harness and the desktop
 * window mount exactly the same thing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getMeta,
  getNode,
  setCollapsed,
  setLabel,
  setNotes,
  toMarkdown,
  type BlockDoc,
  type InlineDoc,
  type NodeId,
  type SaveState,
  type YDoc,
} from '@adnota/core';
import type { LayoutKind } from '@adnota/scene';
import { MathSupportReport } from './MathSupportReport.tsx';
import { NodeEditor } from './NodeEditor.tsx';
import { NotesPanel } from './NotesPanel.tsx';
import { OutlinePanel } from './OutlinePanel.tsx';
import { SceneView } from './SceneView.tsx';
import { SearchPalette } from './SearchPalette.tsx';
import { DocumentsPanel } from './DocumentsPanel.tsx';
import { downloadText, toFilename } from './download.ts';
import type { DocumentLibrary, ExternalFileActions } from './library.ts';
import {
  useNodeCommands,
  useScene,
  useSceneBounds,
  useSelection,
} from './scene.ts';
import { buildSampleDocument } from './sample.ts';
import { detectMathSupport } from './support.ts';
import {
  IDENTITY_VIEWPORT,
  fitToContent,
  zoomAt,
  type Viewport,
} from './viewport.ts';

const LAYOUTS: readonly { readonly id: LayoutKind; readonly label: string }[] = [
  { id: 'two-sided', label: 'Two-sided' },
  { id: 'radial', label: 'Radial' },
  { id: 'left', label: 'Left' },
];

type PanelTab = 'outline' | 'notes';

/** One press of the zoom buttons. Roughly the same step as a wheel notch. */
const ZOOM_STEP = 1.2;

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;

export interface MindmapAppProps {
  /** Supplies the document. The harness uses a sample; the desktop app uses a file. */
  readonly createDocument?: () => YDoc;
  /** Commits a label change to the document. */
  readonly onLabelChange?: (id: NodeId, label: InlineDoc) => void;
  /** Commits a collapse toggle. */
  readonly onCollapsedChange?: (id: NodeId, collapsed: boolean) => void;
  /**
   * Persistence, when there is any.
   *
   * Absent in the browser harness, which has nowhere to save to. When present, the
   * filename and save state appear in the toolbar.
   *
   * The session is passed rather than a rendered status string so that React stays on
   * this side of the boundary: the desktop entry would otherwise have to re-render the
   * whole app on every autosave tick just to update three words in the corner.
   */
  readonly save?: SaveStatusSource;
  /**
   * The set of documents that can be opened.
   *
   * Absent in the browser harness, which has no library to browse, and the Documents
   * button is hidden rather than shown permanently disabled — a control that can never
   * work is just clutter.
   */
  readonly library?: DocumentLibrary;
  /** Desktop-only Open / Save As. Absent in the harness. */
  readonly externalFiles?: ExternalFileActions;
  /** Serialises the open document, for Save As. Supplied with `externalFiles`. */
  readonly readOpenDocument?: () => Promise<Uint8Array>;
  /** Opens a different document. Only meaningful alongside `library`. */
  readonly onOpenDocument?: (name: string) => void;
}

/** The slice of `DocumentSession` the UI needs. Structurally typed, so the view package
 *  does not depend on the autosave implementation's class identity. */
export interface SaveStatusSource {
  readonly filename: string;
  readonly state: SaveState;
  subscribe(listener: (state: SaveState) => void): () => void;
}

export function MindmapApp({
  createDocument,
  onLabelChange,
  onCollapsedChange,
  save,
  library,
  onOpenDocument,
  externalFiles,
  readOpenDocument,
}: MindmapAppProps = {}): React.JSX.Element {
  const doc = useMemo(() => (createDocument ? createDocument() : buildSampleDocument().doc), [createDocument]);
  const [kind, setKind] = useState<LayoutKind>('two-sided');
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT);
  const [showReport, setShowReport] = useState(false);
  const [panel, setPanel] = useState<PanelTab | null>('outline');
  const [searchOpen, setSearchOpen] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [exported, setExported] = useState<string | null>(null);

  const support = useMemo(() => detectMathSupport(), []);

  /**
   * Subscribe to the save session.
   *
   * Kept in the view package so the desktop entry can hand over a `DocumentSession`
   * without re-rendering the app on every autosave tick.
   */
  const [saveState, setSaveState] = useState<SaveState | null>(save?.state ?? null);
  useEffect(() => {
    if (!save) return undefined;
    setSaveState(save.state);
    return save.subscribe(setSaveState);
  }, [save]);

  const scene = useScene({ doc, kind, revision });
  const bounds = useSceneBounds(scene);
  const selection = useSelection();
  const commands = useNodeCommands({
    doc,
    kind,
    onChange: useCallback(() => setRevision((value) => value + 1), []),
  });

  const canvasRef = useRef<HTMLDivElement | null>(null);

  /**
   * The canvas's real pixel size.
   *
   * This was previously the constant 1200x800, which was right only while the canvas
   * happened to fill the window. Open the side panel and the canvas narrows to ~950px:
   * the fit was still computed for 1200, so the scene overflowed and nodes ended up
   * underneath the panel, where they could be seen but not clicked.
   */
  const [size, setSize] = useState<{ readonly width: number; readonly height: number }>({
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const measure = (): void => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width > 0 && height > 0) setSize({ width, height });
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

// Fit the map once it has been laid out, so the student opens onto their notes rather
  // than onto empty space. Re-fits when the canvas is resized, because the old fit was
  // computed for a different size and would leave content off-screen.
  const fittedFor = useRef('');
  const refit = useCallback(() => {
    if (bounds.width === 0 || size.width === 0) return;

    setViewport(
      fitToContent({
        minX: bounds.minX,
        minY: bounds.minY,
        contentWidth: bounds.width,
        contentHeight: bounds.height,
        viewportWidth: size.width,
        viewportHeight: size.height,
      }),
    );
  }, [bounds.minX, bounds.minY, bounds.width, bounds.height, size.width, size.height]);

  useEffect(() => {
    // `refit` already refuses to run before the scene has been measured, so this only
    // needs the once-per-size guard. Depending on `refit` alone is deliberate: it
    // changes identity whenever the bounds or the canvas size change, which is exactly
    // when a re-fit is needed, and listing those again would be the same signal twice.
    const key = `${Math.round(size.width)}x${Math.round(size.height)}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;

    refit();
  }, [refit, size.height, size.width]);

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

  const commitNotes = useCallback(
    (id: NodeId, notes: BlockDoc) => {
      setNotes(doc, id, notes);
      setRevision((value) => value + 1);
    },
    [doc],
  );

  /**
   * Export the document as Markdown.
   *
   * Maths is exported as LaTeX rather than drawn, so the file opens in Obsidian or a
   * text editor and stays searchable. Notes bodies are included: a mindmap whose export
   * drops the prose is an image of the student's thinking rather than a copy of it.
   */
  const exportMarkdown = useCallback(() => {
    const title = getMeta(doc).title;
    const markdown = toMarkdown(doc, { includeTitle: true, includeNotes: true });
    const filename = toFilename(title);

    const result = downloadText(filename, markdown, 'text/markdown');
    setExported(result.ok ? `Exported ${filename}` : (result.error ?? 'Export failed'));
  }, [doc]);

  // Ctrl/Cmd+K opens search from anywhere in the window, including from inside the
  // notes editor, because a student looking for a formula should not have to close
  // what they are writing first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

      // Zoom and fit, before the "a node must be selected" guard: these act on the
      // whole canvas, so they must work when nothing is selected.
      //
      // `+` and `=` rather than the numpad alone, because that is what the key
      // physically produces without the numlock state, and a zoom that only works on
      // one of two keys on the same keyboard reads as broken.
      if (event.key === '+' || event.key === '=') {
        setViewport((v) => zoomAt(v, { factor: ZOOM_STEP }));
        event.preventDefault();
        return;
      }
      if (event.key === '-' || event.key === '_') {
        setViewport((v) => zoomAt(v, { factor: 1 / ZOOM_STEP }));
        event.preventDefault();
        return;
      }
      // Plain `0` rather than Ctrl+0. Ctrl+0 is the browser's "reset zoom" shortcut, and
      // stealing it would be both surprising in a webview and, in practice, swallowed
      // before the page ever saw it — so the shortcut that is documented is the one
      // that does not arrive. Nothing else in the keyboard model uses `0`.
      if (event.key === '0') {
        refit();
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

        default:
          return;
      }
    },
    [commands, doc, refit, selection, toggleCollapsed],
  );

  /**
   * Ctrl/Cmd+Enter opens the label editor on the selected node.
   *
   * Kept out of the `switch` because the key is a modifier combination, and a bare
   * `event.key` can never distinguish it from a plain Enter. It used to be written as
   * `case 'Enter+':`, which is unreachable: that string is not a key.
   */
  const handleModKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      // The modifier is required. Without this check a plain Enter opens the editor
      // instead of adding a sibling, which silently breaks the primary keyboard model.
      if (event.key !== 'Enter') return;
      if (!event.ctrlKey && !event.metaKey) return;

      if (!selection.editingId && selection.selectedId) {
        selection.beginEditing(selection.selectedId);
        event.preventDefault();
      }
    },
    [selection],
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

        {save ? (
          <span
            className={`adnota-save-status is-${describeSave(saveState)}`}
            data-testid="save-status"
            role="status"
            aria-live="polite"
          >
            {save.filename} · {describeSave(saveState)}
          </span>
        ) : null}

        {library ? (
          <button
            type="button"
            onClick={() => setDocumentsOpen(true)}
            data-testid="open-documents"
          >
            Documents
          </button>
        ) : null}


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

        <div className="adnota-layouts" role="group" aria-label="Zoom">
          <button
            type="button"
            onClick={() => setViewport((v) => zoomAt(v, { factor: 1 / ZOOM_STEP }))}
            aria-label="Zoom out"
            data-testid="zoom-out"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => setViewport((v) => zoomAt(v, { factor: ZOOM_STEP }))}
            aria-label="Zoom in"
            data-testid="zoom-in"
          >
            +
          </button>
          <button
            type="button"
            onClick={refit}
            aria-label="Fit to window"
            data-testid="zoom-fit"
          >
            Fit
          </button>
        </div>

        <div className="adnota-layouts" role="group" aria-label="View">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            data-testid="open-search"
          >
            Search <kbd>Ctrl K</kbd>
          </button>
          <button
            type="button"
            className={panel === 'outline' ? 'is-active' : ''}
            aria-pressed={panel === 'outline'}
            onClick={() => setPanel((value) => (value === 'outline' ? null : 'outline'))}
            data-testid="toggle-outline"
          >
            Outline
          </button>
          <button
            type="button"
            className={panel === 'notes' ? 'is-active' : ''}
            aria-pressed={panel === 'notes'}
            onClick={() => setPanel((value) => (value === 'notes' ? null : 'notes'))}
            data-testid="toggle-notes"
          >
            Notes
          </button>
          <button type="button" onClick={exportMarkdown} data-testid="export-markdown">
            Export .md
          </button>
        </div>
      </header>

      <div className="adnota-workspace">
        <main
          className="adnota-canvas"
          data-testid="canvas"
          ref={canvasRef}
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onKeyDownCapture={handleModKeyDown}
          onClick={() => selection.setSelected(null)}
        >
        <SceneView
          scene={scene}
          kind={kind}
          viewport={viewport}
          width={size.width}
          height={size.height}
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

        {panel !== null ? (
          <aside className="adnota-panel" data-testid="side-panel" aria-label="Document">
            {panel === 'outline' ? (
              <OutlinePanel
                doc={doc}
                revision={revision}
                selectedId={selection.selectedId}
                onSelect={selectAndFocus}
                onToggleCollapse={toggleCollapsed}
              />
            ) : (
              <NotesPanel
                // Remounting per node is what keeps the notes editor's initial content
                // from being re-read on every keystroke; see NotesPanel for why.
                key={selection.selectedId ?? 'no-selection'}
                nodeId={selection.selectedId}
                notes={selection.selectedId ? getNode(doc, selection.selectedId)?.notes ?? null : null}
                onChange={commitNotes}
                onExit={() => canvasRef.current?.focus()}
              />
            )}
          </aside>
        ) : null}
      </div>

      {searchOpen ? (
        <SearchPalette
          doc={doc}
          revision={revision}
          onChoose={(id) => {
            selectAndFocus(id);
            setPanel('outline');
          }}
          onDismiss={() => setSearchOpen(false)}
        />
      ) : null}

      {documentsOpen && library ? (
        <DocumentsPanel
          library={library}
          current={save?.filename ?? null}
          onOpen={(name) => {
            setDocumentsOpen(false);
            onOpenDocument?.(name);
          }}
          onClose={() => setDocumentsOpen(false)}
          // Spread rather than passed as `undefined`: the project uses
          // `exactOptionalPropertyTypes`, so an explicit `undefined` is not the same as
          // an absent key.
          {...(externalFiles ? { external: externalFiles, readOpenDocument } : {})}
        />
      ) : null}


      {exported ? (
        <p className="adnota-toast" role="status" data-testid="export-status">
          {exported}
        </p>
      ) : null}

      {showReport ? <MathSupportReport support={support} /> : null}
    </div>
  );
}

/** Used only to keep the disabled-guard total; a null selection never reaches it. */
const ROOT_FALLBACK = 'root';

/**
 * Human wording for the save state.
 *
 * "Unsaved" is shown rather than "Saving…" for the dirty case, because the debounce
 * means a document is dirty far more often than it is actively being written, and a
 * spinner that flickers on every keystroke would imply work that is not happening.
 */
function describeSave(state: SaveState | null): string {
  if (!state) return 'saved';
  if (state.lastError) return 'save failed';
  if (state.saving) return 'saving…';
  if (state.dirty) return 'unsaved';
  return 'saved';
}

/** Exported so tests can assert the canvas dimensions the app renders at. */
export const CANVAS_SIZE = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT } as const;
