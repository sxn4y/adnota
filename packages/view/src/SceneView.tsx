/**
 * The canvas.
 *
 * Renders the SVG scene and nothing else. Interaction is expressed through props so
 * the same component serves the harness, the desktop app, and the visual tests.
 */

import { useCallback, useRef } from 'react';
import type { NodeId } from '@adnota/core';
import {
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  buildBranch,
  labelToPlainText,
  renderLabelHtml,
  stripWrapper,
} from '@adnota/scene';
import { LABEL_FONT_SIZE, PADDING_X, PADDING_Y, measureNode, type SceneState } from './scene.ts';
import { nodeAppearance } from '@adnota/scene';
import { panBy, zoomAt, type Viewport } from './viewport.ts';

const BRANCH_COLOR = '#9aa4b0';
const NODE_STROKE_SELECTED = '#3b6ef6';
const BRANCH_STROKE_SELECTED = '#3b6ef6';

/**
 * Thickness of the rule drawn under a node whose shape is `underline`.
 *
 * Sits at the bottom edge of the measured text box rather than the node box, so it reads
 * as an underline of the label rather than a border around the node.
 */
const UNDERLINE_INSET = 3;

export interface SceneViewProps {
  readonly scene: SceneState;
  readonly kind: 'radial' | 'two-sided' | 'left';
  readonly viewport: Viewport;
  readonly width: number;
  readonly height: number;
  readonly selectedId: NodeId | null;
  readonly editingId: NodeId | null;
  readonly onSelect: (id: NodeId) => void;
  readonly onEdit: (id: NodeId) => void;
  readonly onViewportChange: (viewport: Viewport) => void;
}

export function SceneView({
  scene,
  kind,
  viewport,
  width,
  height,
  selectedId,
  editingId,
  onSelect,
  onEdit,
  onViewportChange,
}: SceneViewProps): React.JSX.Element {
  // A drag must not be mistaken for a click, so panning records where it started and
  // the click handler checks the distance travelled.
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const panOrigin = useRef<Viewport | null>(null);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      // Only a middle button or the background starts a pan. A primary drag on a node
      // is reserved for node dragging, which is not implemented yet, so it is ignored
      // rather than silently panning the map under the student.
      const isPanGesture =
        event.button === 1 || (event.button === 0 && event.target === event.currentTarget);

      if (!isPanGesture) return;

      dragStart.current = { x: event.clientX, y: event.clientY };
      panOrigin.current = viewport;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [viewport],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const start = dragStart.current;
      const origin = panOrigin.current;
      if (!start || !origin) return;

      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      onViewportChange(panBy(origin, dx, dy));
    },
    [onViewportChange],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (dragStart.current) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      dragStart.current = null;
      panOrigin.current = null;
    },
    [],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<SVGSVGElement>) => {
      // Without this the page scrolls instead of the canvas zooming, which on a
      // desktop app is the difference between usable and maddening.
      event.preventDefault();

      const rect = event.currentTarget.getBoundingClientRect();
      const anchorX = event.clientX - rect.left;
      const anchorY = event.clientY - rect.top;

      // Trackpad pinch arrives as ctrlKey+wheel, and it must still respond to the
      // *direction* of the gesture. A fixed factor here ignored deltaY entirely, which
      // made pinch zoom one-way: you could magnify but never shrink. On a laptop
      // trackpad pinch is the gesture people reach for first, so that read as "zooming
      // is broken".
      //
      // The pinch step is finer because a pinch produces much smaller deltas per gesture
      // than a wheel notch.
      const sensitivity = event.ctrlKey ? 0.01 : 0.0015;
      const factor = Math.exp(-event.deltaY * sensitivity);

      // `zoomAt` takes a *multiplier* and clamps the resulting scale itself. Passing a
      // pre-multiplied value here made the scale compound with itself: zooming out
      // crawled towards the limit while zooming in shot away from it.
      onViewportChange(zoomAt(viewport, { factor, anchorX, anchorY }));
    },
    [onViewportChange, viewport],
  );

  const branches = scene.laid.flatMap((entry) => {
    const parent = entry.node.parentId ? scene.byId.get(entry.node.parentId) : undefined;
    if (!parent) return [];
    const d = buildBranch(parent, entry, kind === 'radial' ? 'radial' : 'linear');
    if (!d) return [];

    const selected = selectedId !== null && (entry.id === selectedId || parent.id === selectedId);
    return [{ key: `${parent.id}->${entry.id}`, d, selected }];
  });

  return (
    <svg
      width={width}
      height={height}
      className="adnota-scene"
      role="group"
      aria-label="Mindmap"
      data-testid="scene"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
    >
      <g
        transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}
        data-testid="scene-content"
      >
        <g className="adnota-branches" data-testid="branches">
          {branches.map((branch) => (
            <path
              key={branch.key}
              d={branch.d}
              fill="none"
              stroke={branch.selected ? BRANCH_STROKE_SELECTED : BRANCH_COLOR}
              strokeWidth={branch.selected ? 2.5 : 2}
              strokeLinecap="round"
            />
          ))}
        </g>

        <g className="adnota-nodes" data-testid="nodes">
          {scene.laid.map((entry) => {
            const size = measureNode(entry.node);
            const width = Math.max(MIN_NODE_WIDTH, size.width);
            const height = Math.max(MIN_NODE_HEIGHT, size.height);
            const selected = entry.id === selectedId;
            const editing = entry.id === editingId;

            // Shape and colour come from the document, so they survive a reload, an export
            // and a merge. An unrecognised shape or slot falls back rather than drawing
            // nothing.
            const look = nodeAppearance(entry.node.shape, entry.node.color, width, height);
            const halfW = width / 2;
            const halfH = height / 2;

            return (
              <g
                key={entry.id}
                transform={`translate(${entry.x} ${entry.y})`}
                data-node-id={entry.id}
                data-depth={entry.depth}
                data-shape={entry.node.shape}
                data-color={entry.node.color}
                data-selected={selected || undefined}
                className={editing ? 'adnota-node is-editing' : 'adnota-node'}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(entry.id);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  onEdit(entry.id);
                }}
              >
                {look.boxed ? (
                  <rect
                    x={-halfW}
                    y={-halfH}
                    width={width}
                    height={height}
                    // The root is a pill by default, which is what distinguishes it at a
                    // glance in a large map; everything else defaults to a box.
                    rx={look.radius}
                    fill={look.fill}
                    stroke={selected ? NODE_STROKE_SELECTED : look.stroke}
                    strokeWidth={selected ? 2 : 1.5}
                  />
                ) : null}

                {look.underlined ? (
                  <line
                    x1={-halfW + PADDING_X}
                    y1={halfH - UNDERLINE_INSET}
                    x2={halfW - PADDING_X}
                    y2={halfH - UNDERLINE_INSET}
                    stroke={selected ? NODE_STROKE_SELECTED : look.stroke}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  />
                ) : null}

                <foreignObject
                  x={-halfW + PADDING_X}
                  y={-halfH + PADDING_Y}
                  width={width - PADDING_X * 2}
                  height={height - PADDING_Y * 2}
                >
                  <div
                    className="adnota-node-label"
                    dangerouslySetInnerHTML={{
                      __html: stripWrapper(renderLabelHtml(entry.node.label, LABEL_FONT_SIZE)),
                    }}
                    title={labelToPlainText(entry.node.label)}
                  />
                </foreignObject>
              </g>
            );
          })}
        </g>
      </g>
    </svg>
  );
}

