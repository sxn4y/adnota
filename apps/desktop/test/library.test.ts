import { describe, expect, it } from 'vitest';
import {
  CONTAINER_EXTENSION,
  MemoryStorage,
  getChildIds,
  getMeta,
  ROOT_NODE_ID,
  type BinaryStorage,
  type YDoc,
} from '@adnota/core';
import { TauriLibrary, type LibraryStorage } from '../src/library.ts';

/**
 * The desktop document library.
 *
 * Every other document test in the repo runs against `MemoryLibrary`, in the browser
 * harness. That left this implementation — the one the desktop app actually uses — with
 * no coverage at all, and it shipped a `buildDocument` call with no import that threw on
 * every rename. These tests run the real class against a real in-memory store; only the
 * disk is faked.
 */

/** `MemoryStorage` plus the one method this library needs beyond `BinaryStorage`. */
class TestStorage implements LibraryStorage {
  readonly #inner = new MemoryStorage();
  #clock = 1_700_000_000_000;

  async read(path: string): Promise<Uint8Array | null> {
    return this.#inner.read(path);
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    return this.#inner.write(path, bytes);
  }
  async remove(path: string): Promise<void> {
    return this.#inner.remove(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.#inner.exists(path);
  }
  async list(prefix: string): Promise<string[]> {
    return this.#inner.list(prefix);
  }

  async modifiedAt(path: string): Promise<number | null> {
    if (!(await this.exists(path))) return null;
    this.#clock += 1000;
    return this.#clock;
  }

  /** Seed a file without going through the library. */
  async seed(path: string, bytes: Uint8Array): Promise<void> {
    await this.#inner.write(path, bytes);
  }

  names(): Promise<string[]> {
    return this.#inner.keys();
  }
}

function library(): { store: TestStorage; lib: TauriLibrary } {
  const store = new TestStorage();
  return { store, lib: new TauriLibrary(store) };
}

const DOC = `Week 3${CONTAINER_EXTENSION}`;

describe('TauriLibrary.create', () => {
  it('writes the document immediately rather than waiting for autosave', async () => {
    const { store, lib } = library();

    const { name } = await lib.create('Week 3');

    expect(name).toBe(DOC);
    expect(await store.exists(DOC)).toBe(true);
  });

  it('gives the document a node the student can select', async () => {
    const { lib } = library();

    const { doc } = await lib.create('Week 3');

    // A document with no nodes cannot be edited, because every action needs a selection.
    expect(getChildIds(doc, ROOT_NODE_ID)).toHaveLength(1);
  });

  it('titles the document', async () => {
    const { lib } = library();

    const { doc } = await lib.create('Week 3');

    expect(getMeta(doc).title).toBe('Week 3');
  });

  it('avoids clobbering an existing document of the same name', async () => {
    const { lib } = library();

    await lib.create('Week 3');
    const second = await lib.create('Week 3');

    expect(second.name).toBe(`Week 3 2${CONTAINER_EXTENSION}`);
  });

  it('falls back to a usable name for an empty title', async () => {
    const { lib } = library();

    const { name } = await lib.create('');

    expect(name.endsWith(CONTAINER_EXTENSION)).toBe(true);
    expect(name.length).toBeGreaterThan(CONTAINER_EXTENSION.length);
  });
});

describe('TauriLibrary.open', () => {
  it('round-trips a created document', async () => {
    const { lib } = library();
    const created = await lib.create('Integration by parts');

    const opened = await lib.open(created.name);

    expect(getMeta(opened).title).toBe('Integration by parts');
    expect(getChildIds(opened, ROOT_NODE_ID)).toHaveLength(1);
  });

  it('is not an empty document — the missing await this class shipped with', async () => {
    const { lib } = library();
    const created = await lib.create('Limits');

    const opened = await lib.open(created.name);

    // `loadDocument(bytes).doc` without the await produced `undefined` and every
    // desktop open yielded a blank mind map.
    expect(opened).toBeTruthy();
    expect(getChildIds(opened, ROOT_NODE_ID)).toHaveLength(1);
  });

  it('throws for a document that is not there', async () => {
    const { lib } = library();

    await expect(lib.open(`Nope${CONTAINER_EXTENSION}`)).rejects.toThrow(/No document/);
  });

  it('refuses a path separator rather than reaching outside the library', async () => {
    const { lib } = library();

    await expect(lib.open(`../escape${CONTAINER_EXTENSION}`)).rejects.toThrow(/separator/);
    await expect(lib.open(`sub/${CONTAINER_EXTENSION}`)).rejects.toThrow(/separator/);
  });
});

describe('TauriLibrary.list', () => {
  it('is empty for a new library', async () => {
    const { lib } = library();

    expect(await lib.list()).toEqual([]);
  });

  it('lists documents with their titles', async () => {
    const { lib } = library();
    await lib.create('Integration by parts');
    await lib.create('Linear algebra');

    const titles = (await lib.list()).map((doc) => doc.title);

    expect(titles).toContain('Integration by parts');
    expect(titles).toContain('Linear algebra');
  });

  it('orders the most recently touched first', async () => {
    const { lib } = library();
    await lib.create('Older');
    await lib.create('Newer');

    const list = await lib.list();

    expect(list[0]?.title).toBe('Newer');
  });

  it('ignores sidecars, which are not documents', async () => {
    const { store, lib } = library();
    const created = await lib.create('Week 3');

    await store.seed(`${created.name}.bak`, new Uint8Array([1]));
    await store.seed(`${created.name}.tmp`, new Uint8Array([1]));

    expect(await lib.list()).toHaveLength(1);
  });

  it('skips a file that is not a document', async () => {
    const { store, lib } = library();
    await lib.create('Week 3');

    await store.seed('notes.txt', new Uint8Array([1]));

    const titles = (await lib.list()).map((doc) => doc.title);
    expect(titles).toEqual(['Week 3']);
  });

  it('carries a modification time so the list can be ordered', async () => {
    const { lib } = library();
    await lib.create('Week 3');

    const [summary] = await lib.list();
    expect(typeof summary?.updatedAt).toBe('number');
  });
});

describe('TauriLibrary.rename', () => {
  it('moves the file to the new name', async () => {
    const { store, lib } = library();
    await lib.create('Week 3');

    await lib.rename(DOC, `Renamed${CONTAINER_EXTENSION}`);

    expect(await store.exists(DOC)).toBe(false);
    expect(await store.exists(`Renamed${CONTAINER_EXTENSION}`)).toBe(true);
  });

  it('renames the document, not just the file', async () => {
    const { lib } = library();
    await lib.create('Week 3');

    await lib.rename(DOC, `Week 4${CONTAINER_EXTENSION}`);

    // The list shows the mirrored title, so renaming only the file would leave the panel
    // still reading the old name — the rename would appear to have done nothing.
    expect((await lib.list())[0]?.title).toBe('Week 4');
    expect(getMeta(await lib.open(`Week 4${CONTAINER_EXTENSION}`)).title).toBe('Week 4');
  });

  it('refuses to overwrite another document', async () => {
    const { store, lib } = library();
    await lib.create('Week 3');
    const other = await lib.create('Week 4');

    await expect(lib.rename(other.name, DOC)).rejects.toThrow(/already exists/);

    // Nothing moved.
    expect(await store.exists(DOC)).toBe(true);
    expect(await store.exists(other.name)).toBe(true);
  });

  it('leaves the old backup name behind, which would resurrect it', async () => {
    const { store, lib } = library();
    await lib.create('Week 3');
    await store.seed(`${DOC}.bak`, new Uint8Array([1, 2]));

    await lib.rename(DOC, `Renamed${CONTAINER_EXTENSION}`);

    // Restoring a backup named after the old title would bring the document back under
    // the name the student just gave up.
    expect(await store.exists(`${DOC}.bak`)).toBe(false);
  });

  it('throws for a document that is not there', async () => {
    const { lib } = library();

    await expect(lib.rename(`Nope${CONTAINER_EXTENSION}`, `Other${CONTAINER_EXTENSION}`)).rejects.toThrow(
      /No document/,
    );
  });

  it('refuses a path separator', async () => {
    const { lib } = library();
    await lib.create('Week 3');

    await expect(lib.rename(DOC, `sub/${CONTAINER_EXTENSION}`)).rejects.toThrow(/separator/);
  });
});

describe('TauriLibrary.remove', () => {
  it('deletes the document and its sidecars', async () => {
    const { store, lib } = library();
    await lib.create('Week 3');
    await store.seed(`${DOC}.bak`, new Uint8Array([1]));
    await store.seed(`${DOC}.tmp`, new Uint8Array([1]));

    await lib.remove(DOC);

    expect(await store.exists(DOC)).toBe(false);
    expect(await store.exists(`${DOC}.bak`)).toBe(false);
    expect(await store.exists(`${DOC}.tmp`)).toBe(false);
  });

  it('refuses a path separator', async () => {
    const { lib } = library();

    await expect(lib.remove(`../escape${CONTAINER_EXTENSION}`)).rejects.toThrow(/separator/);
  });
});

describe('the storage the library is given', () => {
  it('only needs BinaryStorage plus modifiedAt', async () => {
    // Documents the seam this class was given. `TauriLibrary` used to demand the
    // concrete `TauriStorage`, which is precisely why this file could not be tested.
    const store: LibraryStorage = new TestStorage();
    const lib = new TauriLibrary(store);

    await lib.create('Week 3');
    const opened: YDoc = await lib.open(DOC);

    expect(getChildIds(opened, ROOT_NODE_ID)).toHaveLength(1);
  });

  it('is satisfied by a plain BinaryStorage for everything else', async () => {
    const plain: BinaryStorage = new MemoryStorage();
    expect(typeof plain.list).toBe('function');
  });
});