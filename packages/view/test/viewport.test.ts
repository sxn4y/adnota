import { describe, expect, it } from 'vitest';
import {
  IDENTITY_VIEWPORT,
  MAX_SCALE,
  MIN_SCALE,
  fitToContent,
  panBy,
  toScreen,
  toWorld,
  zoomAt,
} from '@adnota/view';

/**
 * Viewport maths is pure and the failures are invisible: a wrong translation does not
 * throw, it puts the map off-screen, where the only symptom is a node that cannot be
 * clicked. Every case below was written after watching that happen.
 */

describe('coordinate conversion', () => {
  it('round-trips a point', () => {
    const viewport = { x: 120, y: -40, scale: 1.75 };
    const world = { x: 300, y: 220 };

    const back = toWorld(viewport, ...(() => {
      const s = toScreen(viewport, world.x, world.y);
      return [s.x, s.y] as const;
    })());

    expect(back.x).toBeCloseTo(world.x, 6);
    expect(back.y).toBeCloseTo(world.y, 6);
  });

  it('leaves the origin at the translation', () => {
    expect(toScreen(IDENTITY_VIEWPORT, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('zoomAt', () => {
  it('keeps the point under the anchor fixed', () => {
    const viewport = { x: 0, y: 0, scale: 1 };
    const anchor = { x: 400, y: 300 };

    const before = toWorld(viewport, anchor.x, anchor.y);
    const zoomed = zoomAt(viewport, { anchorX: anchor.x, anchorY: anchor.y, factor: 2 });
    const after = toWorld(zoomed, anchor.x, anchor.y);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('clamps to the supported range', () => {
    expect(zoomAt(IDENTITY_VIEWPORT, { factor: 1_000_000 }).scale).toBe(MAX_SCALE);
    expect(zoomAt(IDENTITY_VIEWPORT, { factor: 0.000001 }).scale).toBe(MIN_SCALE);
  });

  it('accepts an absolute scale', () => {
    expect(zoomAt(IDENTITY_VIEWPORT, { absolute: 1.25 }).scale).toBe(1.25);
  });

  it('survives a non-finite request rather than producing NaN geometry', () => {
    // A single NaN in the viewport silently blanks the scene, because every derived
    // coordinate becomes NaN. Clamping at the boundary is the only place to catch it.
    const zoomed = zoomAt(IDENTITY_VIEWPORT, { factor: Number.NaN });
    expect(Number.isFinite(zoomed.scale)).toBe(true);
    expect(Number.isFinite(zoomed.x)).toBe(true);
    expect(Number.isFinite(zoomed.y)).toBe(true);
  });
});

describe('panBy', () => {
  it('translates without changing the scale', () => {
    const moved = panBy({ x: 10, y: 20, scale: 2 }, 5, -5);
    expect(moved).toEqual({ x: 15, y: 15, scale: 2 });
  });
});

describe('fitToContent', () => {
  const viewport = { viewportWidth: 1000, viewportHeight: 800, padding: 50 };

  it('places symmetric content inside the padded view', () => {
    const fitted = fitToContent({
      minX: -500,
      minY: -400,
      contentWidth: 1000,
      contentHeight: 800,
      ...viewport,
    });

    const topLeft = toScreen(fitted, -500, -400);
    const bottomRight = toScreen(fitted, 500, 400);

    expect(topLeft.x).toBeGreaterThanOrEqual(50 - 0.001);
    expect(topLeft.y).toBeGreaterThanOrEqual(50 - 0.001);
    expect(bottomRight.x).toBeLessThanOrEqual(1000 - 50 + 0.001);
    expect(bottomRight.y).toBeLessThanOrEqual(800 - 50 + 0.001);
  });

  it('places lopsided content inside the view too', () => {
    // The regression. A two-sided mindmap extends much further left than right, so
    // centring on width alone maps the content's minimum to a negative coordinate and
    // the map renders off-screen. The symptom was a node that could not be clicked.
    const fitted = fitToContent({
      minX: -1400,
      minY: -200,
      contentWidth: 1600,
      contentHeight: 400,
      ...viewport,
    });

    const topLeft = toScreen(fitted, -1400, -200);
    const bottomRight = toScreen(fitted, 200, 200);

    expect(topLeft.x).toBeGreaterThanOrEqual(50 - 0.001);
    expect(bottomRight.x).toBeLessThanOrEqual(1000 - 50 + 0.001);
    expect(Number.isFinite(fitted.x)).toBe(true);
  });

  it('centres content that does not straddle the origin', () => {
    const fitted = fitToContent({
      minX: 900,
      minY: 900,
      contentWidth: 300,
      contentHeight: 300,
      ...viewport,
    });

    const centre = toScreen(fitted, 900 + 150, 900 + 150);
    expect(centre.x).toBeCloseTo(500, 0);
    expect(centre.y).toBeCloseTo(400, 0);
  });

  it('never exceeds the scale limits', () => {
    const tiny = fitToContent({ minX: 0, minY: 0, contentWidth: 10_000_000, contentHeight: 10_000_000, ...viewport });
    expect(tiny.scale).toBe(MIN_SCALE);

    const huge = fitToContent({ minX: 0, minY: 0, contentWidth: 1, contentHeight: 1, ...viewport });
    expect(huge.scale).toBe(MAX_SCALE);
  });

  it('handles zero-sized content without producing NaN', () => {
    const fitted = fitToContent({ minX: 0, minY: 0, contentWidth: 0, contentHeight: 0, ...viewport });
    expect(Number.isFinite(fitted.x)).toBe(true);
    expect(Number.isFinite(fitted.y)).toBe(true);
    expect(Number.isFinite(fitted.scale)).toBe(true);
  });
});