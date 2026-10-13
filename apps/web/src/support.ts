/**
 * Math support detection.
 *
 * Recorded as a first-class runtime fact rather than assumed, because the answer
 * differs by webview: Chromium and Firefox implement MathML Core, and Apple's WebKit
 * ports have it behind a flag rather than on by default. Adnota runs on all three, so
 * the app measures instead of guessing.
 *
 * The detection deliberately distinguishes *MathML in HTML* from *MathML in SVG*. They
 * are not the same capability, and conflating them is exactly the mistake that would
 * have shipped a broken export path.
 */

export interface MathSupport {
  /** MathML Core renders in ordinary HTML. */
  readonly nativeMathmlInHtml: boolean;
  /**
   * MathML renders inside an SVG `foreignObject`.
   *
   * Measured at roughly the same rate as `nativeMathmlInHtml` in practice, but named
   * separately because it is the capability the scene actually depends on.
   */
  readonly nativeMathmlInSvg: boolean;
  /** The renderer the scene will use. */
  readonly renderer: 'katex-foreignObject';
  readonly userAgent: string;
}

/**
 * Measure whether a `<math>` element actually produces geometry.
 *
 * Feature-detecting the constructor is not enough: Chromium exposes `MathMLElement`
 * and creates the node in bare SVG too, where it lays out to nothing at all. The only
 * reliable test is to measure.
 */
function measuresNonZero(html: string): boolean {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:-100000px;left:-100000px;visibility:hidden;pointer-events:none';
  probe.innerHTML = html;
  document.body.appendChild(probe);

  const math = probe.querySelector('math');
  const measured = math ? math.getBoundingClientRect() : null;
  probe.remove();

  return measured !== null && measured.width > 0 && measured.height > 0;
}

/** A fraction, because it exercises nesting and forces real layout. */
const SAMPLE = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mn>1</mn><mn>3</mn></mfrac></math>';

export function detectMathSupport(): MathSupport {
  const inHtml = measuresNonZero(SAMPLE);

  const probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  probe.setAttribute('aria-hidden', 'true');
  probe.setAttribute('width', '200');
  probe.setAttribute('height', '200');
  probe.style.cssText = 'position:fixed;top:-100000px;left:-100000px;visibility:hidden';
  probe.innerHTML = `<foreignObject width="200" height="200">${SAMPLE}</foreignObject>`;
  document.body.appendChild(probe);

  const mathInForeignObject = probe.querySelector('math');
  const rect = mathInForeignObject?.getBoundingClientRect() ?? null;
  probe.remove();

  const inSvg =
    rect !== null && rect !== undefined && rect.width > 0 && rect.height > 0;

  // Even where MathML is available, the scene uses KaTeX in a foreignObject. Native
  // MathML is reported for diagnostics and for the export work tracked as a
  // follow-up, not because the current renderer depends on it.
  return {
    nativeMathmlInHtml: inHtml,
    nativeMathmlInSvg: inSvg,
    renderer: 'katex-foreignObject',
    userAgent: navigator.userAgent,
  };
}
