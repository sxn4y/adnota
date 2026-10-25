/**
 * @adnota/scene — layout, math rendering, and SVG scene construction.
 *
 * KaTeX's stylesheet is imported here rather than by each consumer because it is not
 * optional styling. Without it, `.katex-mathml` is not hidden and the MathML source
 * KaTeX emits for accessibility renders as a visible duplicate of every formula,
 * and the math fonts fall back to system serif. Both failures are quiet: the markup is
 * correct and the tests that check for geometry still pass.
 */
import 'katex/dist/katex.min.css';

export type { LayoutKind, LayoutOptions, Bounds, LaidOutNode, NodeSize, Side } from './layout.ts';
export {
  DEFAULT_LAYOUT,
  labelIsEmpty,
  layoutBounds,
  layoutTree,
  resolveVisualRoot,
} from './layout.ts';

export type { MathDisplay, RenderedMath, RenderMathOptions } from './math.ts';
export { clearMathCache, escapeHtml, latexToSpeech, mathCacheSize, renderMath } from './math.ts';

export type { NodeBox } from './scene.ts';
export {
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  branchAttributes,
  buildBranch,
  findLaidOut,
  labelToPlainText,
  laidOutChildren,
  nodeBox,
  renderLabelHtml,
  serializeScene,
  stripWrapper,
} from './scene.ts';

export type { TextMetrics } from './measure.ts';
export type { NodeAppearance, NodeColorSlot, PaletteEntry } from './palette.ts';
export {
  COLOR_SLOTS,
  DEFAULT_COLOR,
  DEFAULT_SHAPE,
  NODE_PALETTE,
  SHAPES,
  isKnownSlot,
  nodeAppearance,
  paletteFor,
  shapeGeometry,
} from './palette.ts';
export {
  clearMeasureCache,
  disposeMeasurement,
  measureCacheSize,
  measureLabel,
} from './measure.ts';
