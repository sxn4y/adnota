/**
 * Document library over a real folder.
 *
 * The desktop half of `DocumentLibrary`. Everything it does goes through the same
 * `BinaryStorage` the autosave uses, so the atomic write-and-backup behaviour that
 * protects a student's notes applies to creating and renaming too.
 */

import {
  CONTAINER_EXTENSION,
  buildDocument,
  createDoc,
  createNode,
  ROOT_NODE_ID,
  loadDocument,
  readSummary,
  setTitle,
  sortSummaries,
  titleFromName,
  type BinaryStorage,
  type DocumentSummary,
  type YDoc,
} from '@adnota/core';
import { filenameFor } from '@adnota/view';

/** Sidecars autosave creates; never shown as documents. */
const HIDDEN_SUFFIXES = ['.bak', '.tmp'];

/**
 * The storage this library needs.
 *
 * A structural subset rather than the concrete `TauriStorage`, so the library can be
 * tested against an in-memory store. Taking the concrete class meant every one of the
 * document tests exercised `MemoryLibrary` instead, and this file — the one the desktop
 * app actually uses — shipped a missing import that only a human launching the app would
 * have found.
 */
export interface LibraryStorage extends BinaryStorage {
  modifiedAt(path: string): Promise<number | null>;
}

export class TauriLibrary {
  readonly #storage: LibraryStorage;

  constructor(storage: LibraryStorage) {
    this.#storage = storage;
  }

  /** Every `.adnota` file, newest first. */
  async list(): Promise<readonly DocumentSummary[]> {
    const names = (await this.#storage.list('')).filter(isDocument);

    // The title comes from `format.json`, which is a few bytes, rather than from opening
    // the document. Reading fifty CRDTs to render a list is slow enough to be felt.
    const summaries = await Promise.all(
      names.map(async (name) => {
        const bytes = await this.#storage.read(name);
        const summary = bytes === null ? null : await readSummary(name, bytes);
        const modifiedAt = await this.#storage.modifiedAt(name);

        return summary === null
          ? null
          : { name, title: summary.title, updatedAt: modifiedAt ?? summary.updatedAt };
      }),
    );

    return sortSummaries(summaries.filter((entry): entry is DocumentSummary => entry !== null));
  }

  async open(name: string): Promise<YDoc> {
    assertDocumentName(name);

    const bytes = await this.#storage.read(name);
    if (bytes === null) throw new Error(`No document called "${name}".`);

    // Awaited. Reading `.doc` off the promise gave `undefined`, so opening any document
    // from the desktop library produced an empty mind map.
    return (await loadDocument(bytes)).doc;
  }

  /**
   * Create a new document and write it immediately.
   *
   * Written up front rather than left to the first autosave so that the name the
   * student chose is already on disk: if the app is closed the instant after creating a
   * document, an unwritten one would simply not exist.
   */
  async create(title: string): Promise<{ readonly name: string; readonly doc: YDoc }> {
    const taken = (await this.#storage.list('')).filter(isDocument);
    const name = filenameFor(title, taken);

    const doc = createDoc(title || 'Untitled');
    createNode(doc, {
      parentId: ROOT_NODE_ID,
      label: { type: 'doc', content: [{ type: 'text', text: title || 'Untitled' }] },
    });

    await this.#write(doc, name);
    return { name, doc };
  }

  /**
   * Rename by writing to the new name and then removing the old.
   *
   * Written in that order deliberately: if the process dies between the two, the
   * document exists under both names rather than under neither. Losing the name is
   * recoverable; losing the notes is not.
   */
  /**
   * Rename the file *and* the document's title.
   *
   * The list shows the title, which is mirrored into the container, so renaming only
   * the file would leave the panel still reading the old name — the rename would appear
   * to have done nothing.
   */
  async rename(from: string, to: string): Promise<void> {
    assertDocumentName(from);
    assertDocumentName(to);

    if (from === to) return;

    const bytes = await this.#storage.read(from);
    if (bytes === null) throw new Error(`No document called "${from}".`);
    if (await this.#storage.exists(to)) throw new Error(`A document called "${to}" already exists.`);

    const doc = (await loadDocument(bytes)).doc;
    const title = titleFromName(to);
    setTitle(doc, title);

    const { bytes: rebuilt } = await buildDocument(doc, new Map(), { title });

    // Written before the old name is dropped: a crash in between leaves the document
    // under both names rather than neither. Losing the name is recoverable; losing the
    // notes is not.
    await this.#storage.write(to, rebuilt);
    await this.#storage.remove(from);

    // The backup sidecar keeps the old name, which would be misleading rather than
    // useful: restoring it would resurrect the document under the name just given up.
    await this.#storage.remove(`${from}.bak`).catch(() => undefined);
  }

  async remove(name: string): Promise<void> {
    assertDocumentName(name);

    await this.#storage.remove(name);
    await this.#storage.remove(`${name}.bak`).catch(() => undefined);
    await this.#storage.remove(`${name}.tmp`).catch(() => undefined);
  }

/** Write a document out, using the same storage the session saves through. */
  async write(doc: YDoc, name: string): Promise<void> {
    // Statically imported. A dynamic import here meant `buildDocument` was undefined in
    // `rename()` — which throws on every desktop rename, invisibly, because the
    // document tests all run against the in-memory library rather than this one.
    const { bytes } = await buildDocument(doc, new Map(), { title: docTitle(doc) });
    await this.#storage.write(name, bytes);
  }

  async #write(doc: YDoc, name: string): Promise<void> {
    await this.write(doc, name);
  }
}

function docTitle(doc: YDoc): string {
  const meta = doc.getMap('meta').get('title');
  return typeof meta === 'string' ? meta : 'Untitled';
}

/** A file is a document when it has the extension and is not a sidecar. */
function isDocument(name: string): boolean {
  return name.endsWith(CONTAINER_EXTENSION) && !HIDDEN_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Refuse a name that could escape the storage base.
 *
 * The Rust side already rejects traversal and absolute paths, so this is a second
 * refusal at a different boundary rather than a substitute for it.
 */
function assertDocumentName(name: string): void {
  if (name.length === 0) throw new Error('A document needs a name.');
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    throw new Error('A document name cannot contain a path separator.');
  }
}

export type { BinaryStorage, DocumentSummary };
