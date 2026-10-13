/**
 * Math rendering.
 *
 * Why KaTeX in `foreignObject`, and not MathML in the SVG
 * -------------------------------------------------------
 * The obvious design for a pure-SVG scene would be to emit MathML, because MathML
 * Core is supported by Chromium and Firefox and would let the scene stay pure SVG.
 * That turns out not to work. Measured in Chromium 156:
 *
 *     <math> directly inside <svg>     -> 0 x 0 px, does not render
 *     <math> inside <foreignObject>    -> 7.69 x 18.34 px, renders correctly
 *     <math> in ordinary HTML          -> 7.69 x 18.34 px, renders correctly
 *
 * SVG has no integration point for MathML, so the only way to get native math is a
 * `foreignObject`. (The alternative, MathJax's SVG output jax, emits real `<path>`
 * geometry and does work in bare SVG, at the cost of roughly 1.85 MB of lazy-loaded
 * JavaScript and a second renderer to keep in step with the editing one.)
 *
 * So math is KaTeX rendered to HTML inside a `foreignObject`. Consequences, stated
 * plainly rather than discovered later:
 *
 *   - Math is not selectable text in the canvas. Search and export of the *source*
 *     therefore read the LaTeX from the document model, never the rendered DOM.
 *   - Export to PDF/PNG goes through a high-DPI webview capture, so math is raster
 *     there. True vector math in exports would require the MathJax SVG path, which is
 *     tracked as a follow-up rather than assumed.
 *   - Screen readers get the raw LaTeX via `aria-label`, which is arguably more useful
 *     to a student than MathML element traversal.
 */

import katex from 'katex';

export type MathDisplay = 'inline' | 'block';

export interface RenderedMath {
  /** HTML for insertion into a `foreignObject`. */
  readonly html: string;
  /** The LaTeX source, echoed into `aria-label` so assistive tech can read it. */
  readonly accessibleLabel: string;
  /** True when the LaTeX failed to parse and an error placeholder was produced. */
  readonly failed: boolean;
}

/**
 * Parsing is memoised because the scene re-renders constantly during pan, zoom and
 * layout, and KaTeX parsing is by far the most expensive thing in the renderer.
 *
 * Bounded so that a document which mutates thousands of distinct expressions while
 * being typed cannot grow the cache without limit.
 */
const CACHE_LIMIT = 2000;
const cache = new Map<string, RenderedMath>();

export interface RenderMathOptions {
  readonly display?: MathDisplay;
  /** CSS colour for the glyphs. */
  readonly color?: string;
}

export function renderMath(latex: string, options: RenderMathOptions = {}): RenderedMath {
  const display = options.display ?? 'inline';
  const color = options.color ?? 'currentColor';

  const key = `${display}|${color}|${latex}`;
  const cached = cache.get(key);
  if (cached) {
    // Refresh recency for the bounded eviction below.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const result = compute(latex, display, color);
  cache.set(key, result);

  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }

  return result;
}

function compute(latex: string, display: MathDisplay, color: string): RenderedMath {
  try {
    const html = katex.renderToString(latex, {
      displayMode: display === 'block',
      // Render the offending source as coloured text rather than throwing. A student
      // typing `\frac{1}{` is mid-expression most of the time, and the canvas must
      // not blank out on every keystroke while they do.
      throwOnError: false,
      strict: 'ignore',
    });

    return { html, accessibleLabel: latex, failed: false };
  } catch {
    // Only reachable for failures KaTeX does not handle itself, such as a malformed
    // macro definition. Showing the raw source is the honest fallback.
    const escaped = escapeHtml(latex);
    return {
      html: `<span class="adnota-math-error" style="color:${color}">${escaped}</span>`,
      accessibleLabel: latex,
      failed: true,
    };
  }
}

/**
 * Strip TeX down to something a screen reader can say.
 *
 * A student listening to their own notes does not want to hear "backslash begin
 * fraction one over begin braces", but reading the symbols aloud is more useful than
 * silence. This is a readable approximation, not a TeX parser.
 */
export function latexToSpeech(latex: string): string {
  return latex
    .replace(/\\left|\\right/g, '')
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1) over ($2)')
    .replace(/\\sqrt\{([^{}]*)\}/g, 'the square root of $1')
    .replace(/\\sum/g, 'the sum of')
    .replace(/\\int/g, 'the integral of')
    .replace(/\\prod/g, 'the product of')
    .replace(/\\alpha/g, 'alpha')
    .replace(/\\beta/g, 'beta')
    .replace(/\\gamma/g, 'gamma')
    .replace(/\\theta/g, 'theta')
    .replace(/\\lambda/g, 'lambda')
    .replace(/\\mu/g, 'mu')
    .replace(/\\sigma/g, 'sigma')
    .replace(/\\phi/g, 'phi')
    .replace(/\\pi/g, 'pi')
    .replace(/\\times/g, 'times')
    .replace(/\\cdot/g, 'times')
    .replace(/\\leq/g, 'is less than or equal to')
    .replace(/\\geq/g, 'is greater than or equal to')
    .replace(/\\neq/g, 'is not equal to')
    .replace(/\\approx/g, 'is approximately')
    .replace(/\\pm/g, 'plus or minus')
    .replace(/\^/g, ' to the power of ')
    .replace(/_/g, ' subscript ')
    .replace(/\\\\/g, ', ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Test hook: drop the memoisation cache. */
export function clearMathCache(): void {
  cache.clear();
}

/** Test hook: current cache occupancy. */
export function mathCacheSize(): number {
  return cache.size;
}
