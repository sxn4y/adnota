/**
 * Mount helper.
 *
 * The browser harness and the desktop window both mount the same app, and neither
 * should have to know that React is what it is mounted with. Exposing this here means
 * a platform entry point is a single call rather than an import of `react-dom/client`,
 * which keeps those entry points from drifting into separate components.
 */

import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MindmapApp, type MindmapAppProps } from './MindmapApp.tsx';

export interface MountOptions extends MindmapAppProps {
  /** Wrap in StrictMode. On by default; turn it off only to chase a double-render bug. */
  readonly strict?: boolean;
}

export interface MountedApp {
  readonly unmount: () => void;
}

export function mountApp(container: Element, options: MountOptions = {}): MountedApp {
  const { strict = true, ...props } = options;

  const root: Root = createRoot(container);
  root.render(strict ? <StrictMode><MindmapApp {...props} /></StrictMode> : <MindmapApp {...props} />);

  return {
    unmount: () => root.unmount(),
  };
}