/**
 * Search palette.
 *
 * Opened with Ctrl+K, dismissed with Escape, navigated with the arrow keys. It selects
 * nodes rather than jumping to a page, because in a mindmap the question is never
 * "which page am I on" but "where did I write that".
 *
 * The input takes focus on mount and the list is rebuilt on every keystroke. At the
 * scale of a mindmap that is a few hundred comparisons, which is well under a frame,
 * and it means results never lag behind what the student has typed.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { search, type NodeId, type SearchHit, type YDoc } from '@adnota/core';

export interface SearchPaletteProps {
  readonly doc: YDoc;
  readonly revision: number;
  readonly onChoose: (id: NodeId) => void;
  readonly onDismiss: () => void;
}

export function SearchPalette({
  doc,
  revision,
  onChoose,
  onDismiss,
}: SearchPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // `revision` invalidates the memo: the document object is stable across edits.
  const hits = useMemo(
    () => (revision >= 0 ? search(doc, query, { includeMath: true }) : []),
    [doc, query, revision],
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Keep the highlighted row inside the result set as it shrinks.
  useEffect(() => {
    setActive(0);
  }, [query]);

  const choose = (hit: SearchHit): void => {
    onChoose(hit.id);
    onDismiss();
  };

  return (
    <div
      className="adnota-palette-backdrop"
      data-testid="search-palette"
      onClick={onDismiss}
      role="presentation"
    >
      <div
        className="adnota-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search notes"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="adnota-palette-input"
          type="search"
          value={query}
          placeholder="Search notes and formulas…"
          aria-label="Search"
          data-testid="search-input"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onDismiss();
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((value) => (hits.length === 0 ? 0 : (value + 1) % hits.length));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((value) => (hits.length === 0 ? 0 : (value - 1 + hits.length) % hits.length));
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              const hit = hits[active];
              if (hit) choose(hit);
            }
          }}
        />

        {query.trim().length > 0 && hits.length === 0 ? (
          <p className="adnota-palette-empty" data-testid="search-empty">
            No matches for “{query.trim()}”
          </p>
        ) : null}

        <ul className="adnota-palette-results" role="listbox" aria-label="Results">
          {hits.map((hit, index) => (
            <li key={hit.id} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={`adnota-palette-result${index === active ? ' is-active' : ''}`}
                data-testid="search-result"
                data-node-id={hit.id}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(hit)}
              >
                <Highlight snippet={hit.snippet} start={hit.matchStart} length={hit.matchLength} />
              </button>
            </li>
          ))}
        </ul>

        <p className="adnota-palette-hint">
          <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}

/** Split the snippet around the match so the match can be marked. */
function Highlight({
  snippet,
  start,
  length,
}: {
  readonly snippet: string;
  readonly start: number;
  readonly length: number;
}): React.JSX.Element {
  const before = snippet.slice(0, start);
  const match = snippet.slice(start, start + length);
  const after = snippet.slice(start + length);

  return (
    <span className="adnota-palette-snippet">
      {before}
      {match ? <mark>{match}</mark> : null}
      {after}
    </span>
  );
}