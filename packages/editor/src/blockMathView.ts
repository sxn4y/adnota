/**
 * Node view for display maths in a notes body.
 *
 * Replaces the one `prosemirror-math` provides, which was unusable in practice:
 *
 *   - it renders typeset output only while the node is *not* selected, but keeps a
 *     `NodeSelection` on it for as long as the student is typing, and clicking away
 *     moves focus without moving the selection — so the formula sat as raw LaTeX with
 *     no reliable way to leave it;
 *   - it carried an `empty-math` class that outlived the content being committed, so
 *     the rendered pane stayed blank even once the LaTeX was in the document;
 *   - typing a formula puts the caret in a nested contenteditable, which is a separate
 *     editor whose keydowns never reach the surrounding one's plugins.
 *
 * All three are properties of that node view rather than of the maths library's parsing,
 * so replacing it is enough. The LaTeX itself is still produced and typeset by
 * KaTeX through `@adnota/scene`, so there is only ever one maths renderer in the app.
 *
 * Editing is a plain input rather than an inline editor: a formula is entered as a
 * whole, and a nested contenteditable buys nothing for that.
 */

import { NodeSelection, TextSelection } from 'prosemirror-state';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { renderMath } from '@adnota/scene';

const MATH_PREFIX = 'math';

/** The LaTeX of a display-math node: its text content, by the schema. */
function latexOf(node: PMNode): string {
  return node.textContent;
}

export const blockMathNodeView: NodeViewConstructor = (
  node,
  view,
  getPos,
): NodeView => {
  const dom = document.createElement('div');
  dom.className = 'adnota-notes-math';
  dom.setAttribute('data-math', 'display');

  let current = node;
  let editing = false;
  let input: HTMLInputElement | null = null;

  const isSelected = (): boolean => {
    const pos = getPos();
    if (typeof pos !== 'number') return false;

    const { selection } = view.state;
    return selection instanceof NodeSelection && selection.from <= pos && pos < selection.to;
  };

  /** Write new LaTeX into the document as a single local transaction. */
  const commit = (latex: string): void => {
    const pos = getPos();
    if (typeof pos !== 'number') return;

    const tr = view.state.tr.replaceWith(pos, pos + current.nodeSize, current.type.create(null, latex ? view.state.schema.text(latex) : undefined));
    tr.setMeta('addToHistory', true);
    view.dispatch(tr);
  };

  const stopEditing = (): void => {
    if (!editing) return;
    editing = false;
    input = null;
    render();
  };

  const startEditing = (): void => {
    if (editing) return;
    editing = true;
    render();

    input?.focus();
    input?.select();
  };

  const render = (): void => {
    const latex = latexOf(current);
    // Editing is required for an empty node (there is nothing to show) and while the
    // node is selected, but not otherwise.
    const shouldEdit = editing || isSelected() || latex.length === 0;

    dom.replaceChildren();

    if (shouldEdit) {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'adnota-notes-math-input';
      input.value = latex;
      input.setAttribute('aria-label', 'Display formula (LaTeX)');
      input.spellcheck = false;
      input.placeholder = '\\int_0^1 x\\,dx';

      input.addEventListener('input', () => commit(input?.value ?? ''));

      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;

        // Handled here rather than through the editor's Escape plugin: `stopEvent`
        // below tells ProseMirror to ignore events originating in this input, which is
        // what stops typing a `k` from inserting a character into the document, and it
        // also means the plugin never sees this keystroke.
        event.preventDefault();
        event.stopPropagation();

        // Moving the selection off the node is what lets it render typeset.
        const pos = getPos();
        if (typeof pos === 'number') {
          const after = Math.min(pos + current.nodeSize, view.state.doc.content.size);
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.near(view.state.doc.resolve(after)))
              .setMeta('addToHistory', false),
          );
        }

        editing = false;
        render();
      });

      input.addEventListener('blur', () => stopEditing());

      dom.appendChild(input);
      if (latex.length === 0) queueMicrotask(() => input?.focus());
      return;
    }

    const result = renderMath(latex, { display: 'block' });

    if (result.failed) {
      // KaTeX failed. Showing the student's own source is what they need in order to
      // fix it; an error glyph tells them nothing actionable.
      const fallback = document.createElement('code');
      fallback.className = 'adnota-notes-math-fallback';
      fallback.textContent = `$$${latex}$`;
      dom.appendChild(fallback);
      return;
    }

    const output = document.createElement('div');
    output.className = 'adnota-notes-math-render';
    output.innerHTML = result.html;
    output.setAttribute('aria-label', result.accessibleLabel);
    dom.appendChild(output);
  };

  dom.addEventListener('dblclick', () => startEditing());

  render();

  return {
    dom,
    // Selecting the node is how the student asks to edit it, which the library's view
    // handled inconsistently and this one handles explicitly.
    selectNode: () => render(),
    deselectNode: () => {
      // An empty formula stays editable until the student types something, or there is
      // nothing at all to show.
      stopEditing();
    },
    update: (updated) => {
      if (updated.type.name !== current.type.name || updated.type.name.indexOf(MATH_PREFIX) !== 0) {
        return false;
      }
      current = updated;
      render();
      return true;
    },
    stopEvent: (event) => event.target instanceof HTMLInputElement,
    ignoreMutation: (mutation) => mutation.type === 'selection',
    destroy: () => {
      dom.replaceChildren();
    },
  };
};

/** Only display maths is replaced; inline maths keeps the library's inline behaviour. */
export function isBlockMathType(name: string): boolean {
  return name === 'math_display';
}
