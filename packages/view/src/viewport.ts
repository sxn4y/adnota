/**
 * Viewport: pan and zoom.
 *
 * Kept as a plain transform on a root `<g>` rather than by rewriting the SVG
 * viewBox, because the viewBox approach has to be recomputed on every frame and
 * makes wheel-anchored zoom drift as the box changes underneath the pointer.
 *
 * Scene coordinates are world coordinates. Screen coordinates are what the HTML
 * overlay for the editor needs, so `toScreen` exists and is exact rather than
 * incidental.
 */

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 };

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 3;

/** Convert a world-space point to the SVG's own coordinate space. */
export function toScreen(viewport: Viewport, worldX: number, worldY: number): { x: number; y: number } {
  return {
    x: worldX * viewport.scale + viewport.x,
    y: worldY * viewport.scale + viewport.y,
  };
}

/** Inverse of `toScreen`. */
export function toWorld(viewport: Viewport, screenX: number, screenY: number): { x: number; y: number } {
  return {
    x: (screenX - viewport.x) / viewport.scale,
    y: (screenY - viewport.y) / viewport.scale,
  };
}

export interface ZoomOptions {
  /** Where in screen space the zoom is anchored. Defaults to the viewport centre. */
  readonly anchorX?: number;
  readonly anchorY?: number;
  /** Multiplier, or an absolute scale if `absolute` is set. */
  readonly factor?: number;
  readonly absolute?: number;
}

/**
 * Zoom about a fixed screen point.
 *
 * Anchoring matters: zooming about the top-left makes the content slide out from
 * under the cursor, which is the single most common complaint about canvas apps.
 */
export function zoomAt(viewport: Viewport, options: ZoomOptions): Viewport {
  const factor = options.factor ?? 1.1;
  const next = clamp(
    options.absolute ?? viewport.scale * factor,
    MIN_SCALE,
    MAX_SCALE,
  );

  const anchorX = options.anchorX ?? 0;
  const anchorY = options.anchorY ?? 0;

  // Solve for the translation that keeps the world point under the anchor fixed.
  const worldX = (anchorX - viewport.x) / viewport.scale;
  const worldY = (anchorY - viewport.y) / viewport.scale;

  return {
    x: anchorX - worldX * next,
    y: anchorY - worldY * next,
    scale: next,
  };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

export function clampScale(scale: number): number {
  return clamp(scale, MIN_SCALE, MAX_SCALE);
}

export interface FitOptions {
  /**
   * Extent of the content in world coordinates.
   *
   * `minX`/`minY` matter, not just the extent: a two-sided mindmap is not centred on
   * the origin, so centring on width alone places the whole map off-screen.
   */
  readonly minX: number;
  readonly minY: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly padding?: number;
}

/** A viewport that fits the given content and centres it in the view. */
export function fitToContent(options: FitOptions): Viewport {
  const padding = options.padding ?? 48;

  const usableWidth = Math.max(1, options.viewportWidth - padding * 2);
  const usableHeight = Math.max(1, options.viewportHeight - padding * 2);

  const contentWidth = Math.max(1, options.contentWidth);
  const contentHeight = Math.max(1, options.contentHeight);

  const scale = clamp(
    Math.min(usableWidth / contentWidth, usableHeight / contentHeight),
    MIN_SCALE,
    MAX_SCALE,
  );

  // Map the content's own extent into the padded view, rather than assuming the
  // content straddles the origin.
  const drawnWidth = contentWidth * scale;
  const drawnHeight = contentHeight * scale;

  return {
    scale,
    x: padding + (usableWidth - drawnWidth) / 2 - options.minX * scale,
    y: padding + (usableHeight - drawnHeight) / 2 - options.minY * scale,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}