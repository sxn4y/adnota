/**
 * Browser harness entry point.
 *
 * Deliberately thin: it mounts the shared `@adnota/view` app and nothing else, so the
 * harness and the desktop window cannot drift apart in behaviour. If something needs
 * to differ between them, it belongs in a prop here rather than in a fork of the UI.
 *
 * What it does add is a document library and a save session, both held in memory. That
 * is the same code the desktop runs pointed at a different store — not a stub written
 * for the tests. Without them the Documents button is absent and the save indicator has
 * nothing to report, so a meaningful part of the app would go untested in a real
 * browser. What is genuinely missing is only the disk.
 */

import { DocumentSession, MemoryStorage, type YDoc } from '@adnota/core';
import { MemoryLibrary, buildSampleDocument, filenameFor, mountApp, type MountedApp } from '@adnota/view';
import '@adnota/view/styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

// Narrowed once so every later use is an `Element`, rather than re-checking inside the
// mount function.
const container: HTMLElement = root;

const storage = new MemoryStorage();
const library = new MemoryLibrary(storage);

let mounted: MountedApp | null = null;
let current: DocumentSession | null = null;

function mountDocument(name: string, doc: YDoc): void {
  // The previous session is closed first so its last edits leave the debounce window,
  // mirroring what the desktop does when switching documents.
  if (current) void current.close().catch(() => undefined);
  current = new DocumentSession(doc, name, storage, { debounceMs: 400 });

  mounted?.unmount();
  container.replaceChildren();

  mounted = mountApp(container, {
    createDocument: () => doc,
    library,
    save: {
      filename: name,
      state: current.state,
      subscribe: (listener) => current!.subscribe(listener),
    },
    onOpenDocument: (target) => {
      void library.open(target).then((opened) => mountDocument(target, opened));
    },
  });
}

/**
 * Start the app.
 *
 * The sample mindmap is what the harness opens on: demo content rich enough to exercise
 * every feature — maths, long labels, several levels of nesting — and what the visual
 * suite asserts against.
 *
 * It is added to the library *before* the app mounts. Doing it afterwards was measurably
 * no faster (the ZIP write is tens of milliseconds, not seconds) and introduced a race:
 * the Documents panel takes its first snapshot on mount, so a late write left it showing
 * an empty library, and a document can appear with no row marking it as current.
 */
async function start(): Promise<void> {
  const { doc } = buildSampleDocument();
  const name = filenameFor('Integration', []);

  await library.put(name, doc);
  mountDocument(name, doc);
}

void start().catch((error: unknown) => {
  // A failure here leaves an app that never appears, which is worse than a degraded
  // one: the boot error panel is exactly the right outcome for an unopenable library.
  console.error('Could not start the harness', error);
});
