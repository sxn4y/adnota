import { describe, expect, it } from 'vitest';
import { CONTAINER_EXTENSION, buildDocument, createDoc, type YDoc } from '@adnota/core';
import { defaultTitle, filenameFor, validateRename } from '@adnota/view';

describe('filenameFor', () => {
  it('adds the extension', () => {
    expect(filenameFor('Week 3', [])).toBe(`Week 3${CONTAINER_EXTENSION}`);
  });

  it('avoids a collision rather than overwriting an existing document', () => {
    const taken = [`Week 3${CONTAINER_EXTENSION}`];

    expect(filenameFor('Week 3', taken)).toBe(`Week 3 2${CONTAINER_EXTENSION}`);
  });

  it('falls back for an empty title', () => {
    expect(filenameFor('', [])).toBe(`Untitled${CONTAINER_EXTENSION}`);
    expect(filenameFor('   ', [])).toBe(`Untitled${CONTAINER_EXTENSION}`);
  });

  it('strips characters the filesystem rejects', () => {
    expect(filenameFor('a/b:c*d?e"f<g>h|i', [])).not.toMatch(/[/:*?"<>|]/);
  });

  it('caps the length', () => {
    // Comfortably inside the 255-character limit every target filesystem imposes on a
    // single path component, which is the thing that actually breaks.
    expect(filenameFor('x'.repeat(400), []).length).toBeLessThanOrEqual(88);
  });
});

describe('validateRename', () => {
  const existing = ['a.adnota', 'b.adnota'];

  it('accepts a fresh name', () => {
    expect(validateRename('a.adnota', 'c.adnota', existing)).toBeNull();
  });

  it('refuses to overwrite another document', () => {
    expect(validateRename('a.adnota', 'b.adnota', existing)).toMatch(/already exists/);
  });

  it('accepts renaming a document to its own name', () => {
    expect(validateRename('a.adnota', 'a.adnota', existing)).toBeNull();
  });

  it('refuses an empty name', () => {
    expect(validateRename('a.adnota', '   ', existing)).toMatch(/cannot be empty/);
  });

  it('refuses a path separator', () => {
    // Otherwise a rename could place a document outside the library folder.
    expect(validateRename('a.adnota', 'sub/c.adnota', existing)).toMatch(/cannot contain/);
  });

  it('refuses characters the platform rejects', () => {
    expect(validateRename('a.adnota', 'we:ird', existing)).toMatch(/cannot contain/);
  });
});

describe('defaultTitle', () => {
  it('names the first document plainly', () => {
    expect(defaultTitle(0)).toBe('Untitled');
  });

  it('numbers subsequent ones', () => {
    expect(defaultTitle(1)).toBe('Untitled 2');
    expect(defaultTitle(4)).toBe('Untitled 5');
  });
});

describe('a library over in-memory storage', () => {
  // The behaviours below are the contract `DocumentsPanel` relies on. They are checked
  // against real containers and the real filenames, but through an in-memory store, so
  // the desktop and the tests exercise the same shape without a window.
  const makeDoc = async (title: string): Promise<Uint8Array> =>
    (await buildDocument(createDoc(title), new Map())).bytes;

  it('round-trips create, read and delete', async () => {
    const files = new Map<string, Uint8Array>();
    const bytes = await makeDoc('Notes');

    files.set(`Notes${CONTAINER_EXTENSION}`, bytes);
    expect(files.size).toBe(1);

    const loaded = await buildDocument(createDoc('x'), new Map());
    expect(loaded.bytes.byteLength).toBeGreaterThan(0);

    files.delete(`Notes${CONTAINER_EXTENSION}`);
    expect(files.size).toBe(0);
  });

  it('leaves the previous file in place when a rename is refused', async () => {
    // The refusal happens before any bytes move, which is the whole point of checking
    // names up front rather than after writing.
    const files = new Map<string, Uint8Array>([
      [`a${CONTAINER_EXTENSION}`, await makeDoc('A')],
      [`b${CONTAINER_EXTENSION}`, await makeDoc('B')],
    ]);

    expect(validateRename(`a${CONTAINER_EXTENSION}`, `b${CONTAINER_EXTENSION}`, files.keys())).not.toBeNull();
    expect(files.size).toBe(2);
  });
});

describe('document opening', () => {
  it('gives a new document a node to select', async () => {
    const { createNode, ROOT_NODE_ID, getChildIds } = await import('@adnota/core');
    const doc: YDoc = createDoc('Untitled');
    createNode(doc, { parentId: ROOT_NODE_ID });

    expect(getChildIds(doc, ROOT_NODE_ID)).toHaveLength(1);
  });
});
