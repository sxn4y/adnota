/**
 * Sample document.
 *
 * A realistic lecture mindmap, used by the development harness and by the visual
 * regression tests. It deliberately includes the cases that have historically broken
 * renderers: inline math mixed with text, display math, a long label that needs to
 * wrap, an empty node, and LaTeX that does not parse.
 */

import {
  createDoc,
  createNode,
  setLabel,
  type InlineDoc,
  type NodeId,
  type YDoc,
} from '@adnota/core';

function text(value: string): InlineDoc {
  return { type: 'doc', content: [{ type: 'text', text: value }] };
}

function withMath(before: string, latex: string, after = ''): InlineDoc {
  return {
    type: 'doc',
    content: [
      { type: 'text', text: before },
      { type: 'math_inline', latex },
      ...(after ? [{ type: 'text' as const, text: after }] : []),
    ],
  };
}

export interface SampleTree {
  readonly rootId: NodeId;
}

export function buildSampleDocument(): { doc: YDoc; rootId: NodeId } {
  const doc = createDoc('Week 3 — Integration');

  const rootId = createNode(doc, { parentId: 'root' });
  setLabel(doc, rootId, text('Integration'));

  const definite = createNode(doc, { parentId: rootId });
  setLabel(doc, definite, text('Definite'));

  const fundamental = createNode(doc, { parentId: definite });
  setLabel(doc, fundamental, withMath('Fundamental theorem: ', String.raw`\int_a^b f(x)\,dx = F(b) - F(a)`));

  const byParts = createNode(doc, { parentId: definite });
  setLabel(doc, byParts, withMath('By parts: ', String.raw`\int u\,dv = uv - \int v\,du`));

  const improper = createNode(doc, { parentId: rootId });
  setLabel(doc, improper, text('Improper'));

  const converges = createNode(doc, { parentId: improper });
  setLabel(doc, converges, withMath('Converges when ', String.raw`\lim_{b\to\infty} \int_a^b f = L`));

  const diverges = createNode(doc, { parentId: improper });
  setLabel(doc, diverges, withMath('e.g. ', String.raw`\int_1^\infty \frac{1}{x}\,dx`));

  const substitutions = createNode(doc, { parentId: rootId });
  setLabel(
    doc,
    substitutions,
    text('Substitutions — this label is deliberately long so that wrapping and line height get exercised'),
  );

  const trig = createNode(doc, { parentId: substitutions });
  setLabel(doc, trig, withMath('For ', String.raw`x = 3\sin\theta`, ':  '));

  const volume = createNode(doc, { parentId: rootId });
  setLabel(doc, volume, withMath('Volume of revolution: ', String.raw`V = \pi \int_a^b [f(x)]^2\,dx`));

  // An intentionally broken expression. A student typing will produce these constantly
  // and the canvas must stay legible.
  const broken = createNode(doc, { parentId: rootId });
  setLabel(doc, broken, withMath('Draft: ', String.raw`\frac{1}{`));

  return { doc, rootId };
}
