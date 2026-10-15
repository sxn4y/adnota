/**
 * Document library.
 *
 * The list of documents a student can open, plus the operations that change it. Kept as
 * an interface so the same panel works over a real folder in the desktop app and over an
 * in-memory map in the browser harness and tests, and so the view package never learns
 * that a filesystem exists.
 *
 * Deliberately coarse. Everything here is "the thing a student does to a document":
 * open it, make another, rename it, delete it. Nothing here is about bytes; the session
 * and the container format already own that.
 */

import {
  CONTAINER_EXTENSION,
  MemoryStorage,
  ROOT_NODE_ID,
  buildDocument,
  createDoc,
  createNode,
  loadDocument,
  readSummary,
  setTitle,
  sortSummaries,
  titleFromName,
  type BinaryStorage,
  type DocumentSummary,
  type YDoc,
} from '@adnota/core';

export interface DocumentLibrary {
  /** Every document in the library, newest first. */
  list(): Promise<readonly DocumentSummary[]>;
  /** Read a document. Throws when it is missing or unreadable. */
  open(name: string): Promise<YDoc>;
  /** Create a new, empty document and return it with the name it was given. */
  create(title: string): Promise<{ readonly name: string; readonly doc: YDoc }>;
  /** Rename. Must not clobber an existing document. */
  rename(from: string, to: string): Promise<void>;
  /** Delete, along with its backup sidecar. */
  remove(name: string): Promise<void>;
}

/**
 * Actions that only a desktop app can offer.
 *
 * Kept apart from {@link DocumentLibrary} because the browser harness cannot show a
 * native dialog, and a control that cannot work should be absent rather than shown
 * disabled. When these are absent the corresponding buttons are not rendered at all.
 */
export interface ExternalFileActions {
  /** Pick a document to open. Returns null when the student cancels. */
  openExternal(): Promise<string | null>;
  /** Pick where to save a copy. Returns null when the student cancels. */
  saveExternalCopy(suggestedName: string): Promise<string | null>;
  /** Write the open document to a chosen path. */
  writeExternal(path: string, bytes: Uint8Array): Promise<void>;
}

/** A filename for a title, collision-checked against what already exists. */
export function filenameFor(title: string, taken: Iterable<string>): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  const base = cleaned || 'Untitled';
  const existing = new Set(taken);
  if (!existing.has(`${base}${CONTAINER_EXTENSION}`)) return `${base}${CONTAINER_EXTENSION}`;

  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}${CONTAINER_EXTENSION}`;
    if (!existing.has(candidate)) return candidate;
  }

  return `${base} ${Date.now()}${CONTAINER_EXTENSION}`;
}

/**
 * Check a rename before performing it.
 *
 * Returns the reason it cannot proceed, or `null` when it can. Doing this in the view
 * rather than only in the implementation means the message the student sees is the same
 * everywhere, and a rename that would overwrite another document is refused before any
 * bytes move.
 */
export function validateRename(
  from: string,
  to: string,
  existing: Iterable<string>,
): string | null {
  const trimmed = to.trim();
  if (trimmed.length === 0) return 'The name cannot be empty.';

  if (/[\\/:*?"<>|]/.test(trimmed)) return 'A name cannot contain \\ / : * ? " < > |';
  if (trimmed === from) return null;

  const names = new Set(existing);
  if (names.has(trimmed) && trimmed !== from) return `A document called "${trimmed}" already exists.`;

  return null;
}

/** The title a new document starts with. */
export function defaultTitle(count: number): string {
  return count === 0 ? 'Untitled' : `Untitled ${count + 1}`;
}

/**
 * A library held in memory.
 *
 * Backs the browser harness, where there is no folder to keep documents in but the
 * panel still has to be exercised — and exercising it against a real store, rather than
 * a stubbed one, means the tests cover the same code the desktop runs.
 *
 * It forgets everything on reload, which is the honest behaviour for a harness and is
 * why the desktop builds a different implementation over the filesystem.
 */
export class MemoryLibrary implements DocumentLibrary {
  readonly #storage: BinaryStorage;

  constructor(storage: BinaryStorage = new MemoryStorage()) {
    this.#storage = storage;
  }

  async list(): Promise<readonly DocumentSummary[]> {
    const names = (await this.#storage.list('')).filter((name) => name.endsWith(CONTAINER_EXTENSION));

    const summaries = await Promise.all(
      names.map(async (name) => {
        const bytes = await this.#storage.read(name);
        const summary = bytes === null ? null : await readSummary(name, bytes);
        return summary === null ? null : { name, title: summary.title, updatedAt: summary.updatedAt };
      }),
    );

    return sortSummaries(summaries.filter((entry): entry is DocumentSummary => entry !== null));
  }

/**
   * Put an already-built document into the library.
   *
   * Separate from `create` because the harness starts on the sample mindmap rather than
   * an empty document: it has to be added to the library without being rebuilt, or the
   * panel and the canvas would disagree about what is open.
   */
  async put(name: string, doc: YDoc): Promise<string> {
    await this.#write(doc, name);
    return name;
  }

  async open(name: string): Promise<YDoc> {
    const bytes = await this.#storage.read(name);
    if (bytes === null) throw new Error(`No document called "${name}".`);
    return (await loadDocument(bytes)).doc;
  }

  async create(title: string): Promise<{ readonly name: string; readonly doc: YDoc }> {
    const taken = (await this.#storage.list('')).filter((name) => name.endsWith(CONTAINER_EXTENSION));
    const name = filenameFor(title, taken);

    const doc = starterDocument(title || 'Untitled');
    await this.#write(doc, name);

    return { name, doc };
  }

/**
   * Rename the file *and* the document's title.
   *
   * The list shows the title, which is mirrored into the container, so renaming only
   * the file would leave the panel still reading the old name — the rename would appear
   * to have done nothing. The title is rewritten into the container before the new name
   * is written, so there is never a moment where the file and the title disagree on disk.
   */
  async rename(from: string, to: string): Promise<void> {
    if (from === to) return;

    const bytes = await this.#storage.read(from);
    if (bytes === null) throw new Error(`No document called "${from}".`);
    if (await this.#storage.exists(to)) throw new Error(`A document called "${to}" already exists.`);

    const doc = (await loadDocument(bytes)).doc;
    setTitle(doc, titleFromName(to));

    const { bytes: rebuilt } = await buildDocument(doc, new Map(), { title: titleFromName(to) });

    // Written before the old name is dropped: a crash in between leaves the document
    // under both names rather than neither.
    await this.#storage.write(to, rebuilt);
    await this.#storage.remove(from);
  }

  async remove(name: string): Promise<void> {
    await this.#storage.remove(name);
  }

  async #write(doc: YDoc, name: string): Promise<void> {
    const meta = doc.getMap('meta').get('title');
    // `updatedAt` is deliberately not passed: it lives on the filesystem for the real
    // library, and there is no equivalent here, so the summary falls back to the title.
    const { bytes } = await buildDocument(doc, new Map(), {
      title: typeof meta === 'string' ? meta : 'Untitled',
    });
    await this.#storage.write(name, bytes);
  }
}

/** A new document with a single selected-able root node. */
export function starterDocument(title: string): YDoc {
  const doc = createDoc(title);
  createNode(doc, {
    parentId: ROOT_NODE_ID,
    label: { type: 'doc', content: [{ type: 'text', text: title }] },
  });
  return doc;
}
