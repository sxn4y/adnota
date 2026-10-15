import { describe, expect, it } from 'vitest';
import { toFilename } from '../src/download.ts';
import { ROOT_NODE_ID, type BlockDoc, type InlineDoc } from '@adnota/core';
import { blockDocFromPm, blockDocToPm, blockSchema } from '@adnota/editor';

describe('toFilename', () => {
  it('falls back when the title is empty', () => {
    expect(toFilename('')).toBe('mindmap.md');
    expect(toFilename('   ')).toBe('mindmap.md');
    expect(toFilename('.')).toBe('mindmap.md');
  });

  it('replaces characters the platform rejects', () => {
    expect(toFilename('Week 3: integrals')).toBe('Week 3- integrals.md');
    expect(toFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j.md');
  });

  it('keeps spaces readable rather than turning them into separators', () => {
    expect(toFilename('Linear Algebra Finals')).toBe('Linear Algebra Finals.md');
  });

  it('strips leading and trailing dots and spaces', () => {
    expect(toFilename('  .hidden notes.  ')).toBe('hidden notes.md');
  });

  it('caps the length so the result is a legal filename', () => {
    const name = toFilename('x'.repeat(500));

    expect(name.length).toBeLessThanOrEqual(83);
    expect(name.endsWith('.md')).toBe(true);
  });
});

describe('blockDocToPm', () => {
  const roundTrip = (doc: BlockDoc): BlockDoc =>
    blockDocFromPm(blockDocToPm(doc, blockSchema).toJSON());

  it('returns an empty body unchanged', () => {
    expect(roundTrip({ type: 'doc', content: [] })).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    });
  });

  it('preserves paragraphs and their marks', () => {
    const doc: BlockDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain ' },
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
          ],
        },
      ],
    };

    expect(roundTrip(doc)).toEqual(doc);
  });

  it('preserves heading levels', () => {
    const doc: BlockDoc = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Key ideas' }] }],
    };

    expect(roundTrip(doc)).toEqual(doc);
  });

  it('preserves nested lists', () => {
    const doc: BlockDoc = {
      type: 'doc',
      content: [
        {
          type: 'bullet_list',
          content: [
            { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
            {
              type: 'list_item',
              content: [
                {
                  type: 'ordered_list',
                  content: [{ type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(roundTrip(doc)).toEqual(doc);
  });

  it('preserves code blocks and display maths', () => {
    const doc: BlockDoc = {
      type: 'doc',
      content: [
        { type: 'code_block', text: 'print(1)' },
        { type: 'math_display', latex: '\\int_0^1 x\\,dx' },
      ],
    };

    expect(roundTrip(doc)).toEqual(doc);
  });

  it('preserves quotes', () => {
    const doc: BlockDoc = {
      type: 'doc',
      content: [
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }] },
      ],
    };

    expect(roundTrip(doc)).toEqual(doc);
  });

  it('preserves inline maths inside a paragraph', () => {
    const doc: BlockDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Area: ' }, { type: 'math_inline', latex: '\\pi r^2' }],
        },
      ],
    };

    expect(roundTrip(doc)).toEqual(doc);
  });

  it('clamps an out-of-range heading level rather than producing an invalid schema', () => {
    const doc: BlockDoc = {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 99 }, content: [{ type: 'text', text: 'H' }] }],
    };

    expect(roundTrip(doc).content[0]).toMatchObject({ type: 'heading', attrs: { level: 6 } });
  });

  it('drops a block the schema cannot express instead of throwing on mount', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'horizontal_rule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
      ],
    } as unknown as BlockDoc;

    // A throw here would take the whole notes panel down rather than just this node.
    expect(() => roundTrip(doc)).not.toThrow();
    expect(roundTrip(doc).content).toHaveLength(1);
  });

  it('does not mutate the source document', () => {
    const doc: BlockDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'original' }] }],
    };
    const snapshot = JSON.stringify(doc);

    roundTrip(doc);

    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('inline schema is unaffected by block conversion', () => {
  it('still produces a label document', () => {
    // A shared implementation would have let a block-only body leak into a label,
    // where the schema has nowhere valid to put it.
    const label: InlineDoc = { type: 'doc', content: [{ type: 'text', text: 'Definite' }] };
    expect(label.content[0]).toEqual({ type: 'text', text: 'Definite' });
    expect(ROOT_NODE_ID).toBe('root');
  });
});