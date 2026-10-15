/**
 * Small rendered maths for text panels.
 *
 * The outline and the search palette show node labels, which routinely contain a
 * formula. Rendering them the way the canvas does was a stated gap, and it matters for
 * more than tidiness: a student scanning the outline is looking for the shape of the
 * expression — an integral sign reads instantly, `\int_a^b f(x)\,dx` does not.
 *
 * Reuses `@adnota/scene`'s KaTeX renderer rather than introducing a second maths path,
 * because two renderers would drift on exactly the inputs that are hardest to check.
 */

import { useEffect, useRef } from 'react';
import { renderMath } from '@adnota/scene';
import type { InlineDoc } from '@adnota/core';

/**
 * Plain text of an inline document, with maths reduced to its source.
 *
 * Used for anything that must be searchable, matchable, or a DOM `title`.
 */
export function inlineToPlain(doc: InlineDoc): string {
  return doc.content
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'math_inline':
          return node.latex;
        case 'image':
          return node.alt ?? '';
      }
    })
    .join('');
}

/**
 * Render an inline document into a container, typesetting maths and leaving prose
 * as text.
 *
 * KaTeX is injected as HTML rather than built in React nodes. KaTeX output is a large,
 * deeply nested tree with generated class names; reimplementing it as JSX would be a
 * second maths implementation, and `dangerouslySetInnerHTML` is safe here because the
 * input is the student's own LaTeX passed through KaTeX's own escaping.
 */
export function MathLabel({
  doc,
  className,
  block = false,
}: {
  readonly doc: InlineDoc;
  readonly className?: string;
  readonly block?: boolean;
}): React.JSX.Element {
  const hostRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    host.replaceChildren();

    let sawMath = false;

    for (const node of doc.content) {
      if (node.type === 'text') {
        host.appendChild(document.createTextNode(node.text));
        continue;
      }

      if (node.type === 'image') {
        if (node.alt) host.appendChild(document.createTextNode(node.alt));
        continue;
      }

      sawMath = true;
      const rendered = renderMath(node.latex, { display: block ? 'block' : 'inline' });

      if (rendered.failed) {
        // KaTeX produced an error placeholder rather than a formula. Showing the
        // student's own source is more useful than an error glyph: it is what they
        // need in order to fix it.
        host.appendChild(document.createTextNode(`$${node.latex}$`));
        continue;
      }

      const span = document.createElement('span');
      // KaTeX's own output, already escaped by KaTeX. The alternative — rebuilding its
      // tree as JSX — would be a second maths implementation.
      span.innerHTML = rendered.html;
      span.setAttribute('aria-label', rendered.accessibleLabel);
      host.appendChild(span);
    }

    if (!sawMath && doc.content.length === 0) {
      host.appendChild(document.createTextNode(''));
    }
  }, [doc, block]);

  return <span ref={hostRef} className={className} />;
}
