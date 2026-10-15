/**
 * Outline view.
 *
 * A mindmap is good for building ideas and bad for reading them back. The outline is
 * the same document rendered as a list: it scrolls, it reflows, it works on a phone,
 * and it prints. Students revise from it far more than they read the canvas.
 *
 * It is derived from the live document rather than cached, because a stale outline is
 * worse than no outline: the student would revise against a lie.
 */

import { getChildIds, toOutline, type NodeId, type YDoc } from '@adnota/core';
import { MathLabel } from './MathLabel.tsx';

export interface OutlinePanelProps {
  readonly doc: YDoc;
  readonly revision: number;
  readonly selectedId: NodeId | null;
  readonly onSelect: (id: NodeId) => void;
  readonly onToggleCollapse?: (id: NodeId) => void;
}

export function OutlinePanel({
  doc,
  revision,
  selectedId,
  onSelect,
  onToggleCollapse,
}: OutlinePanelProps): React.JSX.Element {
  // `revision` is the invalidation signal: Yjs mutations do not change identity, so
  // the document alone would not tell React to recompute.
  const entries = revision >= 0 ? toOutline(doc) : [];

  return (
    <div className="adnota-outline" data-testid="outline-panel">
      <ol className="adnota-outline-list">
        {entries.map((entry) => {
          // Children are counted from the document rather than from the outline:
          // a collapsed branch still has children, and hiding its twisty would
          // suggest there is nothing to expand back to.
          const hasChildren = getChildIds(doc, entry.id).length > 0;
          return (
            <li key={entry.id} style={{ '--adnota-depth': entry.depth } as React.CSSProperties}>
              <div
                className={`adnota-outline-row${
                  entry.id === selectedId ? ' is-selected' : ''
                }`}
                data-testid="outline-row"
                data-node-id={entry.id}
                data-depth={entry.depth}
              >
                {hasChildren && onToggleCollapse ? (
                  <button
                    type="button"
                    className="adnota-outline-twisty"
                    aria-label={entry.node.collapsed ? 'Expand' : 'Collapse'}
                    aria-expanded={!entry.node.collapsed}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleCollapse(entry.id);
                    }}
                    data-testid="outline-twisty"
                  >
                    {entry.node.collapsed ? '▸' : '▾'}
                  </button>
                ) : (
                  <span className="adnota-outline-twisty is-placeholder" aria-hidden="true" />
                )}

                <button
                  type="button"
                  className="adnota-outline-label"
                  onClick={() => onSelect(entry.id)}
                  data-testid="outline-label"
                >
                  {entry.node.label.content.length === 0 ? (
                    <span className="adnota-outline-empty">Untitled</span>
                  ) : (
                    // Rendered rather than plain text: the outline is a reading view,
                    // and a student scanning it for a formula recognises an integral
                    // sign instantly where `\int_a^b f(x)\,dx` is just noise. The plain
                    // form is kept as the accessible name and the tooltip, so the text
                    // is still copyable and searchable.
                    <MathLabel
                      doc={entry.node.label}
                      className="adnota-outline-text"
                    />
                  )}
                  <span className="adnota-visually-hidden">{entry.text}</span>
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {entries.length === 0 ? (
        <p className="adnota-outline-empty-state">No nodes yet. Press Tab on the canvas to add one.</p>
      ) : null}
    </div>
  );
}