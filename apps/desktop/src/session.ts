/**
 * Document lifecycle for the desktop app.
 *
 * Owns the three questions the UI should never have to answer: which file is open,
 * where it lives on disk, and when it was last written. Everything it decides is
 * deliberate, because the failure mode here is a student losing an evening's work to a
 * decision that looked reasonable at the time.
 *
 * ## Which file opens
 *
 * The most recently opened one, remembered across launches. Not "the last file in the
 * directory" and not a new empty document: reopening what you were working on is the
 * behaviour every editor has, and surprising a user with a blank window is how a notes
 * app gets abandoned.
 *
 * ## Where it lives
 *
 * In the user's own Documents folder under `Adnota/`, in one flat directory. Not in an
 * application-data directory: notes should be findable and backed up by the tools the
 * student already uses, without Adnota being in the loop. Not nested per document
 * either, because a flat folder is what a file browser and a sync client both handle
 * without configuration.
 *
 * ## When it is written
 *
 * `DocumentSession` debounces, stages, and backs up. This module only decides the
 * target path and makes sure a pending write is flushed before the window goes away.
 */

import {
  CONTAINER_EXTENSION,
  ROOT_NODE_ID,
  DocumentSession,
  createDoc,
  createNode,
  loadDocument,
  titleFromName,
  type BinaryStorage,
  type SaveState,
  type YDoc,
} from '@adnota/core';
import { filenameFor } from '@adnota/view';

/**
 * Where the open document is remembered between launches.
 */
const RECENT_KEY = 'adnota.recent.v1';

/**
 * The pointer to the open document, stored beside the documents themselves.
 *
 * Webview storage is the obvious place for this and is deliberately *not* the only
 * place. A Tauri webview's `localStorage` lives in the WebView2 user-data directory:
 * it can be cleared by a "reset app data" button, by a webview version change, or by
 * nothing at all if the origin differs between a dev build (`localhost:5174`) and a
 * packaged one. When that happens the app silently forgets the student's work and
 * starts a new document beside it, which is the worst possible failure.
 *
 * A plain text file next to the documents cannot do that. It is written through the
 * same `BinaryStorage` as everything else, so it is covered by the same Rust tests.
 */
const POINTER_FILE = '.last-opened';

/** How many documents to remember. Enough for a course, not enough to be a database. */
const RECENT_LIMIT = 10;

export interface OpenDocument {
  readonly doc: YDoc;
  readonly session: DocumentSession;
  /** Relative to the storage base. Shown in the title bar and the save indicator. */
  readonly filename: string;
  /** False when the file did not exist and a fresh document was created in its place. */
  readonly existed: boolean;
}

/** A safe, collision-free name for a new document. */
export function freshNameFor(existing: readonly string[]): string {
  const taken = new Set(existing);

  const base = 'Untitled';
  if (!taken.has(`${base}${CONTAINER_EXTENSION}`)) return `${base}${CONTAINER_EXTENSION}`;

  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}${CONTAINER_EXTENSION}`;
    if (!taken.has(candidate)) return candidate;
  }

  // Practically unreachable; a timestamp is a last resort rather than a collision.
  return `${base} ${Date.now()}${CONTAINER_EXTENSION}`;
}

/**
 * Load a document, or create one if the file is absent.
 *
 * A file that exists but cannot be parsed is *not* silently replaced. That would turn a
 * corrupted document into a blank window with no sign that anything was lost, so the
 * error is allowed to propagate and the caller decides what to show.
 */
/**
 * A new document with a single root node.
 *
 * Not `createDoc()` on its own. That produces a document with no nodes at all, and
 * every action in the app requires a selected node — Tab, Enter, the toolbar buttons,
 * the outline. So a bare new document opens to a blank canvas the student cannot do
 * anything with and no obvious way out of.
 *
 * The root is labelled from the title so it reads as a starting point rather than as
 * machinery.
 */
function createStarterDocument(title: string): YDoc {
  const doc = createDoc(title);
  createNode(doc, { parentId: ROOT_NODE_ID, label: { type: 'doc', content: [{ type: 'text', text: title }] } });
  return doc;
}

/** Read the pointer file, tolerating its absence and any corruption. */
async function readPointer(storage: BinaryStorage): Promise<string | null> {
  try {
    const bytes = await storage.read(POINTER_FILE);
    if (bytes === null) return null;

    const name = new TextDecoder().decode(bytes).trim();
    // A pointer to something that no longer exists is stale, not an error.
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

async function writePointer(storage: BinaryStorage, filename: string): Promise<void> {
  try {
    await storage.write(POINTER_FILE, new TextEncoder().encode(filename));
  } catch {
    // Best effort. Failing to write the pointer costs one extra "Untitled" next launch;
    // failing to start would cost the student their session.
  }
}

export async function openOrCreate(
  storage: BinaryStorage,
  requested: string | null,
): Promise<OpenDocument> {
const remembered = (await readPointer(storage)) ?? requested;

  // Read once and branch on the result rather than mutating `doc` and `filename` across
  // two blocks. Assigning a `YDoc` in one branch and using it after both is exactly the
  // shape that TypeScript refuses to prove, and it was invisible until this package was
  // added to the typecheck graph.
  const existingBytes = remembered === null ? null : await storage.read(remembered);

  const existed = existingBytes !== null;
  const doc: YDoc = existed
    ? (await loadDocument(existingBytes)).doc
    : createStarterDocument('Untitled');
  const filename: string = existed
    ? (remembered as string)
    : freshNameFor(await storage.list(''));

  const session = new DocumentSession(doc, filename, storage, { debounceMs: 1500 });

  // Remembered whether or not the file already existed.
  //
  // A brand-new document must be remembered too. Autosave writes the file on the first
  // edit, so "it does not exist yet" is only true for a document the student never
  // touched — and failing to remember those meant every launch created another
  // `Untitled N.adnota` and stranded the previous one on disk.
  //
  // If the file is still absent next launch, `openOrCreate` falls back to a fresh
  // document, which is correct: there was nothing to lose.
  remember(filename);
  await writePointer(storage, filename);

  return { doc, session, filename, existed };
}

/**
 * Where the remembered-document list is kept.
 *
 * Indirected behind an interface because the desktop app and the tests run in different
 * worlds: a webview has `localStorage`, Node does not. Hardcoding `localStorage` made
 * the list silently do nothing under test, which is how a broken recent list would have
 * shipped looking correct.
 */
export interface PreferenceStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function detectStore(): PreferenceStore {
  const web = (): PreferenceStore | undefined => {
    const ls = globalThis.localStorage;
    if (!ls) return undefined;
    return {
      get: (key) => ls.getItem(key),
      set: (key, value) => ls.setItem(key, value),
      remove: (key) => ls.removeItem(key),
    };
  };

  try {
    // A webview with storage disabled throws on access rather than returning null, so
    // the probe is itself the try.
    return web() ?? newMemoryStore();
  } catch {
    return newMemoryStore();
  }
}

/** A store that lives only as long as the process. */
export function newMemoryStore(): PreferenceStore {
  const entries = new Map<string, string>();
  return {
    get: (key) => entries.get(key) ?? null,
    set: (key, value) => {
      entries.set(key, value);
    },
    remove: (key) => {
      entries.delete(key);
    },
  };
}

let store: PreferenceStore = detectStore();

/** Swap the backing store. Used by tests, and by the entry point when it has its own. */
export function setPreferenceStore(next: PreferenceStore): void {
  store = next;
}

/** Record a document as the most recently opened one. */
export function remember(filename: string): void {
  try {
    const parsed: unknown = store.get(RECENT_KEY) ? JSON.parse(store.get(RECENT_KEY)!) : [];
    const list = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];

    const next = [filename, ...list.filter((entry) => entry !== filename)].slice(0, RECENT_LIMIT);
    store.set(RECENT_KEY, JSON.stringify(next));
  } catch {
    // A browser that refuses storage still works; the student just reopens the same
    // file next time. Failing to remember a path is never worth failing to start.
  }
}

/** The most recently opened document, or null on a first run. */
export function recallRecent(): string | null {
  return listRecent()[0] ?? null;
}

/** Recently opened documents, newest first. */
export function listRecent(): string[] {
  try {
    const raw = store.get(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Forget every remembered document. Used by tests and by "reset on this machine". */
export function resetRecent(): void {
  try {
    store.remove(RECENT_KEY);
  } catch {
    // Nothing to forget if storage was never available.
  }
}

/**
 * Open a named document that is expected to exist.
 *
 * Used by the document switcher, where a missing file is a real error the student needs
 * told about rather than a reason to quietly open something else.
 */
export async function openNamed(storage: BinaryStorage, filename: string): Promise<OpenDocument> {
  const bytes = await storage.read(filename);
  if (bytes === null) throw new Error(`No document called "${filename}" is in the library.`);

  const loaded = await loadDocument(bytes);
  const session = new DocumentSession(loaded.doc, filename, storage, { debounceMs: 1500 });

  remember(filename);
  await writePointer(storage, filename);

  return { doc: loaded.doc, session, filename, existed: true };
}

/**
 * Open a document by absolute path, from anywhere on disk.
 *
 * Used by Open…, which is the one route out of the library folder. The document is read
 * through `read_external`, whose Rust side re-validates the path, and is then copied into
 * the library so that autosave and the backup sidecar keep working: Adnota needs a file
 * it owns, not a shared file two programs could write at once.
 */
export async function openExternalPath(
  storage: BinaryStorage,
  readExternal: (path: string) => Promise<Uint8Array>,
  path: string,
): Promise<OpenDocument> {
  const bytes = await readExternal(path);
  const loaded = await loadDocument(bytes);

  const taken = await storage.list('');
  // `filenameFor` takes a title and adds the extension, so the basename is stripped
  // first — otherwise every imported file arrives as `notes.adnota.adnota`.
  const name = filenameFor(titleFromName(basename(path)), taken);

  await storage.write(name, bytes);

  const session = new DocumentSession(loaded.doc, name, storage, { debounceMs: 1500 });
  remember(name);
  await writePointer(storage, name);

  return { doc: loaded.doc, session, filename: name, existed: true };
}

/** The last path segment of a path, in either separator style. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'Untitled.adnota';
}

/** Flush pending edits and stop watching the document. */
export async function closeDocument(session: DocumentSession): Promise<void> {
  await session.close();
}

export type { SaveState };
