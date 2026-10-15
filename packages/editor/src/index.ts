/**
 * @adnota/editor — ProseMirror editing with first-class inline LaTeX.
 *
 * The editing surface is deliberately transient. While a node is being edited it is a
 * live ProseMirror instance positioned over the canvas; on commit it is torn down and
 * the canvas re-renders the settled SVG scene. That split is what lets the export path
 * stay pure SVG while typing still gets KaTeX's speed and full cursor behaviour
 * inside a formula.
 *
 * The document model is authoritative. ProseMirror's representation is adapted to it
 * by `convert.ts`, never the other way round, so a change of editor cannot invalidate
 * an existing `.adnota` file.
 */

export { blockSchema, inlineSchema, markNames, nodeNames } from './schema.ts';
export { blockMathNodeView, isBlockMathType } from './blockMathView.ts';

export type { BlockEditorOptions, EditorOptions } from './editor.ts';
export {
  ADD_TO_HISTORY,
  LOCAL_ORIGIN,
  REMOTE_ORIGIN,
  createBlockEditorState,
  createEditorState,
  editingCommands,
  leaveMathAt,
  leaveMathSelection,
  markRemote,
} from './editor.ts';

export {
  blockDocFromEditor,
  blockDocFromPm,
  blockDocToPm,
  inlineDocFromEditor,
  inlineDocFromPm,
  inlineDocToPm,
} from './convert.ts';