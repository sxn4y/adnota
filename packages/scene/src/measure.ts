/**
 * Text measurement.
 *
 * Layout needs each node's rendered size before it can position anything, but the
 * size depends on KaTeX having laid the math out. So measurement happens against a
 * live, hidden DOM node rather than by estimating from character counts.
 *
 * Measurement is the hot path during typing, so results are memoised by the exact
 * label content. A cache miss costs a forced layout, which is why the cache exists.
 */

import type { InlineDoc } from '@adnota/core';
import { renderLabelHtml } from './scene.ts';

export interface TextMetrics {
  readonly width: number;
  readonly height: number;
}

const CACHE_LIMIT = 4000;
const cache = new Map<string, TextMetrics>();

let host: HTMLElement | null = null;

/**
 * The hidden container used for measurement.
 *
 * It must be in the document (an off-screen `position: fixed` element rather than
 * `display: none`, which would collapse all children to zero) but must not be
 * visible or interactive.
 */
function measurementHost(): HTMLElement {
  if (host && host.isConnected) return host;

  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.dataset.adnotaMeasure = '';
  element.style.cssText = [
    'position: fixed',
    'top: -100000px',
    'left: -100000px',
    'width: max-content',
    'visibility: hidden',
    'pointer-events: none',
    'contain: layout style size',
    'z-index: -1',
  ].join(';');

  document.body.appendChild(element);
  host = element;
  return element;
}

/**
 * Measure a label.
 *
 * @param maxWidth the width at which the label wraps. Undefined means unwrapped, used
 *                 when measuring a single node in isolation.
 */
export function measureLabel(
  doc: InlineDoc,
  fontSize: number,
  maxWidth?: number,
): TextMetrics {
  const key = `${fontSize}|${maxWidth ?? 'none'}|${stableKey(doc)}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const parent = measurementHost();
  const probe = document.createElement('div');
  probe.style.cssText = `display:inline-block;${maxWidth === undefined ? '' : `width:${maxWidth}px;`}`;
  probe.innerHTML = renderLabelHtml(doc, fontSize);
  parent.appendChild(probe);

  // rect rather than offsetWidth: gives fractional widths, which matters because a
  // dense map accumulates rounding error otherwise.
  const rect = probe.getBoundingClientRect();
  const metrics: TextMetrics = {
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  };

  probe.remove();

  cache.set(key, metrics);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }

  return metrics;
}

/**
 * A cheap, stable identity for a label.
 *
 * Uses the JSON form. This is only ever used as a cache key, so the cost of
 * serialising is repaid many times over by the layout hits it avoids.
 */
function stableKey(doc: InlineDoc): string {
  return JSON.stringify(doc.content);
}

export function clearMeasureCache(): void {
  cache.clear();
}

export function measureCacheSize(): number {
  return cache.size;
}

/** Test hook: detach the measurement host. */
export function disposeMeasurement(): void {
  host?.remove();
  host = null;
}
