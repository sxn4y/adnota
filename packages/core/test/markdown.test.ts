import { describe, expect, it } from 'vitest';
import {
  ROOT_NODE_ID,
  createDoc,
  createNode,
  search,
  setCollapsed,
  setLabel,
  setNotes,
  setTitle,
  snippetAround,
  toMarkdown,
  toOutline,
  toPlainText,
  type BlockDoc,
  type InlineDoc,
} from '@adnota/core';

function label(text: string): InlineDoc {
  return { type: 'doc', content: [{ type: 'text', text }] };
}

function mathLabel(before: string, latex: string, after = ''): InlineDoc {
  return {
    type: 'doc',
    content: [
      { type: 'text', text: before },
      { type: 'math_inline', latex },
      { type: 'text', text: after },
    ],
  };
}

/** A small tree used by most tests:
 *
 *   Calculus
 *     Limits
 *       Definite integrals
 *     Volume of revolution
 */
function tree(): ReturnType<typeof createDoc> {
  const doc = createDoc('Calculus');
  const root = createNode(doc, { parentId: ROOT_NODE_ID, label: label('Calculus') });
  const limits = createNode(doc, { parentId: root, label: label('Limits') });
  createNode(doc, { parentId: limits, label: label('Definite integrals') });
  createNode(doc, { parentId: root, label: label('Volume of revolution') });
  return doc;
}

describe('toMarkdown', () => {
  it('nests bullets to match the tree, not the layout', () => {
    const markdown = toMarkdown(tree());

    expect(markdown).toBe(
      ['- Calculus', '  - Limits', '    - Definite integrals', '  - Volume of revolution', ''].join('\n'),
    );
  });

  it('emits a title only when asked', () => {
    const doc = tree();

    expect(toMarkdown(doc)).not.toContain('# ');
    expect(toMarkdown(doc, { includeTitle: true })).toContain('# Calculus');
  });

  it('keeps maths as LaTeX so it round-trips', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID, label: label('Formula') });
    const child = createNode(doc, { parentId: root, label: mathLabel('Area: ', 'A = \\int_0^b f(x)\\,dx') });

    const markdown = toMarkdown(doc);

    expect(markdown).toContain('$A = \\int_0^b f(x)\\,dx$');
    expect(child).toBeTruthy();
  });

  it('escapes a dollar inside a formula so the delimiter does not close early', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: root, label: mathLabel('', 'x = $5') });

    // An unescaped `$` would end the maths span at the wrong place and the rest of
    // the formula would be imported as literal text.
    expect(toMarkdown(doc)).toContain('$x = \\$5$');
  });

  it('escapes characters that would otherwise start Markdown structure', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: root, label: label('# not a heading *not emphasis*') });

    const markdown = toMarkdown(doc);

    expect(markdown).toContain('\\# not a heading');
    // Emphasis inside prose is left alone: escaping every asterisk would be noise.
    expect(markdown).toContain('emphasis*');
  });

  it('escapes angle brackets so re-import cannot open a tag', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: root, label: label('use <script>alert(1)</script>') });

    expect(toMarkdown(doc)).toContain('&lt;script&gt;');
  });

  it('exports collapsed branches, because collapse is a view state', () => {
    const doc = tree();
    const limits = doc.getMap('nodes') as never;
    expect(limits).toBeTruthy();

    const [calculus] = toOutline(doc);
    setCollapsed(doc, calculus.id, true);

    // Dropping folded content would be data loss dressed up as a feature.
    expect(toMarkdown(doc)).toContain('Definite integrals');
  });

  it('keeps an empty node so the outline shows where work is missing', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: root });

    expect(toMarkdown(doc)).toBe('-\n  -\n');
  });

  it('includes notes bodies only on request', () => {
    const doc = tree();
    const [calculus] = toOutline(doc);
    const notes: BlockDoc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Key ideas' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Everything rests on limits.' }] },
      ],
    };
    setNotes(doc, calculus.id, notes);

    expect(toMarkdown(doc)).not.toContain('Key ideas');

    const withNotes = toMarkdown(doc, { includeNotes: true });
    expect(withNotes).toContain('  ## Key ideas');
    expect(withNotes).toContain('  Everything rests on limits.');
  });

  it('emits display maths in notes', () => {
    const doc = tree();
    const [calculus] = toOutline(doc);
    setNotes(doc, calculus.id, {
      type: 'doc',
      content: [{ type: 'math_display', latex: '\\int_0^1 x\\,dx' }],
    });

    expect(toMarkdown(doc, { includeNotes: true })).toContain('$$\\int_0^1 x\\,dx$$');
  });

  it('ends with a single trailing newline', () => {
    const markdown = toMarkdown(tree());
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown.endsWith('\n\n')).toBe(false);
  });
});

describe('toOutline', () => {
  it('reports depth by tree level and preserves document order', () => {
    expect(toOutline(tree()).map((e) => [e.depth, e.text])).toEqual([
      [0, 'Calculus'],
      [1, 'Limits'],
      [2, 'Definite integrals'],
      [1, 'Volume of revolution'],
    ]);
  });

  it('respects collapse, unlike the Markdown export', () => {
    const doc = tree();
    const [, limits] = toOutline(doc);
    setCollapsed(doc, limits.id, true);

    // The outline mirrors what is on screen; the export mirrors what is stored.
    expect(toOutline(doc).map((e) => e.text)).toEqual(['Calculus', 'Limits', 'Volume of revolution']);
  });
});

describe('search', () => {
  it('matches case-insensitively', () => {
    expect(search(tree(), 'DEFINITE')).toHaveLength(1);
    expect(search(tree(), 'definite')).toHaveLength(1);
  });

  it('returns nothing for an empty or whitespace query', () => {
    expect(search(tree(), '')).toEqual([]);
    expect(search(tree(), '   ')).toEqual([]);
  });

  it('ranks a title match above a body match', () => {
    const doc = tree();
    setNotes(doc, toOutline(doc)[0].id, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'About the volume topic.' }] }],
    });

    const hits = search(doc, 'volume', { includeMath: true });

    expect(hits[0]?.node.id).toBe(toOutline(doc)[3]?.id);
  });

  it('ranks a label prefix above a match buried mid-label', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: root, label: label('intro to calculus') });
    createNode(doc, { parentId: root, label: label('advanced topics') });

    const hits = search(doc, 'intro');

    expect(hits).toHaveLength(1);
    expect(hits[0]?.node.id).toBeTruthy();
  });

  it('finds text in notes only when maths-inclusive search is on', () => {
    const doc = tree();
    setNotes(doc, toOutline(doc)[1].id, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'sandwich theorem' }] }],
    });

    expect(search(doc, 'sandwich')).toEqual([]);
    expect(search(doc, 'sandwich', { includeMath: true })).toHaveLength(1);
  });

  it('honours the result limit', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    for (let i = 0; i < 20; i += 1) createNode(doc, { parentId: root, label: label(`topic ${i}`) });

    expect(search(doc, 'topic')).toHaveLength(20);
    expect(search(doc, 'topic', { limit: 5 })).toHaveLength(5);
  });

  it('is deterministic for equal scores', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    for (let i = 0; i < 6; i += 1) createNode(doc, { parentId: root, label: label('same label') });

    const first = search(doc, 'same').map((h) => h.id);
    const second = search(doc, 'same').map((h) => h.id);

    expect(first).toEqual(second);
  });
});

describe('snippetAround', () => {
  it('returns the whole text when it is already short', () => {
    expect(snippetAround('short text', 0, 5)).toEqual({ text: 'short text', start: 0, length: 5 });
  });

  it('elides with an offset that still points at the match', () => {
    const text = `${'padding '.repeat(20)}TARGET${' more'.repeat(20)}`;
    const index = text.indexOf('TARGET');
    const snippet = snippetAround(text, index, 6);

    expect(snippet.text.startsWith('…')).toBe(true);
    expect(snippet.text.endsWith('…')).toBe(true);
    // The offset must be relative to the snippet, including the elision character,
    // or the highlighter would underline the wrong words.
    expect(snippet.text.slice(snippet.start, snippet.start + snippet.length)).toBe('TARGET');
  });

  it('snaps to word boundaries rather than cutting mid-word', () => {
    const text = `${'alpha beta '.repeat(12)}needle${' gamma delta'.repeat(12)}`;
    const index = text.indexOf('needle');
    const snippet = snippetAround(text, index, 6, 20);

    expect(snippet.text.slice(snippet.start, snippet.start + 6)).toBe('needle');
  });
});

describe('toPlainText', () => {
  it('includes labels, maths, and notes', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID, label: mathLabel('Area ', '\\pi r^2') });
    setNotes(doc, root, {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Derivation follows.' }] },
        { type: 'code_block', text: 'print(1)' },
      ],
    });

    const text = toPlainText(doc);

    expect(text).toContain('Area \\pi r^2');
    expect(text).toContain('Derivation follows.');
    expect(text).toContain('print(1)');
  });
});

describe('document title', () => {
  it('is independent of the root node label', () => {
    const doc = createDoc('Week 3');
    setTitle(doc, 'Week 4');
    const root = createNode(doc, { parentId: ROOT_NODE_ID, label: label('Calculus') });

    expect(root).toBeTruthy();
    expect(toMarkdown(doc, { includeTitle: true })).toContain('# Week 4');
  });
});

describe('label helpers do not mutate shared state', () => {
  it('editing one node leaves its siblings alone', () => {
    const doc = tree();
    const [calculus, limits] = toOutline(doc);

    setLabel(doc, calculus.id, label('Renamed'));
    setLabel(doc, limits.id, label('Also renamed'));

    expect(toMarkdown(doc)).toContain('- Renamed');
    expect(toMarkdown(doc)).toContain('- Also renamed');
    expect(toMarkdown(doc)).not.toContain('- Calculus');
  });
});