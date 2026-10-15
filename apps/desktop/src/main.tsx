/**
 * Desktop entry point.
 *
 * The desktop window and the browser harness mount the *same* `@adnota/view` app. This
 * file's entire job is the three things that only exist here: a real filesystem, the
 * document that was on disk when the app last closed, and flushing pending writes when
 * the window goes away. Anything else that appeared here would be a fork waiting to
 * drift from the harness.
 */

import { buildDocument, type DocumentSession } from '@adnota/core';
import { mountApp, type MountedApp } from '@adnota/view';
import '@adnota/view/styles.css';
import { chooseDocumentToOpen, chooseDocumentToSave } from './dialog.ts';
import { TauriStorage, readExternal, resolveBase, writeExternal } from './storage.ts';
import { TauriLibrary } from './library.ts';
import {
  closeDocument,
  openExternalPath,
  openNamed,
  openOrCreate,
  recallRecent,
  type OpenDocument,
} from './session.ts';
import './boot.css';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

// Narrowed once, so every later use is an `Element` rather than `Element | null`.
const container: HTMLElement = root;

/**
 * Keep unsaved work on disk without a window-close handler.
 *
 * There was one, and it made the app uncloseable. In this version of Tauri,
 * *registering* `onCloseRequested` is enough to cancel the close — a handler that never
 * calls `preventDefault()` and does nothing else still leaves the title-bar cross and
 * Alt+F4 with no effect. Verified by bisecting: with no handler registered the window
 * closes normally, and with an empty handler it does not.
 *
 * So there is no close handler. Instead the session is flushed on a heartbeat whenever it
 * is dirty. The guarantee is weaker in principle — a change made in the last couple of
 * seconds before a close could be lost — and considerably stronger in practice than an
 * app that cannot be closed at all.
 */
const FLUSH_INTERVAL_MS = 2000;

function startHeartbeat(session: DocumentSession): () => void {
  const timer = setInterval(() => {
    if (!session.state.dirty) return;
    void session.save().catch(() => undefined);
  }, FLUSH_INTERVAL_MS);

  return () => clearInterval(timer);
}

function showBootError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  container.replaceChildren();

  const panel = document.createElement('div');
  panel.className = 'adnota-boot-error';
  panel.setAttribute('role', 'alert');

  const title = document.createElement('h1');
  title.textContent = 'Adnota could not open your notes';

  const detail = document.createElement('p');
  detail.textContent = message;

  const hint = document.createElement('p');
  hint.className = 'adnota-boot-hint';
  // Important: the failure is on the way *in*, so nothing has been overwritten and the
  // file on disk is still exactly as it was.
  hint.textContent = 'Nothing on disk has been changed. Starting Adnota again will retry.';

  panel.append(title, detail, hint);
  container.append(panel);
}

async function start(): Promise<void> {
  const storage = new TauriStorage(await resolveBase());
  const library = new TauriLibrary(storage);
  const first = await openOrCreate(storage, recallRecent());

  /**
   * Swap the open document in place.
   *
   * Remounting the app would discard the viewport, the panel state and the outline
   * scroll, and would flash an empty window between documents. The previous session is
   * closed first so its last edits leave the debounce window before anything else
   * happens; skipping that is how a student's final sentence of a session goes missing.
   */
let mounted: MountedApp | null = null;
  let current: OpenDocument | null = null;
  /**
   * Stops the previous document's flush timer.
   *
   * Declared here rather than inferred, because an undeclared assignment throws a
   * `ReferenceError` in a module (strict mode) and this file was never typechecked —
   * the whole desktop app shipped showing its "could not open your notes" panel because
   * of exactly that, invisibly to CI.
   */
  let stopHeartbeat: (() => void) | null = null;

  const mount = (opened: OpenDocument): void => {
    const previous = current;
    current = opened;

    if (previous) {
      stopHeartbeat?.();
      void closeDocument(previous.session).catch(() => undefined);
    }
    stopHeartbeat = startHeartbeat(opened.session);

    mounted?.unmount();
    container.replaceChildren();

    mounted = mountApp(container, {
      createDocument: () => opened.doc,
      save: {
        filename: opened.filename,
        state: opened.session.state,
        // Wrapped rather than passed by reference: `subscribe` is a method on a class
        // with private fields, so handing it over unbound throws the first time the
        // session publishes a state change — which is the first autosave.
        subscribe: (listener) => opened.session.subscribe(listener),
      },
library,
      // Only supplied by the desktop app. The browser harness renders no Open / Save As
      // buttons at all, because it has no native dialog to show.
      externalFiles: {
        openExternal: chooseDocumentToOpen,
        saveExternalCopy: chooseDocumentToSave,
        writeExternal: writeExternal,
      },
      readOpenDocument: async () => {
        // Serialised on demand rather than kept in memory, so the bytes cannot go stale
        // against what is on screen.
        const { bytes } = await buildDocument(opened.doc, new Map());
        return bytes;
      },
onOpenDocument: (name) => {
        // A name from the library is relative to the base; a path from Open… is
        // absolute. Routing them apart here keeps the library functions from ever
        // seeing a path they should refuse.
        const opening = isAbsolute(name)
          ? openExternalPath(storage, readExternal, name)
          : openNamed(storage, name);

        void opening
          .then(mount)
          .catch((error: unknown) => {
            // The document already on screen stays; replacing it with an error page
            // because a *different* file failed to open would be a poor trade.
            console.error('Could not open that document', error);
          });
      },
    });
  };

mount(first);
}

/** Windows and POSIX both use a leading separator or drive letter for an absolute path. */
function isAbsolute(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path);
}

start().catch(showBootError);
