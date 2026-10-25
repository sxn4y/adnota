/**
 * Node appearance: palette slots and box geometry.
 *
 * The document stores a *slot* (`'accent'`, `'green'`) rather than a hex string, which is
 * the right call for a document that might be opened under a different theme. This module
 * is where a slot becomes something drawable.
 *
 * ## The compromise, stated plainly
 *
 * Slots resolve to concrete hex values here, and the renderer writes them as presentation
 * attributes. That is what makes the SVG export work — an exported file has to be
 * self-contained, and `fill="var(--accent)"` is not dependable across renderers, least of
 * all the ones that open a standalone `.svg`.
 *
 * The cost is that a theme change will not recolour existing documents. It is a real cost,
 * and the thing to revisit if themes are ever built: the export would then need to rewrite
 * presentation attributes into CSS rules during serialisation.
 *
 * ## Why the fills are so pale
 *
 * Every slot is a tint, not a colour. Label text is near-black in all of them, so a student
 * picking "red" expects emphasis, not a black label on a saturated background that fails
 * contrast. The hue is carried by the border and the branch, where it reads clearly without
 * fighting the text.
 */

import type { NodeShape } from '@adnota/core';

/** A palette slot. Any string is accepted from a document; only these are drawn. */
export type NodeColorSlot = 'neutral' | 'accent' | 'red' | 'amber' | 'green' | 'violet';

/** The concrete colours a slot draws with. */
export interface PaletteEntry {
  readonly fill: string;
  readonly stroke: string;
}

/**
 * Slot to colour.
 *
 * `neutral` is also the fallback for a slot a document names but this build does not know,
 * so a file from a future version opens rather than rendering nodes with no fill.
 */
export const NODE_PALETTE: Readonly<Record<NodeColorSlot, PaletteEntry>> = {
  neutral: { fill: '#ffffff', stroke: '#d5dae1' },
  accent: { fill: '#eef3ff', stroke: '#3b6ef6' },
  red: { fill: '#fdecec', stroke: '#d1534f' },
  amber: { fill: '#fdf3e3', stroke: '#c98a1e' },
  green: { fill: '#ecf7ee', stroke: '#3f8f52' },
  violet: { fill: '#f2edfd', stroke: '#7358c9' },
};

/** The slot every node gets when it says nothing, and the one new nodes are created with. */
export const DEFAULT_COLOR: NodeColorSlot = 'neutral';

/** The shape every node gets when it says nothing. */
export const DEFAULT_SHAPE: NodeShape = 'box';

/** Every slot, in the order a palette should be offered. */
export const COLOR_SLOTS = Object.keys(NODE_PALETTE) as NodeColorSlot[];

/** Every shape, in a deliberate order rather than the model's declaration order. */
export const SHAPES: readonly NodeShape[] = ['none', 'underline', 'box', 'round', 'pill'];

/** How a node draws itself, ready for the renderer. */
export interface NodeAppearance {
  readonly fill: string;
  readonly stroke: string;
  /** Corner radius for the box. Zero when there is no box. */
  readonly radius: number;
  /** Whether to draw a box at all. */
  readonly boxed: boolean;
  /** Whether to draw a rule under the label. */
  readonly underlined: boolean;
}

/** True when the slot is one this build knows how to draw. */
export function isKnownSlot(slot: string): slot is NodeColorSlot {
  // Object.hasOwn rather than `in`. `in` walks the prototype chain, so a document naming a
  // slot called `constructor` or `toString` would resolve to a function rather than falling
  // back to neutral, and the node would be drawn with garbage.
  return Object.hasOwn(NODE_PALETTE, slot);
}

/**
 * Resolve a slot to colours, falling back rather than throwing.
 *
 * A document is user data that outlives the app that wrote it. Rendering an unknown slot as
 * `neutral` means a file from a newer build still opens; the alternative is a blank node.
 */
export function paletteFor(slot: string | null | undefined): PaletteEntry {
  if (slot !== null && slot !== undefined && isKnownSlot(slot)) {
    return NODE_PALETTE[slot];
  }

  return NODE_PALETTE[DEFAULT_COLOR];
}

/**
 * Geometry for a shape at a given box size.
 *
 * `round` and `pill` differ only at the corners, and the distinction matters: a pill caps
 * at half the *height*, so it stays pill-shaped at any width, while `round` uses the smaller
 * of width and height, which is what a student means by "round the ends" on a wide node.
 */
export function shapeGeometry(
  shape: NodeShape,
  width: number,
  height: number,
): Pick<NodeAppearance, 'radius' | 'boxed' | 'underlined'> {
  switch (shape) {
    case 'none':
      return { radius: 0, boxed: false, underlined: false };
    case 'underline':
      return { radius: 0, boxed: false, underlined: true };
    case 'round':
      return { radius: Math.min(width, height) / 2, boxed: true, underlined: false };
    case 'pill':
      return { radius: height / 2, boxed: true, underlined: false };
    case 'box':
    default:
      // An unrecognised shape from a newer document draws as a box rather than vanishing.
      return { radius: 8, boxed: true, underlined: false };
  }
}

/** Fill, stroke and geometry for a node, in one call. */
export function nodeAppearance(
  shape: NodeShape,
  color: string | null | undefined,
  width: number,
  height: number,
): NodeAppearance {
  return {
    ...paletteFor(color),
    ...shapeGeometry(shape, width, height),
  };
}