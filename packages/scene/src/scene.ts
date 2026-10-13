/**
 * Scene rendering.
 *
 * The scene is one SVG element containing nodes, branches, ink and images. Text and
 * math are the awkward part: SVG has no text layout, and MathML is not permitted in
 * bare SVG (see `math.ts` for the measurement that settled this). So label content is
 * rendered as XHTML inside a `foreignObject` sized to the node's box.
 *
 * `foreignObject` has two well-known failure modes worth guarding against:
 *
 *   1. A `foreignObject` with `width` or `height` of zero disappears entirely.
 *      Node sizes therefore always carry a floor.
 *   2. The XHTML content needs the XHTML namespace declared or browsers silently drop
 *      the subtree.
 */

import { linkHorizontal } from 'd3-shape';
import type { AdnotaNode, InlineDoc, InlineNode, NodeId } from '@adnota/core';
import { renderMath, escapeHtml, latexToSpeech } from './math.ts';
import type { LaidOutNode, NodeSize } from './layout.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

export const MIN_NODE_WIDTH = 56;
export const MIN_NODE_HEIGHT = 28;

/** Geometry of a node's drawn box, given its centre. */
export interface NodeBox extends NodeSize {
  readonly left: number;
  readonly top: number;
}

/**
 * Resolve a node's box from its laid-out centre.
 *
 * Widths and heights are floored: a `foreignObject` sized to zero is invisible, which
 * would make a freshly created empty node impossible to click.
 */
export function nodeBox(centreX: number, centreY: number, size: NodeSize): NodeBox {
  const width = Math.max(MIN_NODE_WIDTH, size.width);
  const height = Math.max(MIN_NODE_HEIGHT, size.height);
  return {
    width,
    height,
    left: centreX - width / 2,
    top: centreY - height / 2,
  };
}

/**
 * Render a node's inline label as XHTML.
 *
 * Math becomes KaTeX markup; plain text is escaped. The result is a document fragment
 * intended for a `foreignObject`, which is why it carries the XHTML namespace.
 */
export function renderLabelHtml(doc: InlineDoc, fontSize: number): string {
  const parts = doc.content.map((node) => renderInline(node, fontSize));
  return `<div xmlns="${XHTML_NS}" class="adnota-label" style="font-size:${fontSize}px">${parts.join('')}</div>`;
}

function renderInline(node: InlineNode, fontSize: number): string {
  switch (node.type) {
    case 'text':
      return renderTextWithMarks(node.text, node.marks);

    case 'math_inline': {
      const { html } = renderMath(node.latex, { display: 'inline' });
      // aria-label carries the LaTeX in readable form: the glyphs are pixels, so
      // without this the equation is invisible to a screen reader.
      return `<span class="adnota-math" role="math" aria-label="${escapeHtml(latexToSpeech(node.latex))}" style="font-size:${fontSize}px">${html}</span>`;
    }

    case 'image':
      return `<span class="adnota-label-image" role="img" aria-label="${escapeHtml(node.alt ?? 'image')}">[image]</span>`;
  }
}

function renderTextWithMarks(
  text: string,
  marks: readonly { readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> }[] | undefined,
): string {
  let html = escapeHtml(text);

  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'strong':
        html = `<strong>${html}</strong>`;
        break;
      case 'em':
        html = `<em>${html}</em>`;
        break;
      case 'code':
        html = `<code>${html}</code>`;
        break;
      case 'strike':
        html = `<s>${html}</s>`;
        break;
      default:
        // Unknown marks are preserved as their text rather than dropped, so a document
        // authored with a newer mark set still reads sensibly here.
        break;
    }
  }

  return html;
}

/** Plain text of a label, used for search indexing and accessibility fallbacks. */
export function labelToPlainText(doc: InlineDoc): string {
  return doc.content
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'math_inline':
          return ` ${node.latex} `;
        case 'image':
          return ` ${node.alt ?? 'image'} `;
      }
    })
    .join('');
}

/**
 * Build the branch path between a parent and a child.
 *
 * Two-sided layouts use a bump curve, which is the familiar mindmap gesture: it
 * leaves the parent perpendicular to the branch and arrives at the child
 * perpendicular to it, so branches read as leaves on a stem rather than loose wires.
 * d3's `linkHorizontal` is already the bump curve in v3 and takes no curve argument.
 *
 * The radial arc is computed directly rather than via `linkRadial`, whose accessors
 * are easy to misuse into producing `NaN` paths, and because the radial layout has
 * already resolved polar to Cartesian by this point. The arc bulges outward along the
 * radius, which keeps a branch visually inside the sector it belongs to.
 */
export function buildBranch(parent: LaidOutNode, child: LaidOutNode, kind: 'radial' | 'linear'): string {
  if (kind === 'radial') return radialArc(parent, child);
  return linkHorizontal()({ source: [parent.x, parent.y], target: [child.x, child.y] }) ?? '';
}

function radialArc(parent: LaidOutNode, child: LaidOutNode): string {
  const midX = (parent.x + child.x) / 2;
  const midY = (parent.y + child.y) / 2;

  const length = Math.hypot(midX, midY);
  // The midpoint can be the origin when a branch doubles back; without this guard the
  // normalised direction is NaN and the whole path collapses.
  if (length < 1e-6) return `M${parent.x},${parent.y}L${child.x},${child.y}`;

  const bulge = length * 0.18;
  const controlX = midX + (midX / length) * bulge;
  const controlY = midY + (midY / length) * bulge;

  return `M${parent.x},${parent.y}Q${controlX},${controlY} ${child.x},${child.y}`;
}

export function branchAttributes(color: string, width: number): string {
  return `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"`;
}

/**
 * Serialise the scene to a standalone SVG string.
 *
 * Used by the SVG export path and by the visual regression tests. Note that math
 * inside a `foreignObject` does not survive rasterisation by third-party SVG
 * renderers, which is a known limitation rather than a bug in the scene graph.
 */
export function serializeScene(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('xmlns:xhtml', XHTML_NS);
  return new XMLSerializer().serializeToString(clone);
}

/** Resolve a node id to its laid-out entry. */
export function findLaidOut(
  laid: readonly LaidOutNode[],
  id: NodeId,
): LaidOutNode | undefined {
  return laid.find((entry) => entry.id === id);
}

/** The immediate children of a laid-out node, in document order. */
export function laidOutChildren(
  laid: readonly LaidOutNode[],
  node: AdnotaNode,
  childrenOf: (id: NodeId) => AdnotaNode[],
): LaidOutNode[] {
  const ids = new Set(childrenOf(node.id).map((child) => child.id));
  return laid.filter((entry) => ids.has(entry.id));
}
