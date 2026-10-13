/**
 * ProseMirror schema for node labels and notes bodies.
 *
 * ## Why there is a conversion layer
 *
 * ProseMirror stores a formula's LaTeX as the math node's *text content*, because it
 * renders that node with a live KaTeX view and needs the source under the cursor. The
 * document model stores it as a `latex` *attribute* instead.
 *
 * That difference is deliberate. The `.adnota` file is a durable format that will
 * outlive whichever editor we ship, and shaping it around an editor library's internal
 * node representation would tie the file format to a dependency we may well replace.
 * Twenty lines of conversion is cheap insurance; rewriting the format is not.
 *
 * The maths nodes themselves are taken from `prosemirror-math` rather than redefined,
 * so the input rules and the editing behaviour stay in step with its renderer.
 */

import { mathSchemaSpec } from '@benrbray/prosemirror-math';
import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model';

const marks = {
  strong: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    toDOM: () => ['strong', 0],
  } satisfies MarkSpec,

  em: {
    parseDOM: [{ tag: 'i' }, { tag: 'em' }],
    toDOM: () => ['em', 0],
  } satisfies MarkSpec,

  code: {
    parseDOM: [{ tag: 'code' }],
    toDOM: () => ['code', 0],
  } satisfies MarkSpec,

  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }],
    toDOM: () => ['s', 0],
  } satisfies MarkSpec,
} as const;

/**
 * An image inside a label, rendered as a thumbnail.
 *
 * Atoms carry an `assetId`; the bytes live in the container, not the document. The
 * DOM form round-trips through `data-` attributes so that pasted content does not
 * lose its asset reference.
 */
const imageNode = {
  inline: true,
  group: 'inline',
  atom: true,
  attrs: {
    assetId: { default: '' },
    alt: { default: null },
  },
  toDOM: (node: { attrs: Record<string, unknown> }) => [
    'span',
    {
      'data-asset-id': String(node.attrs.assetId ?? ''),
      'data-alt': String(node.attrs.alt ?? ''),
      class: 'adnota-inline-image',
    },
    'image',
  ],
  parseDOM: [
    {
      tag: 'span[data-asset-id]',
      getAttrs: (dom: HTMLElement) => ({
        assetId: dom.getAttribute('data-asset-id') ?? '',
        alt: dom.getAttribute('data-alt') || null,
      }),
    },
  ],
} satisfies NodeSpec;

const mathNodes = mathSchemaSpec.nodes ?? {};

/**
 * Schema for a node's canvas label: one inline run that wraps.
 *
 * Deliberately excludes `math_display` and the block nodes. A label is a single
 * visual run, and including a block node it has nowhere valid to live produces a
 * schema that rejects its own documents.
 */
export const inlineSchema = new Schema({
  nodes: {
    doc: { content: 'inline*' },
    text: { group: 'inline' },
    math_inline: mathNodes.math_inline ?? {},
    image: imageNode,
  } as never,
  marks: marks as never,
});

/**
 * Schema for a node's notes body: the block document.
 *
 * Kept separate from the inline schema because the two disagree about the top-level
 * container. Sharing one schema and overriding `doc` produced a schema whose
 * `math_display` had no valid position, which ProseMirror reports only at insertion
 * time rather than at construction.
 */
export const blockSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
        tag: `h${level}`,
        attrs: { level },
      })),
      toDOM: (node: { attrs: Record<string, unknown> }) => [
        `h${Math.min(6, Math.max(1, Number(node.attrs.level) || 1))}`,
        0,
      ],
    },
    bullet_list: {
      content: 'list_item+',
      group: 'block',
      parseDOM: [{ tag: 'ul' }],
      toDOM: () => ['ul', 0],
    },
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { order: { default: 1 } },
      parseDOM: [{ tag: 'ol' }],
      toDOM: () => ['ol', 0],
    },
    list_item: { content: 'block+', defining: true, parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
    blockquote: {
      content: 'block+',
      group: 'block',
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0],
    },
    code_block: {
      content: 'text*',
      marks: '',
      group: 'block',
      code: true,
      defining: true,
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: () => ['pre', ['code', 0]],
    },
    text: { group: 'inline' },
    math_inline: mathNodes.math_inline ?? {},
    math_display: mathNodes.math_display ?? {},
    image: imageNode,
  } as never,
  marks: marks as never,
});

export const nodeNames = {
  doc: 'doc',
  paragraph: 'paragraph',
  text: 'text',
  mathInline: 'math_inline',
  mathDisplay: 'math_display',
  image: 'image',
  codeBlock: 'code_block',
  blockquote: 'blockquote',
  bulletList: 'bullet_list',
  orderedList: 'ordered_list',
  listItem: 'list_item',
  heading: 'heading',
} as const;

export const markNames = {
  strong: 'strong',
  em: 'em',
  code: 'code',
  strike: 'strike',
} as const;