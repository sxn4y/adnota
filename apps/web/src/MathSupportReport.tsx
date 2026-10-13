/**
 * Diagnostics panel.
 *
 * Exists because "the math looks different on my machine" is otherwise
 * unanswerable. Contributors and bug reporters need to see which renderer is active
 * and what the webview claims to support, without opening devtools.
 */

import type { MathSupport } from './support.ts';

export interface MathSupportReportProps {
  readonly support: MathSupport;
}

export function MathSupportReport({ support }: MathSupportReportProps): React.JSX.Element {
  return (
    <aside className="adnota-support" data-testid="support-report">
      <h2>Diagnostics</h2>
      <dl>
        <dt>Active math renderer</dt>
        <dd data-testid="support-renderer">{support.renderer}</dd>

        <dt>MathML Core in HTML</dt>
        <dd data-testid="support-html">{String(support.nativeMathmlInHtml)}</dd>

        <dt>MathML in SVG foreignObject</dt>
        <dd data-testid="support-svg">{String(support.nativeMathmlInSvg)}</dd>

        <dt>User agent</dt>
        <dd className="adnota-support-ua">{support.userAgent}</dd>
      </dl>
      <p className="adnota-support-note">
        Adnota renders math with KaTeX inside an SVG <code>foreignObject</code>.
        MathML is reported for diagnostics; see <code>packages/scene/src/math.ts</code>
        for why it cannot be emitted directly into the SVG.
      </p>
    </aside>
  );
}
