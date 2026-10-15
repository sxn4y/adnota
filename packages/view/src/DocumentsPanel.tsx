/**
 * Document panel.
 *
 * The way a student gets to a different document. Without it the app can only ever
 * reopen the last one, which means a second piece of work has nowhere to go — and that
 * is the whole difference between a mindmap tool and a notes app.
 *
 * Lists newest first with a real modification time, because "which of these do I want"
 * is far easier answered by recency than by alphabetical order.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTAINER_EXTENSION, type DocumentSummary } from '@adnota/core';
import type { DocumentLibrary, ExternalFileActions } from './library.ts';
import { validateRename } from './library.ts';

export interface DocumentsPanelProps {
  readonly library: DocumentLibrary;
  /** Name currently open. */
  readonly current: string | null;
  readonly onOpen: (name: string) => void;
  readonly onClose: () => void;
  /**
   * Desktop-only Open / Save As.
   *
   * Absent in the browser harness, which has no native dialog. The buttons are hidden
   * rather than rendered disabled — a control that can never work is clutter.
   */
  readonly external?: ExternalFileActions;
  /** Writes the open document to a chosen path. Supplied with `external`. */
  readonly readOpenDocument?: () => Promise<Uint8Array>;
}

type Row =
  | { readonly kind: 'idle' }
  | { readonly kind: 'renaming'; readonly value: string; readonly name: string }
  | { readonly kind: 'error'; readonly message: string };

export function DocumentsPanel({
  library,
  current,
  onOpen,
  onClose,
  external,
  readOpenDocument,
}: DocumentsPanelProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [documents, setDocuments] = useState<readonly DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState<Row>({ kind: 'idle' });

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setDocuments(await library.list());
    } finally {
      setLoading(false);
    }
  }, [library]);

  /**
   * Focus the dialog when it opens.
   *
   * Escape is handled on the dialog itself, which only fires when focus is inside it.
   * Without this the panel would advertise an Escape that does nothing, because nothing
   * in it has focus until the student happens to click a row.
   */
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    // A failure here is swallowed into an empty list rather than thrown: the panel is a
    // convenience, and being unable to *list* documents must not stop the student
    // working in the one already open.
    void refresh().catch(() => setDocuments([]));
  }, [refresh]);

  const createNew = useCallback(async (): Promise<void> => {
    try {
      const { name } = await library.create('');
      await refresh();
      onOpen(name);
    } catch (error) {
      setRow({ kind: 'error', message: messageOf(error) });
    }
  }, [library, refresh, onOpen]);

  const submitRename = useCallback(
    async (from: string): Promise<void> => {
      if (row.kind !== 'renaming') return;

      // Emptiness is checked on the *title*, before the extension is appended. Checking
      // afterwards would accept a field of nothing but spaces by turning it into a file
      // called ".adnota".
      const title = row.value.trim();
      if (title.length === 0) {
        setRow({ kind: 'error', message: 'The name cannot be empty.' });
        return;
      }

      // The field shows the title, so the extension has to be put back. Without this a
      // rename silently turns `Week 3.adnota` into a file the library no longer lists —
      // the document would appear to have been renamed and have actually disappeared.
      const to = withExtension(title);

      const reason = validateRename(
        from,
        to,
        documents.map((doc) => doc.name),
      );
      if (reason) {
        setRow({ kind: 'error', message: reason });
        return;
      }

      try {
        await library.rename(from, to);
        setRow({ kind: 'idle' });
        await refresh();
        if (current === from) onOpen(to);
      } catch (error) {
        setRow({ kind: 'error', message: messageOf(error) });
      }
    },
    [current, documents, library, onOpen, refresh, row],
  );

  const openExternal = useCallback(async (): Promise<void> => {
    if (!external) return;
    try {
      const path = await external.openExternal();
      // Cancelling is a normal outcome, not a failure, and must not raise an error the
      // student has to dismiss.
      if (path === null) return;
      onOpen(path);
    } catch (error) {
      setRow({ kind: 'error', message: messageOf(error) });
    }
  }, [external, onOpen]);

  const saveExternalCopy = useCallback(async (): Promise<void> => {
    if (!external || !readOpenDocument || current === null) return;
    try {
      const path = await external.saveExternalCopy(current);
      if (path === null) return;

      // A Save As writes a copy; it deliberately does not switch the open document,
      // because the student may have wanted a backup of one document rather than to
      // start editing a second.
      await external.writeExternal(path, await readOpenDocument());
      setRow({ kind: 'idle' });
    } catch (error) {
      setRow({ kind: 'error', message: messageOf(error) });
    }
  }, [current, external, readOpenDocument]);

  const remove = useCallback(
    async (name: string): Promise<void> => {
      try {
        await library.remove(name);
        await refresh();
      } catch (error) {
        setRow({ kind: 'error', message: messageOf(error) });
      }
    },
    [library, refresh],
  );

  return (
    <div className="adnota-documents-backdrop" data-testid="documents-panel" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="adnota-documents"
        role="dialog"
        aria-modal="true"
        aria-label="Documents"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // The panel advertises "Esc to close", so it has to honour it. It cannot rely
          // on the canvas's handler: this is a modal, and Escape must dismiss the modal
          // rather than reaching through to the document behind it.
          if (event.key !== 'Escape') return;

          // While a rename field is open, Escape cancels that instead.
          if (row.kind === 'renaming') {
            setRow({ kind: 'idle' });
            return;
          }

          event.stopPropagation();
          onClose();
        }}
      >
        <header className="adnota-documents-header">
          <h2>Documents</h2>
          <div className="adnota-documents-actions">
            {external ? (
              <>
                <button
                  type="button"
                  onClick={() => void openExternal()}
                  data-testid="documents-open-external"
                >
                  Open…
                </button>
                <button
                  type="button"
                  onClick={() => void saveExternalCopy()}
                  disabled={current === null}
                  title={current === null ? 'Open a document first' : undefined}
                  data-testid="documents-save-as"
                >
                  Save As…
                </button>
              </>
            ) : null}
            <button type="button" onClick={createNew} data-testid="documents-new">
              New
            </button>
          </div>
        </header>

        {row.kind === 'error' ? (
          <p className="adnota-documents-error" role="alert" data-testid="documents-error">
            {row.message}
          </p>
        ) : null}

        {loading ? (
          <p className="adnota-documents-hint">Loading…</p>
        ) : documents.length === 0 ? (
          <p className="adnota-documents-hint">No documents yet.</p>
        ) : (
          <ul className="adnota-documents-list">
            {documents.map((doc) => {
              const isCurrent = doc.name === current;

              if (row.kind === 'renaming' && row.name === doc.name) {
                return (
                  <li key={doc.name} className="adnota-documents-row is-renaming">
                    <input
                      className="adnota-documents-rename"
                      value={row.value}
                      autoFocus
                      aria-label="New name"
                      data-testid="documents-rename-input"
                      onChange={(event) => setRow({ kind: 'renaming', value: event.target.value, name: doc.name })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void submitRename(doc.name);
                        if (event.key === 'Escape') setRow({ kind: 'idle' });
                      }}
                    />
                    <button type="button" onClick={() => void submitRename(doc.name)} data-testid="documents-rename-save">
                      Save
                    </button>
                    <button type="button" onClick={() => setRow({ kind: 'idle' })}>
                      Cancel
                    </button>
                  </li>
                );
              }

              return (
                <li
                  key={doc.name}
                  className={`adnota-documents-row${isCurrent ? ' is-current' : ''}`}
                  data-testid="documents-row"
                  data-name={doc.name}
                >
                  <button
                    type="button"
                    className="adnota-documents-open"
                    onClick={() => onOpen(doc.name)}
                    title={doc.name}
                  >
                    <span className="adnota-documents-title">{doc.title}</span>
                    <span className="adnota-documents-meta">
                      {doc.updatedAt === null ? '—' : formatWhen(doc.updatedAt)}
                    </span>
                  </button>

                  <button
                    type="button"
                    className="adnota-documents-action"
                    aria-label={`Rename ${doc.title}`}
                    data-testid="documents-rename"
                    onClick={() => {
                      setRow({ kind: 'renaming', value: doc.title, name: doc.name });
                    }}
                  >
                    Rename
                  </button>

                  <button
                    type="button"
                    className="adnota-documents-action is-danger"
                    aria-label={`Delete ${doc.title}`}
                    data-testid="documents-delete"
                    disabled={isCurrent}
                    title={isCurrent ? 'Close this document before deleting it' : undefined}
                    onClick={() => void remove(doc.name)}
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="adnota-documents-hint">
          <kbd>Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}


/** Append the container extension unless the student already typed it. */
function withExtension(title: string): string {
  return title.endsWith(CONTAINER_EXTENSION) ? title : title + CONTAINER_EXTENSION;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A short, relative-ish date. Absolute dates are noise for "which one do I want". */
function formatWhen(epochMs: number): string {
  const date = new Date(epochMs);
  const now = Date.now();
  const days = Math.floor((now - epochMs) / 86_400_000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;

  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
