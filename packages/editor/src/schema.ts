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

const nodes = {
  /**
   * The inline container used for a node's canvas label.
   *
   * `inline*` rather than a paragraph wrapper: a label is one visual run that wraps,
   * and a block inside it would make measurement and caret handling harder for no gain.
   */
  doc: { content: 'inline*' } satisfies NodeSpec,

  /**
   * An image inside a label, rendered as a thumbnail.
   *
   * Atoms carry an `assetId`; the bytes live in the container, not the document.
   */
  image: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: {
      assetId: { default: '' },
      alt: { default: null },
    },
    // No real NodeView yet, so the DOM here is the placeholder the editor shows until
    // the asset pipeline lands. It must round-trip through `data-` attributes or pasted
    // content would lose its asset reference.
    toDOM: (node) => [
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
        getAttrs: (dom) => ({
          assetId: (dom as HTMLElement).getAttribute('data-asset-id') ?? '',
          alt: (dom as HTMLElement).getAttribute('data-alt') || null,
        }),
      },
    ],
  } satisfies NodeSpec,

  ...(mathSchemaSpec.nodes ?? {}),
} as const;

/** Schema for inline content: a node's canvas label. */
export const inlineSchema = new Schema({
  nodes: nodes as never,
  marks: marks as never,
});

export const nodeNames = {
  doc: 'doc',
  text: 'text',
  mathInline: 'math_inline',
  mathDisplay: 'math_display',
  image: 'image',
} as const;

export const markNames = {
  strong: 'strong',
  em: 'em',
  code: 'code',
  strike: 'strike',
} as const;