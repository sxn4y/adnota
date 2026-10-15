/**
 * @adnota/view — the React layer.
 *
 * Platform-agnostic: the browser harness and the Tauri window mount exactly this,
 * differing only in how they obtain a document. Keeping it in a package rather than in
 * an app directory is what stops the two from drifting apart.
 */

export { DocumentsPanel } from './DocumentsPanel.tsx';
export type { DocumentsPanelProps } from './DocumentsPanel.tsx';
export type { DocumentLibrary } from './library.ts';
export { MemoryLibrary, defaultTitle, filenameFor, starterDocument, validateRename } from './library.ts';
export { MathLabel, inlineToPlain } from './MathLabel.tsx';
export { MathSupportReport } from './MathSupportReport.tsx';
export type { MathSupportReportProps } from './MathSupportReport.tsx';

export { MindmapApp, CANVAS_SIZE } from './MindmapApp.tsx';
export type { MountOptions, MountedApp } from './mount.tsx';
export { mountApp } from './mount.tsx';
export type { MindmapAppProps } from './MindmapApp.tsx';

export { NodeEditor } from './NodeEditor.tsx';
export type { NodeEditorProps } from './NodeEditor.tsx';

export { SceneView } from './SceneView.tsx';
export type { SceneViewProps } from './SceneView.tsx';

export { detectMathSupport } from './support.ts';
export type { MathSupport } from './support.ts';

export { buildSampleDocument } from './sample.ts';
export type { SampleTree } from './sample.ts';

export type { NodeCommands, SceneBounds, SceneState, SelectionState } from './scene.ts';
export {
  LABEL_FONT_SIZE,
  LABEL_MAX_WIDTH,
  PADDING_X,
  PADDING_Y,
  measureLabelBox,
  measureNode,
  useNodeCommands,
  useScene,
  useSceneBounds,
  useSelection,
  visibleOrder,
} from './scene.ts';

export type { FitOptions, Viewport, ZoomOptions } from './viewport.ts';
export {
  IDENTITY_VIEWPORT,
  MAX_SCALE,
  MIN_SCALE,
  fitToContent,
  panBy,
  toScreen,
  toWorld,
  zoomAt,
} from './viewport.ts';