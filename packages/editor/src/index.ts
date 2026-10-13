/**
 * @adnota/editor — ProseMirror editing with first-class inline LaTeX.
 *
 * The editing surface is deliberately transient. While a node is being edited it is a
 * live ProseMirror instance positioned over the canvas; on commit it is torn down and
 * the canvas re-renders the settled SVG scene. That split is what lets the export path
 * stay pure SVG while typing still gets KaTeX's speed and full cursor behaviour
 * inside a formula.
 */

export { inlineSchema, markNames, nodeNames } from './schema.ts';

export type { EditorOptions } from './editor.ts';
export { LOCAL_ORIGIN, createEditorState, editingCommands } from './editor.ts';

export {
  blockDocFromEditor,
  blockDocFromPm,
  inlineDocFromEditor,
  inlineDocFromPm,
  inlineDocToPm,
} from './convert.ts';