/**
 * Conversion between the document model and ProseMirror JSON.
 *
 * The document model is authoritative: it is what gets written to disk and what a
 * collaboration packet carries. ProseMirror's representation is adapted to it rather
 * than the other way round, so a change of editor cannot invalidate existing files.
 *
 * Everything here is pure and DOM-free, which is why the conversion is unit tested in
 * Node rather than only through the browser.
 */

import { type Node as PMNode, type Schema } from 'prosemirror-model';
import type { BlockDoc, BlockNode, InlineDoc, InlineNode, Mark } from '@adnota/core';
import { markNames, nodeNames } from './schema.ts';

/** Marks the model can round-trip. Anything else is dropped rather than persisted. */
const SUPPORTED_MARKS = new Set<string>(Object.values(markNames));

/**
 * ProseMirror's JSON for a label, to the model's shape.
 *
 * Unknown nodes are skipped rather than passed through: a document authored by a newer
 * build should lose an unrecognised inline object in the editor, not corrupt the
 * stored one.
 */
export function inlineDocFromPm(value: unknown): InlineDoc {
  if (!isRecord(value)) return { type: 'doc', content: [] };

  const rawContent = Array.isArray(value.content) ? value.content : [];
  const content: InlineNode[] = [];

  for (const entry of rawContent) {
    const node = inlineNodeFromPm(entry);
    if (node) content.push(node);
  }

  return { type: 'doc', content };
}

function inlineNodeFromPm(value: unknown): InlineNode | null {
  if (!isRecord(value)) return null;

  switch (value.type) {
    case nodeNames.text: {
      if (typeof value.text !== 'string') return null;
      const marks = readMarks(value.marks);
      // An empty text node carries no information and ProseMirror rejects it on the
      // way back in, so it is dropped rather than round-tripped.
      if (value.text.length === 0 && marks.length === 0) return null;
      return marks.length > 0
        ? { type: 'text', text: value.text, marks }
        : { type: 'text', text: value.text };
    }

    case nodeNames.mathInline: {
      const latex = mathLatexOf(value);
      return latex === null ? null : { type: 'math_inline', latex };
    }

    case nodeNames.image: {
      const attrs = isRecord(value.attrs) ? value.attrs : {};
      const assetId = typeof attrs.assetId === 'string' ? attrs.assetId : '';
      if (!assetId) return null;
      const alt = typeof attrs.alt === 'string' && attrs.alt.length > 0 ? attrs.alt : undefined;
      return alt === undefined ? { type: 'image', assetId } : { type: 'image', assetId, alt };
    }

    default:
      return null;
  }
}

/**
 * Read a formula's LaTeX from a ProseMirror node.
 *
 * `prosemirror-math` declares its maths nodes as atoms with `content: "text*"`, so
 * the LaTeX arrives as a *child text node* in the JSON rather than as an attribute.
 * The `latex` and `tex` attribute forms are also accepted so that content pasted from
 * elsewhere, or written by a future build, still converts.
 */
function mathLatexOf(value: Record<string, unknown>): string | null {
  if (typeof value.text === 'string') return value.text;

  if (Array.isArray(value.content)) {
    // Concatenate rather than take the first child: a formula long enough to be
    // split across text nodes would otherwise be truncated.
    let joined = '';
    for (const child of value.content) {
      if (isRecord(child) && child.type === nodeNames.text && typeof child.text === 'string') {
        joined += child.text;
      }
    }
    if (joined.length > 0) return joined;
  }

  const attrs = isRecord(value.attrs) ? value.attrs : {};
  const latex = attrs.latex ?? attrs.tex;
  return typeof latex === 'string' ? latex : null;
}

function readMarks(value: unknown): Mark[] {
  if (!Array.isArray(value)) return [];
  const out: Mark[] = [];

  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.type !== 'string') continue;
    if (!SUPPORTED_MARKS.has(entry.type)) continue;

    const attrs = isRecord(entry.attrs) ? entry.attrs : {};
    // `strong="false"` is a legitimate ProseMirror encoding of an unapplied mark.
    if (attrs.on === false) continue;

    out.push(
      Object.keys(attrs).length > 0 ? { type: entry.type, attrs } : { type: entry.type },
    );
  }

  return out;
}

/** The model's shape for a label, to ProseMirror JSON. */
export function inlineDocToPm(doc: InlineDoc, schema: Schema): PMNode {
  const docType = schema.nodes.doc;
  // Only reachable if a caller passes a schema without a top-level `doc`, which the
  // inline schema always has. Asserting rather than throwing keeps the failure loud.
  if (!docType) throw new Error('schema has no top-level doc node');

  const content: PMNode[] = [];

  for (const node of doc.content) {
    const converted = inlineNodeToPm(node, schema);
    if (converted) content.push(converted);
  }

  return docType.create(null, content);
}

function inlineNodeToPm(node: InlineNode, schema: Schema): PMNode | null {
  switch (node.type) {
    case 'text': {
      if (node.text.length === 0) return null;
      const marks = (node.marks ?? [])
        .filter((mark) => SUPPORTED_MARKS.has(mark.type))
        .map((mark) => schema.marks[mark.type]?.create(mark.attrs ?? null))
        .filter((mark): mark is NonNullable<typeof mark> => mark !== undefined);
      return schema.text(node.text, marks);
    }

    case 'math_inline': {
      const type = schema.nodes[nodeNames.mathInline];
      if (!type) return null;
      // Text content, matching what prosemirror-math's renderer expects.
      return type.create(null, node.latex.length > 0 ? schema.text(node.latex) : undefined);
    }

    case 'image': {
      const type = schema.nodes[nodeNames.image];
      if (!type) return null;
      return type.create({ assetId: node.assetId, alt: node.alt ?? null });
    }
  }
}

// ---------------------------------------------------------------------------
// Notes bodies
// ---------------------------------------------------------------------------

/**
 * ProseMirror JSON for a notes body, to the model's shape.
 *
 * The notes body is a block document rather than the inline one used for labels, so
 * it needs its own document node. Handled here rather than in the schema because the
 * two share every node definition except the top-level container.
 */
export function blockDocFromPm(value: unknown): BlockDoc {
  if (!isRecord(value)) return { type: 'doc', content: [] };

  const rawContent = Array.isArray(value.content) ? value.content : [];
  const content: BlockNode[] = [];

  for (const entry of rawContent) {
    const node = blockNodeFromPm(entry);
    if (node) content.push(node);
  }

  return { type: 'doc', content };
}

function blockNodeFromPm(value: unknown): BlockNode | null {
  if (!isRecord(value)) return null;
  const children = () =>
    Array.isArray(value.content)
      ? value.content.map(blockNodeFromPm).filter((n): n is BlockNode => n !== null)
      : [];

  switch (value.type) {
    case 'paragraph':
      return { type: 'paragraph', content: inlineContentOf(value) };

    case 'heading': {
      const attrs = isRecord(value.attrs) ? value.attrs : {};
      const level = typeof attrs.level === 'number' ? attrs.level : 1;
      return { type: 'heading', attrs: { level }, content: inlineContentOf(value) };
    }

    case 'bullet_list':
      return { type: 'bullet_list', content: children() };

    case 'ordered_list':
      return { type: 'ordered_list', content: children() };

    case 'list_item':
      return { type: 'list_item', content: children() };

    case 'blockquote':
      return { type: 'blockquote', content: children() };

    case 'code_block':
      // A code block is `text*`, so its content is a text child rather than a `text`
      // property on the node. Reading `value.text` here always returned undefined and
      // silently emptied every code block the moment a notes body was reloaded.
      return { type: 'code_block', text: textContentOf(value) };

    case nodeNames.mathDisplay: {
      const latex = mathLatexOf(value);
      return latex === null ? null : { type: 'math_display', latex };
    }

    case nodeNames.image: {
      const node = inlineNodeFromPm(value);
      return node?.type === 'image' ? node : null;
    }

    default:
      return null;
  }
}

function inlineContentOf(value: Record<string, unknown>): InlineNode[] {
  const raw = Array.isArray(value.content) ? value.content : [];
  return raw
    .map(inlineNodeFromPm)
    .filter((node): node is InlineNode => node !== null);
}

/** Concatenate every text child, so a node split across runs is not truncated. */
function textContentOf(value: Record<string, unknown>): string {
  if (typeof value.text === 'string') return value.text;
  if (!Array.isArray(value.content)) return '';

  let joined = '';
  for (const child of value.content) {
    if (isRecord(child) && child.type === nodeNames.text && typeof child.text === 'string') {
      joined += child.text;
    }
  }
  return joined;
}

/** Read a live ProseMirror document back into the model's shape. */
export function inlineDocFromEditor(doc: PMNode): InlineDoc {
  return inlineDocFromPm(doc.toJSON());
}

export function blockDocFromEditor(doc: PMNode): BlockDoc {
  return blockDocFromPm(doc.toJSON());
}

/**
 * Convert a notes body into ProseMirror JSON.
 *
 * The inverse of `blockDocFromPm`. It exists because opening a node's notes needs real
 * content in the editor: `EditorState.create` with an empty document would show an
 * empty panel no matter what the student had written, and saving on the first keystroke
 * would then replace their notes with a blank.
 *
 * Blocks the block schema cannot express are dropped rather than approximated. A
 * corrupt node then renders as slightly short, instead of throwing during mount and
 * taking the panel down with it.
 */
export function blockDocToPm(doc: BlockDoc, schema: Schema): PMNode {
  const content = doc.content
    .map((block) => blockNodeToPm(block, schema))
    .filter((node): node is PMNode => node !== null && node !== undefined);

  // ProseMirror rejects a schema whose content expression forbids empty documents, so
  // an empty notes body starts as one empty paragraph.
  if (content.length === 0) {
    const paragraph = schema.nodes[nodeNames.paragraph];
    if (paragraph) content.push(paragraph.create());
  }

  // Built through `topNodeType` rather than a JSON round-trip: the content is already
  // in ProseMirror's shape, and `fromJSON` would mean validating and rebuilding
  // everything only to throw the result away.
  return schema.topNodeType.create(null, content);
}

function blockNodeToPm(block: BlockNode, schema: Schema): PMNode | null {
  const { nodes } = schema;

  switch (block.type) {
    case 'paragraph': {
      const type = nodes[nodeNames.paragraph];
      return type ? type.create(null, inlineContentToPm(block.content ?? [], schema)) : null;
    }

    case 'heading': {
      const type = nodes[nodeNames.heading];
      const level = Math.min(6, Math.max(1, block.attrs.level));
      return type ? type.create({ level }, inlineContentToPm(block.content ?? [], schema)) : null;
    }

    case 'bullet_list':
    case 'ordered_list':
    case 'list_item':
    case 'blockquote': {
      const name = {
        bullet_list: nodeNames.bulletList,
        ordered_list: nodeNames.orderedList,
        list_item: nodeNames.listItem,
        blockquote: nodeNames.blockquote,
      }[block.type];
      const type = nodes[name];
      return type ? type.create(null, blockContentToPm(block.content, schema)) : null;
    }

    case 'code_block': {
      const type = nodes[nodeNames.codeBlock];
      return type ? type.create(null, block.text ? schema.text(block.text) : undefined) : null;
    }

    case 'math_display': {
      const type = nodes[nodeNames.mathDisplay];
      // `math_display` is declared `content: 'text*'` with no attrs, so the LaTeX is
      // the node's text child. Passing it as an attribute would be silently discarded
      // by ProseMirror's attribute computation and the formula would come back empty.
      return type ? type.create(null, block.latex ? schema.text(block.latex) : undefined) : null;
    }

    case 'image': {
      const type = nodes[nodeNames.image];
      // Images reference a document asset rather than a path, so nothing is resolved
      // here: the panel shows the asset once the container has written it to disk.
      return type ? type.create({ assetId: block.assetId, alt: block.alt ?? '' }) : null;
    }
  }

  // A block the schema cannot express is dropped, not returned as undefined: a
  // loose undefined passes an !== null filter and then throws on first use,
  // which would take the whole notes panel down rather than shortening one node.
  return null;
}

function blockContentToPm(content: readonly BlockNode[], schema: Schema): PMNode[] {
  return content
    .map((block) => blockNodeToPm(block, schema))
    .filter((node): node is PMNode => node !== null && node !== undefined);
}

/** Inline content is shared between the two schemas, so this handles both. */
function inlineContentToPm(content: readonly InlineNode[], schema: Schema): PMNode[] {
  return content
    .map((node) => inlineNodeToPm(node, schema))
    .filter((n): n is PMNode => n !== null);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}