/**
 * Development harness entry point.
 *
 * Runs the real scene renderer in a plain browser against in-memory storage, so that
 * layout, math, and rendering can be worked on without a Rust toolchain. The
 * component tree here is the same one the desktop shell uses.
 */

import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SceneView } from './SceneView.tsx';
import { buildSampleDocument } from './sample.ts';
import { MathSupportReport } from './MathSupportReport.tsx';
import { detectMathSupport } from './support.ts';
import type { LayoutKind } from '@adnota/scene';

const LAYOUTS: readonly { readonly id: LayoutKind; readonly label: string }[] = [
  { id: 'two-sided', label: 'Two-sided' },
  { id: 'radial', label: 'Radial' },
  { id: 'left', label: 'Left' },
];

function App(): React.JSX.Element {
  const [kind, setKind] = useState<LayoutKind>('two-sided');
  const [showReport, setShowReport] = useState(false);

  // Built once: the harness is a viewer, so there is no editing surface to rebuild the
  // document against. Editing arrives with the editor milestone.
  const { doc } = useMemo(() => buildSampleDocument(), []);
  const support = useMemo(() => detectMathSupport(), []);

  return (
    <div className="adnota-harness">
      <header className="adnota-toolbar">
        <span className="adnota-brand">Adnota</span>
        <div className="adnota-layouts" role="group" aria-label="Layout">
          {LAYOUTS.map((layout) => (
            <button
              key={layout.id}
              type="button"
              className={layout.id === kind ? 'is-active' : ''}
              aria-pressed={layout.id === kind}
              onClick={() => setKind(layout.id)}
              data-testid={`layout-${layout.id}`}
            >
              {layout.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={showReport ? 'is-active' : ''}
          onClick={() => setShowReport((value) => !value)}
          data-testid="toggle-support"
        >
          {support.nativeMathmlInSvg ? 'MathML in SVG' : 'KaTeX + foreignObject'}
        </button>
      </header>

      <main className="adnota-canvas" data-testid="canvas">
        <SceneView doc={doc} kind={kind} width={1200} height={800} />
      </main>

      {showReport ? <MathSupportReport support={support} /> : null}
    </div>
  );
}

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
