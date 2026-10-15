import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  CONTAINER_EXTENSION,
  MemoryStorage,
  buildDocument,
  createDoc,
  createNode,
  getChildIds,
  getMeta,
  loadDocument,
  ROOT_NODE_ID,
  type BinaryStorage,
} from '@adnota/core';
import {
  basename,
  newMemoryStore,
  openExternalPath,
  openNamed,
  setPreferenceStore,
  resetRecent,
} from '../src/session.ts';

/**
 * Opening a document from outside the library.
 *
 * Open… is the one route out of the `Documents/Adnota` folder, and it is also the one
 * route by which a path the user did not create reaches the app. Two properties matter
 * and are tested here: the document is genuinely opened, and it is copied into the
 * library rather than edited in place, so autosave and its backup sidecar still have a
 * file of their own to work on.
 */

beforeEach(() => {
  setPreferenceStore(newMemoryStore());
  resetRecent();
});

afterEach(() => {
  setPreferenceStore(newMemoryStore());
  resetRecent();
});

async function containerFor(title: string, nodes: string[] = []): Promise<Uint8Array> {
  const doc = createDoc(title);
  for (const name of nodes) {
    const id = createNode(doc, { parentId: ROOT_NODE_ID });
    const { setLabel } = await import('@adnota/core');
    setLabel(doc, id, { type: 'doc', content: [{ type: 'text', text: name }] });
  }
  return (await buildDocument(doc, new Map())).bytes;
}

describe('basename', () => {
  it('takes the last segment of a Windows path', () => {
    expect(basename(String.raw`C:\Users\sam\Documents\Week 3.adnota`)).toBe('Week 3.adnota');
  });

  it('takes the last segment of a POSIX path', () => {
    expect(basename('/home/sam/notes/Week 3.adnota')).toBe('Week 3.adnota');
  });

  it('copes with a bare filename', () => {
    expect(basename('Week 3.adnota')).toBe('Week 3.adnota');
  });

  it('falls back rather than returning an empty name', () => {
    expect(basename('')).toBe(`Untitled${CONTAINER_EXTENSION}`);
  });

  it('ignores a trailing separator', () => {
    expect(basename('/home/sam/notes/')).toBe('notes');
  });
});

describe('openExternalPath', () => {
  /** Stand-in for the Rust command: reads from a fixed map of absolute paths. */
  const outside = new Map<string, Uint8Array>();
  const read = async (path: string): Promise<Uint8Array> => {
    const bytes = outside.get(path);
    if (!bytes) throw new Error(`not found: ${path}`);
    return bytes;
  };

  it('opens a document from anywhere on disk', async () => {
    const path = String.raw`C:\Users\sam\Documents\Week 3.adnota`;
    outside.set(path, await containerFor('Week 3', ['Limits']));
    const storage = new MemoryStorage();

    const open = await openExternalPath(storage, read, path);

    expect(getMeta(open.doc).title).toBe('Week 3');
    expect(getChildIds(open.doc, ROOT_NODE_ID)).toHaveLength(1);
  });

  it('copies the document into the library', async () => {
    // Adnota edits a file it owns. Editing the original in place would mean two
    // programs writing one `.adnota`, with neither one's backup sidecar meaning much.
    const path = String.raw`C:\Users\sam\Documents\Week 3.adnota`;
    outside.set(path, await containerFor('Week 3', ['Limits']));
    const storage = new MemoryStorage();

    const open = await openExternalPath(storage, read, path);

    expect(open.filename).toBe(`Week 3${CONTAINER_EXTENSION}`);
    expect(await storage.exists(open.filename)).toBe(true);
  });

  it('names the copy after the original file', async () => {
    const path = '/home/sam/notes/Linear algebra.adnota';
    outside.set(path, await containerFor('Linear algebra'));
    const storage = new MemoryStorage();

    const open = await openExternalPath(storage, read, path);

    expect(open.filename).toBe(`Linear algebra${CONTAINER_EXTENSION}`);
  });

  it('does not clobber a library document with the same name', async () => {
    const storage = new MemoryStorage();
    await storage.write(`Week 3${CONTAINER_EXTENSION}`, await containerFor('Already here'));

    const path = String.raw`C:\somewhere\Week 3${CONTAINER_EXTENSION}`;
    outside.set(path, await containerFor('Week 3 from elsewhere'));

    const open = await openExternalPath(storage, read, path);

    expect(open.filename).toBe(`Week 3 2${CONTAINER_EXTENSION}`);
    // The original library document is untouched.
    const existing = (await loadDocument((await storage.read(`Week 3${CONTAINER_EXTENSION}`))!)).doc;
    expect(getMeta(existing).title).toBe('Already here');
  });

  it('becomes the document that reopens next time', async () => {
    const path = '/home/sam/notes/Week 3.adnota';
    outside.set(path, await containerFor('Week 3'));
    const storage = new MemoryStorage();

    const open = await openExternalPath(storage, read, path);
    await open.session.close();

    expect(await storage.list('')).toContain(open.filename);
  });

  it('propagates a failure to read the chosen file', async () => {
    const storage = new MemoryStorage();

    // A student picking a file that turns out to be unreadable should be told, not
    // silently handed an empty mind map.
    await expect(
      openExternalPath(storage, read, String.raw`C:\nope\Missing${CONTAINER_EXTENSION}`),
    ).rejects.toThrow(/not found/);
  });

  it('rejects a file that is not a document', async () => {
    const path = '/home/sam/notes/notes.txt';
    outside.set(path, new Uint8Array([1, 2, 3]));
    const storage = new MemoryStorage();

    await expect(openExternalPath(storage, read, path)).rejects.toThrow();
  });

  it('leaves the library empty when the open fails', async () => {
    const storage: BinaryStorage = new MemoryStorage();

    await expect(
      openExternalPath(storage, read, '/home/sam/notes/gone.adnota'),
    ).rejects.toThrow();

    expect(await storage.list('')).toEqual([]);
  });
});

describe('openNamed', () => {
  it('still refuses a path outside the library', async () => {
    // The two routes are kept apart on purpose: a library name is relative to the base,
    // and an absolute path must never be silently accepted by this path.
    const storage = new MemoryStorage();

    await expect(
      openNamed(storage, String.raw`C:\Users\sam\Documents\Week 3${CONTAINER_EXTENSION}`),
    ).rejects.toThrow(/No document called/);
  });

  it('opens a library document by name', async () => {
    const storage = new MemoryStorage();
    await storage.write(`Week 3${CONTAINER_EXTENSION}`, await containerFor('Week 3', ['Limits']));

    const open = await openNamed(storage, `Week 3${CONTAINER_EXTENSION}`);

    expect(getMeta(open.doc).title).toBe('Week 3');
    expect(open.existed).toBe(true);
  });
});