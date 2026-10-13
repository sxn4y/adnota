/**
 * Mindmap layout.
 *
 * Hand-rolled rather than delegated wholesale to d3-hierarchy, because the thing that
 * makes a mindmap a mindmap is not the tree algorithm, it is the two-sided placement:
 * branches alternating left and right from a central root. d3 has no opinion about
 * that, and every mindmap library that does charge for it or forces its own document
 * shape. Owning the layout also means it can respect author-pinned nodes and node
 * sizes that depend on rendered math, neither of which a generic tree layout knows
 * about.
 *
 * All three layouts share one slot-assignment pass, which walks the tree once and
 * gives every node a vertical position sized by its rendered height. The layouts then
 * differ only in how a slot becomes coordinates.
 */

import { ROOT_NODE_ID, type AdnotaNode, type NodeId } from '@adnota/core';

export type LayoutKind = 'radial' | 'two-sided' | 'left';

export interface LayoutOptions {
  readonly kind: LayoutKind;
  /** Distance from a node to its first child. */
  readonly nodeSeparation: number;
  /** Vertical gap between adjacent siblings. */
  readonly siblingSeparation: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
  kind: 'two-sided',
  nodeSeparation: 120,
  siblingSeparation: 16,
};

export type Side = -1 | 0 | 1;

/**
 * The node the map should be laid out around.
 *
 * Every Adnota document has a structural root that exists only to give the top-level
 * nodes a parent; it has no label and the user never sees it. Laying out from it would
 * put an empty box in the middle of the canvas and push the real subject one branch
 * out to one side.
 *
 * So when the structural root has exactly one child, that child becomes the visual
 * root. With several children the structural root stays the centre, which is correct:
 * those children are genuinely siblings at the top level and deserve to fan out.
 */
export function resolveVisualRoot(
  root: AdnotaNode,
  childrenOf: (id: NodeId) => AdnotaNode[],
): AdnotaNode {
  // Identified by id, not by having a null parent: the structural root's parent is
  // the sentinel `ROOT_NODE_ID`, so a null check would silently never match.
  if (root.id !== ROOT_NODE_ID) return root;
  if (!labelIsEmpty(root)) return root;

  const children = childrenOf(root.id);
  if (children.length === 1) {
    const only = children[0];
    if (only) return only;
  }

  return root;
}

/** True when a node carries no visible label, i.e. it is a structural placeholder. */
export function labelIsEmpty(node: AdnotaNode): boolean {
  return node.label.content.length === 0;
}

export interface LaidOutNode {
  readonly id: NodeId;
  readonly node: AdnotaNode;
  readonly x: number;
  readonly y: number;
  readonly depth: number;
  readonly side: Side;
}

export interface NodeSize {
  readonly width: number;
  readonly height: number;
}

/** Smallest gap kept between two node boxes, in pixels. */
export const MIN_NODE_GAP = 24;

/**
 * Compute positions for the visible tree.
 *
 * @param root       the node to lay out around, normally from `resolveVisualRoot`
 * @param childrenOf immediate children of a node, already filtered for visibility
 * @param sizeOf     rendered size of a node; measured upstream because it depends on
 *                   the label, including any math inside it
 */
export function layoutTree(
  root: AdnotaNode,
  childrenOf: (id: NodeId) => AdnotaNode[],
  sizeOf: (node: AdnotaNode) => NodeSize,
  options: LayoutOptions = DEFAULT_LAYOUT,
): LaidOutNode[] {
  const { slots, widest } = assignSlots(root, childrenOf, sizeOf, options);
  return options.kind === 'radial'
    ? toRadial(slots, options, widest)
    : toLinear(slots, options, widest);
}

/**
 * The separation actually used between depth columns.
 *
 * The configured value is a preference, not a guarantee: if the widest node is
 * broader than the requested separation, adjacent depths would overlap horizontally
 * wherever their vertical ranges met. Layout therefore widens the column spacing to
 * fit the content rather than emitting an overlapping map.
 */
function effectiveSeparation(options: LayoutOptions, widest: number): number {
  const needed = widest + MIN_NODE_GAP;
  return Math.max(options.nodeSeparation, needed);
}

/** An entry after slot assignment but before a layout turns it into coordinates. */
interface Slot {
  readonly id: NodeId;
  readonly node: AdnotaNode;
  readonly parentId: NodeId | null;
  readonly depth: number;
  readonly side: Side;
  /** Centre of the node's vertical run, in the units accumulated for its side. */
  offset: number;
  readonly height: number;
  /** Ids of this node's visible children, in document order. */
  readonly children: readonly NodeId[];
}

// ---------------------------------------------------------------------------
// Slot assignment
// ---------------------------------------------------------------------------

/**
 * Give every node a vertical offset per side.
 *
 * A node's centre is placed at the midpoint of the run its children occupy, and a
 * node taller than its children's run takes precedence so that it does not collide
 * with its siblings. Stacking children after the parent instead would let a tall
 * child rise above the parent and overlap the preceding sibling, which is the
 * subtlest way to get a tree layout wrong.
 *
 * Each side keeps its own extent and is then centred on the root, because in a
 * two-sided map the left and right branches descend independently. Balancing them
 * against each other would drift the whole map as branches are added to one side.
 */
function assignSlots(
  root: AdnotaNode,
  childrenOf: (id: NodeId) => AdnotaNode[],
  sizeOf: (node: AdnotaNode) => NodeSize,
  options: LayoutOptions,
): { slots: Slot[]; widest: number } {
  const gap = options.siblingSeparation;

  const flat: Slot[] = [];

  /**
   * Per-node measurements, indexed in step with `flat`.
   *
   * Kept in a parallel array rather than a nested tree on purpose. Nested relative
   * coordinates are where this algorithm goes wrong: a child's centre is measured
   * from its parent's span, and its own children are measured from *its* span, so
   * carrying both origin and offset through a nested structure means recomputing the
   * origin at every level. Two flat passes make each level independent.
   */
  interface Measurement {
    readonly index: number;
    readonly height: number;
    /** Indices of this node's visible children. */
    readonly children: readonly number[];
    /** Each child's span top, relative to this node's own span top. */
    childTops: number[];
    /** Total vertical extent of this node's subtree. */
    span: number;
  }

  const measured: Measurement[] = [];
  let widest = 0;

  // Pass one, post-order: how much room does each subtree need?
  const build = (node: AdnotaNode, depth: number, side: Side): number => {
    const size = sizeOf(node);
    widest = Math.max(widest, size.width);

    const index = flat.length;
    const placeholder: Slot = {
      id: node.id,
      node,
      parentId: null,
      depth,
      side,
      offset: 0,
      height: size.height,
      children: [],
    };
    flat.push(placeholder);

    const visible = node.collapsed ? [] : childrenOf(node.id);
    const children = visible.map((child, position) => {
      // Alternating sides is the defining gesture of a two-sided mindmap. The first
      // child goes right so a linear chain reads left-to-right the way the eye expects.
      // Below the first level a branch keeps its parent's side, otherwise a subtree
      // would zigzag back and forth across the root.
      const childSide: Side =
        options.kind === 'left'
          ? 1
          : depth === 0
            ? position % 2 === 0
              ? 1
              : -1
            : side;
      return build(child, depth + 1, childSide);
    });

    // Filled in now that the children exist. The radial layout walks the tree by
    // child id rather than by index, so it needs this recorded.
    flat[index] = {
      ...placeholder,
      children: children.map((childIndex) => flat[childIndex]!.id),
    };

    const record: Measurement = {
      index,
      height: size.height,
      children,
      childTops: [],
      span: size.height,
    };
    measured[index] = record;

    if (children.length > 0) {
      // Stack the children's spans into a block, then centre that block in this
      // node's span.
      //
      // Centring on the block extent rather than on the mean of the children's
      // centres matters: with children of uneven height those differ, and the
      // mean-of-centres version can push the tallest edge child past the end of its
      // allotted span and into a neighbouring sibling. Centring the block guarantees
      // every child stays inside.
      const tops: number[] = [];
      let cursor = 0;
      for (const childIndex of children) {
        tops.push(cursor);
        cursor += measured[childIndex]!.span + gap;
      }
      const childrenSpan = cursor - gap;

      // A node taller than its children's block must win, or it would overlap
      // whichever sibling sits above it.
      record.span = Math.max(record.height, childrenSpan);

      const blockShift = (record.span - childrenSpan) / 2;
      record.childTops = tops.map((top) => top + blockShift);
    }

    return index;
  };

  const rootIndex = build(root, 0, 0);

  // Pass two, pre-order: turn relative spans into absolute positions.
  const assign = (index: number, spanTop: number): void => {
    const record = measured[index];
    const slot = flat[index];
    if (!record || !slot) return;

    // A node sits at the centre of its own span, which is also the centre of its
    // children block once the block has been centred within it.
    slot.offset = spanTop + record.span / 2;

    record.children.forEach((childIndex, i) => {
      assign(childIndex, spanTop + (record.childTops[i] ?? 0));
    });
  };

  assign(rootIndex, 0);

  // Normalise so the root sits exactly at the origin. Everything above measured
  // centres from a span's top edge, which would otherwise leave the root sitting half
  // its own height below the axis.
  const rootSlot = flat[rootIndex];
  const originShift = rootSlot ? -rootSlot.offset : 0;
  if (originShift !== 0) {
    for (const slot of flat) slot.offset += originShift;
  }

  // Each side is centred on the root independently. Balancing the two sides against
  // each other instead would drift the map as branches are added to one side only.
  for (const key of [-1, 1] as const) {
    const onSide = flat.filter((slot) => slot.side === key);
    if (onSide.length === 0) continue;

    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (const slot of onSide) {
      lowest = Math.min(lowest, slot.offset - slot.height / 2);
      highest = Math.max(highest, slot.offset + slot.height / 2);
    }

    const shift = -(lowest + highest) / 2;
    for (const slot of onSide) slot.offset += shift;
  }

  return { slots: flat, widest };
}
// ---------------------------------------------------------------------------
// Linear layouts: two-sided and left
// ---------------------------------------------------------------------------

/**
 * Linear layouts: two-sided and left.
 *
 * The side is applied to the x coordinate, which is what makes the layout two-sided.
 * Without the sign a left branch would sit directly beneath its right-hand
 * counterpart at the same depth, and the two would overlap exactly.
 */
function toLinear(slots: readonly Slot[], options: LayoutOptions, widest: number): LaidOutNode[] {
  const separation = effectiveSeparation(options, widest);
  return slots.map((slot) => ({
    id: slot.id,
    node: slot.node,
    x: slot.side * slot.depth * separation,
    y: slot.offset,
    depth: slot.depth,
    side: slot.side,
  }));
}

// ---------------------------------------------------------------------------
// Radial
// ---------------------------------------------------------------------------

/**
 * Radial layout.
 *
 * The tree is reduced to a list of leaves and each leaf gets an angular sector sized
 * in proportion to how much room its box needs *at its own radius*. Sectors of equal
 * angular width look fine until the boxes get wide, at which point a leaf at a small
 * radius overlaps its neighbour; sizing by `width / radius` is what keeps them apart.
 *
 * If the leaves cannot fit in a full turn even after that, the radial spacing grows
 * instead, because shrinking the sectors would reintroduce the overlap. Radius then
 * follows depth as usual.
 */
function toRadial(slots: readonly Slot[], options: LayoutOptions, widest: number): LaidOutNode[] {
  const root = slots[0];
  if (!root) return [];

  const byId = new Map<NodeId, Slot>(slots.map((slot) => [slot.id, slot]));

  const leaves: Slot[] = [];
  const collectLeaves = (slot: Slot): void => {
    const children = slot.children
      .map((id) => byId.get(id))
      .filter((child): child is Slot => child !== undefined);
    if (children.length === 0) leaves.push(slot);
    else children.forEach(collectLeaves);
  };
  root.children
    .map((id) => byId.get(id))
    .filter((child): child is Slot => child !== undefined)
    .forEach(collectLeaves);

  if (leaves.length === 0) {
    return [{ id: root.id, node: root.node, x: 0, y: 0, depth: 0, side: root.side }];
  }

  const angles = new Map<NodeId, number>();

  /**
   * Angular space a slot needs, given a radial separation.
   *
   * A slot at depth zero sits at the origin, where a fixed angle would describe no
   * arc at all, so it is given a nominal radius instead.
   */
  const requiredAngle = (slot: Slot, separation: number): number => {
    const radius = Math.max(slot.depth * separation, separation * 0.5);
    return (widest + MIN_NODE_GAP) / radius;
  };

  let separation = effectiveSeparation(options, widest);

  // Grow the radius until the whole turn can be divided without overlap. Each
  // iteration strictly reduces the requirement, so this converges quickly.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const total = leaves.reduce((sum, leaf) => sum + requiredAngle(leaf, separation), 0);
    if (total <= Math.PI * 2) break;
    separation *= total / (Math.PI * 2);
  }

  // Distribute the available turn proportionally to what each leaf needs, so leaves
  // with wide labels get more room than narrow ones.
  const weights = leaves.map((leaf) => requiredAngle(leaf, separation));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const fullTurn = Math.PI * 2;

  let cursor = -Math.PI / 2;
  leaves.forEach((leaf, index) => {
    const share = ((weights[index] ?? 0) / totalWeight) * fullTurn;
    angles.set(leaf.id, cursor + share / 2);
    cursor += share;
  });

  // Walk upwards, giving each internal node the circular mean of its children.
  const resolve = (slot: Slot): number => {
    const existing = angles.get(slot.id);
    const children = slot.children
      .map((id) => byId.get(id))
      .filter((child): child is Slot => child !== undefined);
    if (existing !== undefined && children.length === 0) return existing;

    const mean = circularMean(children.map(resolve));
    angles.set(slot.id, mean);
    return mean;
  };
  root.children
    .map((id) => byId.get(id))
    .filter((child): child is Slot => child !== undefined)
    .forEach(resolve);
  angles.set(root.id, 0);

  return slots.map((slot) => {
    const angle = angles.get(slot.id) ?? 0;
    const radius = slot.depth * separation;
    return {
      id: slot.id,
      node: slot.node,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      depth: slot.depth,
      side: slot.side,
    };
  });
}

/** Mean of angles on the unit circle, avoiding the 0/2π discontinuity. */
function circularMean(angles: readonly number[]): number {
  if (angles.length === 0) return 0;
  if (angles.length === 1) return angles[0] ?? 0;

  let sinSum = 0;
  let cosSum = 0;
  for (const angle of angles) {
    sinSum += Math.sin(angle);
    cosSum += Math.cos(angle);
  }

  // Near-total cancellation means the children straddle the discontinuity; averaging
  // the raw angles is more stable than dividing by a near-zero vector.
  if (Math.abs(sinSum) < 1e-9 && Math.abs(cosSum) < 1e-9) {
    return angles.reduce((sum, angle) => sum + angle, 0) / angles.length;
  }

  return Math.atan2(sinSum, cosSum);
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Extent of a laid-out set, optionally inflated by each node's own box. */
export function layoutBounds(
  nodes: readonly LaidOutNode[],
  sizeOf?: (node: AdnotaNode) => NodeSize,
): Bounds {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const entry of nodes) {
    const halfWidth = sizeOf ? sizeOf(entry.node).width / 2 : 0;
    const halfHeight = sizeOf ? sizeOf(entry.node).height / 2 : 0;

    minX = Math.min(minX, entry.x - halfWidth);
    maxX = Math.max(maxX, entry.x + halfWidth);
    minY = Math.min(minY, entry.y - halfHeight);
    maxY = Math.max(maxY, entry.y + halfHeight);
  }

  return { minX, minY, maxX, maxY };
}
