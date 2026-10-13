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

import { Node as PMNode, type Schema } from 'prosemirror-model';
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
 * `prosemirror-math` keeps it as node text. The `latex` attribute form is also
 * accepted so that content pasted from elsewhere, or written by a future build,
 * still converts.
 */
function mathLatexOf(value: Record<string, unknown>): string | null {
  if (typeof value.text === 'string') return value.text;
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
  const content: PMNode[] = [];

  for (const node of doc.content) {
    const converted = inlineNodeToPm(node, schema);
    if (converted) content.push(converted);
  }

  return schema.nodes.doc.create(null, content);
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
      return { type: 'code_block', text: typeof value.text === 'string' ? value.text : '' };

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

/** Read a live ProseMirror document back into the model's shape. */
export function inlineDocFromEditor(doc: PMNode): InlineDoc {
  return inlineDocFromPm(doc.toJSON());
}

export function blockDocFromEditor(doc: PMNode): BlockDoc {
  return blockDocFromPm(doc.toJSON());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}