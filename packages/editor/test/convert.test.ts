import { describe, expect, it } from 'vitest';
import { undo } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import type { InlineDoc } from '@adnota/core';
import {
  LOCAL_ORIGIN,
  REMOTE_ORIGIN,
  markRemote,
  blockDocFromPm,
  createEditorState,
  inlineDocFromPm,
  inlineDocToPm,
  inlineSchema,
  nodeNames,
} from '@adnota/editor';

describe('inline conversion', () => {
  it('round-trips plain text', () => {
    const doc: InlineDoc = { type: 'doc', content: [{ type: 'text', text: 'Mitochondria' }] };
    const pm = inlineDocToPm(doc, inlineSchema);
    expect(inlineDocFromPm(pm.toJSON())).toEqual(doc);
  });

  it('round-trips an empty label', () => {
    const doc: InlineDoc = { type: 'doc', content: [] };
    const pm = inlineDocToPm(doc, inlineSchema);
    expect(inlineDocFromPm(pm.toJSON())).toEqual(doc);
  });

  it('round-trips inline LaTeX mixed with text', () => {
    const doc: InlineDoc = {
      type: 'doc',
      content: [
        { type: 'text', text: 'where ' },
        { type: 'math_inline', latex: String.raw`\int_0^1 x^2\,dx` },
        { type: 'text', text: ' = 1/3' },
      ],
    };

    const pm = inlineDocToPm(doc, inlineSchema);
    expect(inlineDocFromPm(pm.toJSON())).toEqual(doc);
  });

  it('round-trips marks', () => {
    const doc: InlineDoc = {
      type: 'doc',
      content: [{ type: 'text', text: 'important', marks: [{ type: 'strong' }] }],
    };
    expect(inlineDocFromPm(inlineDocToPm(doc, inlineSchema).toJSON())).toEqual(doc);
  });

  it('round-trips several marks on one run', () => {
    const doc: InlineDoc = {
      type: 'doc',
      content: [
        { type: 'text', text: 'both', marks: [{ type: 'strong' }, { type: 'em' }] },
      ],
    };
    expect(inlineDocFromPm(inlineDocToPm(doc, inlineSchema).toJSON())).toEqual(doc);
  });

  it('stores LaTeX as node text, which is what prosemirror-math renders from', () => {
    const pm = inlineDocToPm(
      { type: 'doc', content: [{ type: 'math_inline', latex: 'x^2' }] },
      inlineSchema,
    );

    const mathNode = pm.firstChild;
    expect(mathNode?.type.name).toBe(nodeNames.mathInline);
    // The library's MathView renders `node.textContent`, so anything else would
    // render as an empty formula.
    expect(mathNode?.textContent).toBe('x^2');
  });

  it('drops marks it does not recognise rather than persisting them', () => {
    // A document written by a newer build must still load without corrupting the run.
    const result = inlineDocFromPm({
      type: 'doc',
      content: [
        { type: 'text', text: 'styled', marks: [{ type: 'strong' }, { type: 'rainbow' }] },
      ],
    });

    expect(result.content[0]).toEqual({ type: 'text', text: 'styled', marks: [{ type: 'strong' }] });
  });

  it('drops an unapplied mark encoded as strong="false"', () => {
    const result = inlineDocFromPm({
      type: 'doc',
      content: [
        { type: 'text', text: 'plain', marks: [{ type: 'strong', attrs: { on: false } }] },
      ],
    });

    expect(result.content[0]).toEqual({ type: 'text', text: 'plain' });
  });

  it('ignores nodes it does not recognise', () => {
    const result = inlineDocFromPm({
      type: 'doc',
      content: [
        { type: 'text', text: 'keep' },
        { type: 'some_future_node', payload: 1 },
        { type: 'math_inline', text: 'x' },
      ],
    });

    expect(result.content).toEqual([
      { type: 'text', text: 'keep' },
      { type: 'math_inline', latex: 'x' },
    ]);
  });

  it('drops an image with no asset reference', () => {
    // An image pointing at nothing would render as a broken placeholder.
    const result = inlineDocFromPm({
      type: 'doc',
      content: [{ type: 'image', attrs: { assetId: '' } }],
    });

    expect(result.content).toEqual([]);
  });

  it('round-trips an image with its asset reference', () => {
    const doc: InlineDoc = { type: 'doc', content: [{ type: 'image', assetId: 'a1', alt: 'diagram' }] };
    expect(inlineDocFromPm(inlineDocToPm(doc, inlineSchema).toJSON())).toEqual(doc);
  });

  it('survives garbage input', () => {
    for (const value of [null, undefined, 42, 'text', [], { type: 7 }]) {
      expect(() => inlineDocFromPm(value)).not.toThrow();
      expect(inlineDocFromPm(value)).toEqual({ type: 'doc', content: [] });
    }
  });
});

describe('notes body conversion', () => {
  it('reads paragraphs, headings and lists', () => {
    const result = blockDocFromPm({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
        {
          type: 'bullet_list',
          content: [
            {
              type: 'list_item',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
      ],
    });

    expect(result.content).toHaveLength(3);
    expect(result.content[0]).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Title' }],
    });
    expect(result.content[2]?.type).toBe('bullet_list');
  });

  it('reads display maths', () => {
    const result = blockDocFromPm({
      type: 'doc',
      content: [{ type: 'math_display', text: String.raw`\sum_{i=1}^{n} i` }],
    });

    expect(result.content[0]).toEqual({ type: 'math_display', latex: String.raw`\sum_{i=1}^{n} i` });
  });

  it('defaults a heading with no level to 1 rather than dropping it', () => {
    const result = blockDocFromPm({
      type: 'doc',
      content: [{ type: 'heading', content: [{ type: 'text', text: 'x' }] }],
    });

    expect(result.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
  });
});

describe('editor state', () => {
  it('creates from a document', () => {
    const state = createEditorState({
      doc: { type: 'doc', content: [{ type: 'text', text: 'Cell' }] },
    });

    expect(state.doc.textContent).toBe('Cell');
  });

  it('accepts an ordinary local transaction', () => {
    const state = createEditorState({
      doc: { type: 'doc', content: [{ type: 'text', text: 'Cell' }] },
    });

    expect(state.apply(state.tr.insertText('s', 4)).doc.textContent).toBe('Cells');
  });

  it('accepts a selection-only transaction', () => {
    // Moving the caret changes no content, so it must never be blocked.
    const state = createEditorState({
      doc: { type: 'doc', content: [{ type: 'text', text: 'Cell' }] },
    });

    const move = state.tr.setSelection(TextSelection.create(state.doc, 0, 4));
    expect(move.docChanged).toBe(false);
    expect(() => state.apply(move)).not.toThrow();
  });

  it('keeps a collaborator change out of the local undo history', () => {
    // The requirement is not that remote changes are rejected, but that Ctrl+Z does
    // not revert someone else's work. A remote change is therefore applied normally
    // and only excluded from history.
    const state = createEditorState({
      doc: { type: 'doc', content: [{ type: 'text', text: 'Cell' }] },
    });

    let current = state.apply(state.tr.insertText('s', 4));

    // A collaborator adds a character, marked remote.
    const remote = markRemote(current.tr.insertText('!', current.doc.content.size));
    current = current.apply(remote);
    expect(current.doc.textContent).toBe('Cells!');

    // `undo` is a Command, so it reports success rather than returning a state. With
    // no EditorView to dispatch through, the transaction has to be captured by hand.
    const undone = undo(current, (tr) => {
      current = current.apply(tr);
    });

    expect(undone).toBe(true);
    // One undo reverts the local edit and leaves the collaborator's character in place.
    expect(current.doc.textContent).toBe('Cell!');
  });

  it('exposes distinct meta keys for local and remote transactions', () => {
    // The keymap is the only place that dispatches with this origin, so assert that
    // the symbol is exported and usable rather than trying to reach into a keystroke.
    expect(typeof LOCAL_ORIGIN).toBe('string');
    expect(typeof REMOTE_ORIGIN).toBe('string');
    expect(LOCAL_ORIGIN).not.toBe(REMOTE_ORIGIN);
  });
});