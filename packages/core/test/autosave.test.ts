import { describe, expect, it } from 'vitest';
import {
  BACKUP_SUFFIX,
  DocumentSession,
  MemoryStorage,
  createDoc,
  createNode,
  getChildIds,
  getMeta,
  loadDocument,
  setTitle,
  ROOT_NODE_ID,
} from '@adnota/core';

const PATH = '/notes/week3.adnota';

describe('autosave', () => {
  it('debounces rapid edits into a single write', async () => {
    const doc = createDoc('Debounced');
    const storage = new MemoryStorage();

    // Counted through the real save path rather than by stubbing save(), so the
    // debounce and the write it guards are both exercised.
    let saves = 0;
    const session = new DocumentSession(doc, PATH, storage, {
      debounceMs: 20,
      onSaved: () => {
        saves += 1;
      },
    });

    createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: ROOT_NODE_ID });
    expect(session.state.dirty).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(saves).toBe(1);
    expect(session.state.dirty).toBe(false);
    expect(getChildIds((await loadDocument((await storage.read(PATH))!)).doc, ROOT_NODE_ID)).toHaveLength(3);
  });

  it('writes the document and clears the dirty flag', async () => {
    const doc = createDoc('Persisted');
    const storage = new MemoryStorage();
    const session = new DocumentSession(doc, PATH, storage, { debounceMs: 5 });

    createNode(doc, { parentId: ROOT_NODE_ID });
    expect(session.state.dirty).toBe(true);

    await session.save();

    expect(session.state.dirty).toBe(false);
    expect(session.state.lastError).toBeNull();
    expect(await storage.exists(PATH)).toBe(true);

    const loaded = await loadDocument((await storage.read(PATH))!);
    expect(getMeta(loaded.doc).title).toBe('Persisted');
    expect(getChildIds(loaded.doc, ROOT_NODE_ID)).toHaveLength(1);
  });

  it('keeps the previous file as a .bak sidecar', async () => {
    const doc = createDoc('v1');
    const storage = new MemoryStorage();
    const session = new DocumentSession(doc, PATH, storage, { debounceMs: 5 });

    await session.save();
    expect(await storage.exists(`${PATH}${BACKUP_SUFFIX}`)).toBe(false);

    setTitle(doc, 'v2');
    await session.save();

    const backup = await storage.read(`${PATH}${BACKUP_SUFFIX}`);
    expect(backup).not.toBeNull();
    expect(getMeta((await loadDocument(backup!)).doc).title).toBe('v1');
    expect(getMeta((await loadDocument((await storage.read(PATH))!)).doc).title).toBe('v2');
  });

  it('leaves no temporary file behind after a successful save', async () => {
    const doc = createDoc();
    const storage = new MemoryStorage();
    const session = new DocumentSession(doc, PATH, storage, { debounceMs: 5 });

    await session.save();

    expect(storage.keys().some((key) => key.endsWith('.tmp'))).toBe(false);
  });

  it('serialises concurrent saves rather than racing them', async () => {
    const doc = createDoc();
    const storage = new MemoryStorage();
    const session = new DocumentSession(doc, PATH, storage, { debounceMs: 5 });

    createNode(doc, { parentId: ROOT_NODE_ID });
    await Promise.all([session.save(), session.save(), session.save()]);

    // Whichever write landed last, the file must be intact and readable.
    const bytes = await storage.read(PATH);
    expect(bytes).not.toBeNull();
    const loaded = await loadDocument(bytes!);
    expect(getChildIds(loaded.doc, ROOT_NODE_ID)).toHaveLength(1);
    expect(storage.keys().some((key) => key.endsWith('.tmp'))).toBe(false);
  });

  it('stays writable after a failed save', async () => {
    const doc = createDoc();
    const session = new DocumentSession(doc, PATH, new MemoryStorage(), { debounceMs: 5 });

    // Fail once by making the asset provider throw, which is the same path a real
    // IO failure would take.
    let failNext = true;
    session.setAssetProvider(() => {
      if (failNext) {
        failNext = false;
        throw new Error('simulated failure');
      }
      return new Map();
    });

    createNode(doc, { parentId: ROOT_NODE_ID });
    await expect(session.save()).rejects.toThrow('simulated failure');
    expect(session.state.lastError).toBe('simulated failure');

    // A single failure must not wedge the session.
    await session.save();
    expect(session.state.lastError).toBeNull();
    expect(session.state.dirty).toBe(false);
  });

  it('restores the backup over the current file', async () => {
    const doc = createDoc('good');
    const storage = new MemoryStorage();
    const session = new DocumentSession(doc, PATH, storage, { debounceMs: 5 });

    await session.save();
    setTitle(doc, 'bad');
    await session.save();

    const restored = await session.restoreBackup();

    expect(restored).toBe(true);
    expect(getMeta((await loadDocument((await storage.read(PATH))!)).doc).title).toBe('good');
  });

  it('reports no backup when none exists', async () => {
    const doc = createDoc();
    const storage = new MemoryStorage();
    const session = new DocumentSession(doc, PATH, storage, { debounceMs: 5 });

    await session.save();

    expect(await session.restoreBackup()).toBe(false);
  });
});
