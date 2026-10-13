/**
 * Scene rendering components.
 *
 * These are real application components rather than harness scaffolding: the desktop
 * shell imports exactly these. The harness and the app differ only in where the
 * `Y.Doc` comes from and which `BinaryStorage` backs it.
 */

import { useMemo } from 'react';
import type { YDoc } from 'yjs';
import {
  ROOT_NODE_ID,
  getChildren,
  getNode,
  type AdnotaNode,
  type NodeId,
} from '@adnota/core';
import {
  buildBranch,
  labelToPlainText,
  layoutTree,
  measureLabel,
  nodeBox,
  renderLabelHtml,
  resolveVisualRoot,
  type LaidOutNode,
  type LayoutKind,
  type NodeSize,
} from '@adnota/scene';

const LABEL_FONT_SIZE = 15;
const LABEL_MAX_WIDTH = 260;
const PADDING_X = 18;
const PADDING_Y = 10;

const BRANCH_COLOR = '#9aa4b2';
const NODE_FILL = '#ffffff';
const NODE_STROKE = '#d5dae1';

export interface SceneViewProps {
  readonly doc: YDoc;
  readonly kind: LayoutKind;
  readonly width: number;
  readonly height: number;
  /** Drawn behind the nodes so branches never cover text. */
  readonly renderInk?: boolean;
}

/** Size of a node, measured from its rendered label. */
function sizeOf(node: AdnotaNode): NodeSize {
  const metrics = measureLabel(node.label, LABEL_FONT_SIZE, LABEL_MAX_WIDTH);
  return {
    width: metrics.width + PADDING_X * 2,
    height: metrics.height + PADDING_Y * 2,
  };
}

export function SceneView({ doc, kind, width, height }: SceneViewProps): React.JSX.Element {
  const laid = useMemo(() => {
    const structuralRoot = getNode(doc, ROOT_NODE_ID);
    if (!structuralRoot) return [];

    const childrenOf = (id: NodeId) => getChildren(doc, id);
    // The document's structural root is an invisible anchor; laying out from it would
    // draw an empty box in the middle of the canvas.
    const root = resolveVisualRoot(structuralRoot, childrenOf);

    return layoutTree(root, childrenOf, sizeOf, {
      kind,
      nodeSeparation: 120,
      siblingSeparation: 16,
    });
  }, [doc, kind]);

  const byId = useMemo(() => {
    const map = new Map<NodeId, LaidOutNode>();
    for (const entry of laid) map.set(entry.id, entry);
    return map;
  }, [laid]);

  const branches = useMemo(
    () => buildBranches(laid, byId, kind),
    [laid, byId, kind],
  );

  return (
    <svg
      width={width}
      height={height}
      viewBox={viewBoxFor(laid, width, height)}
      className="adnota-scene"
      role="group"
      aria-label="Mindmap"
      data-testid="scene"
    >
      <g className="adnota-branches" data-testid="branches">
        {branches.map((branch) => (
          <path
            key={branch.key}
            d={branch.d}
            fill="none"
            stroke={BRANCH_COLOR}
            strokeWidth={2}
            strokeLinecap="round"
          />
        ))}
      </g>

      <g className="adnota-nodes" data-testid="nodes">
        {laid.map((entry) => {
          const box = nodeBox(entry.x, entry.y, sizeOf(entry.node));
          return (
            <g key={entry.id} transform={`translate(${entry.x} ${entry.y})`} data-node-id={entry.id}>
              <rect
                x={-box.width / 2}
                y={-box.height / 2}
                width={box.width}
                height={box.height}
                rx={entry.depth === 0 ? 12 : 8}
                fill={NODE_FILL}
                stroke={NODE_STROKE}
                strokeWidth={1.5}
              />
              {/* The XHTML content needs the namespace declared, or browsers drop it. */}
              <foreignObject
                x={-box.width / 2 + PADDING_X}
                y={-box.height / 2 + PADDING_Y}
                width={box.width - PADDING_X * 2}
                height={box.height - PADDING_Y * 2}
              >
                <div
                  className="adnota-node-label"
                  // The label is rendered to markup by the scene package so that the
                  // same function serves the harness, the app, and export.
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
    </svg>
  );
}

/**
 * `renderLabelHtml` returns a single XHTML element carrying the namespace, which is
 * what a `foreignObject` requires. When injected with `innerHTML` into an existing
 * XHTML subtree the namespace declaration is redundant, so it is unwrapped here.
 */
function stripWrapper(html: string): string {
  return html.replace(/^<div xmlns="[^"]*"/, '<div').replace(/^<div(?=[\s>])/, '<div');
}

interface Branch {
  readonly key: string;
  readonly d: string;
}

function buildBranches(
  laid: readonly LaidOutNode[],
  byId: ReadonlyMap<NodeId, LaidOutNode>,
  kind: LayoutKind,
): Branch[] {
  const out: Branch[] = [];
  for (const entry of laid) {
    const parent = entry.node.parentId ? byId.get(entry.node.parentId) : undefined;
    if (!parent) continue;
    const d = buildBranch(parent, entry, kind === 'radial' ? 'radial' : 'linear');
    if (d) out.push({ key: `${parent.id}->${entry.id}`, d });
  }
  return out;
}

/** Fit the laid-out content into the viewport with a margin. */
function viewBoxFor(
  laid: readonly LaidOutNode[],
  width: number,
  height: number,
): string {
  if (laid.length === 0) return `0 0 ${width} ${height}`;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const entry of laid) {
    const size = sizeOf(entry.node);
    minX = Math.min(minX, entry.x - size.width / 2);
    maxX = Math.max(maxX, entry.x + size.width / 2);
    minY = Math.min(minY, entry.y - size.height / 2);
    maxY = Math.max(maxY, entry.y + size.height / 2);
  }

  const margin = 40;
  return `${minX - margin} ${minY - margin} ${maxX - minX + margin * 2} ${maxY - minY + margin * 2}`;
}
