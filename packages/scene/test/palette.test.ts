/**
 * Tests for node appearance: palette resolution and shape geometry.
 *
 * These are the rules that decide what a student sees when they colour a node, and both
 * have a failure mode that would otherwise be invisible: a colour that resolves to nothing
 * renders a node with no fill, and a shape that falls through the switch renders nothing
 * at all. Neither throws, so both are pinned here.
 */

import { describe, expect, test } from 'vitest';
import {
  COLOR_SLOTS,
  DEFAULT_COLOR,
  NODE_PALETTE,
  SHAPES,
  isKnownSlot,
  nodeAppearance,
  paletteFor,
  shapeGeometry,
} from '../src/palette.ts';

describe('paletteFor', () => {
  test('resolves every slot the palette offers', () => {
    for (const slot of COLOR_SLOTS) {
      const entry = paletteFor(slot);
      expect(entry.fill).toMatch(/^#[0-9a-f]{6}$/i);
      expect(entry.stroke).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test('falls back to neutral for a slot this build does not know', () => {
    // A document outlives the app that wrote it. A slot from a newer version must open
    // with a visible node rather than an invisible one.
    expect(paletteFor('chartreuse')).toEqual(NODE_PALETTE[DEFAULT_COLOR]);
    expect(paletteFor(null)).toEqual(NODE_PALETTE[DEFAULT_COLOR]);
    expect(paletteFor(undefined)).toEqual(NODE_PALETTE[DEFAULT_COLOR]);
  });

  test('does not treat inherited object properties as slots', () => {
    // `in` walks the prototype chain, so without this a slot named `constructor` or
    // `toString` would resolve to a function instead of falling back.
    expect(paletteFor('constructor')).toEqual(NODE_PALETTE[DEFAULT_COLOR]);
    expect(paletteFor('toString')).toEqual(NODE_PALETTE[DEFAULT_COLOR]);
  });

  test('every fill is pale enough for near-black label text', () => {
    // Not a contrast-ratio calculation: the requirement is that no slot is saturated
    // enough to fight the label, which is a design constraint expressed as a bound.
    for (const slot of COLOR_SLOTS) {
      const { fill } = NODE_PALETTE[slot];
      const rgb = [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16));
      const brightest = Math.max(...rgb);
      expect(brightest).toBeGreaterThanOrEqual(0xe0);
    }
  });
});

describe('isKnownSlot', () => {
  test('agrees with the palette', () => {
    for (const slot of COLOR_SLOTS) expect(isKnownSlot(slot)).toBe(true);
    expect(isKnownSlot('nope')).toBe(false);
  });
});

describe('shapeGeometry', () => {
  const W = 200;
  const H = 40;

  test('pill caps at half the height, so it stays a pill at any width', () => {
    expect(shapeGeometry('pill', W, H)).toEqual({ radius: H / 2, boxed: true, underlined: false });

    const tall = shapeGeometry('pill', 200, 200);
    expect(tall.radius).toBe(100);
  });

  test('round uses the smaller of width and height', () => {
    // The distinction from pill: on a wide node, round is a long rounded end and pill is
    // not, which is what a student means by the two.
    expect(shapeGeometry('round', W, H).radius).toBe(H / 2);
    expect(shapeGeometry('round', 40, 200).radius).toBe(20);
  });

  test('box has a small fixed corner', () => {
    expect(shapeGeometry('box', W, H)).toEqual({ radius: 8, boxed: true, underlined: false });
  });

  test('none draws no box and no rule', () => {
    expect(shapeGeometry('none', W, H)).toEqual({ radius: 0, boxed: false, underlined: false });
  });

  test('underline draws a rule and no box', () => {
    expect(shapeGeometry('underline', W, H)).toEqual({
      radius: 0,
      boxed: false,
      underlined: true,
    });
  });

  test('an unknown shape draws as a box rather than vanishing', () => {
    // A node that renders as nothing is worse than one that ignores a shape it has never
    // heard of.
    const geometry = shapeGeometry('hexagon' as never, W, H);
    expect(geometry.boxed).toBe(true);
  });

  test('handles a degenerate zero-size box without producing NaN', () => {
    // NaN in an SVG attribute silently drops the element in some renderers.
    expect(Number.isFinite(shapeGeometry('pill', 0, 0).radius)).toBe(true);
    expect(Number.isFinite(shapeGeometry('round', 0, 0).radius)).toBe(true);
  });
});

describe('nodeAppearance', () => {
  test('combines the palette and the geometry', () => {
    const look = nodeAppearance('pill', 'green', 200, 40);

    expect(look.fill).toBe(NODE_PALETTE.green.fill);
    expect(look.stroke).toBe(NODE_PALETTE.green.stroke);
    expect(look.radius).toBe(20);
    expect(look.boxed).toBe(true);
  });

  test('covers every shape in the offered list', () => {
    // Guards against a shape being added to the picker with no rendering behind it.
    // `none` is excluded: drawing nothing is the whole point of that one.
    for (const shape of SHAPES.filter((candidate) => candidate !== 'none')) {
      const look = nodeAppearance(shape, 'accent', 200, 40);
      expect(look.boxed || look.underlined).toBe(true);
    }
  });
});