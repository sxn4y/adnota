import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryStorage,
  createDoc,
  createNode,
  getChildIds,
  getMeta,
  loadDocument,
  setTitle,
  ROOT_NODE_ID,
  type DocumentSession,
} from '@adnota/core';
import {
  freshNameFor,
  listRecent,
  newMemoryStore,
  openOrCreate,
  recallRecent,
  remember,
  resetRecent,
  setPreferenceStore,
} from '../src/session.ts';

/**
 * Document lifecycle.
 *
 * Run against `MemoryStorage` rather than the Tauri bridge, because everything being
 * tested here is policy — which file opens, what a fresh one is called, when it is
 * remembered — and policy is exactly the part that should not need a window to verify.
 * The bridge beneath it has its own Rust tests against a real temporary directory.
 */

beforeEach(() => {
  resetRecent();
});

afterEach(() => {
  resetRecent();
});

function label(text: string): { type: 'doc'; content: { type: 'text'; text: string }[] } {
  return { type: 'doc', content: [{ type: 'text', text }] };
}

/** Write raw bytes into the recent list, bypassing the parser the code under test uses. */
function corruptRecent(raw: string): void {
  // The key is duplicated from the module rather than imported, because the point is
  // to write a value the module's own API would never produce.
  const backing = newMemoryStore();
  backing.set('adnota.recent.v1', raw);
  setPreferenceStore({
    get: (key) => backing.get(key),
    set: (key, value) => backing.set(key, value),
    remove: (key) => backing.remove(key),
  });
}

describe('openOrCreate', () => {
  it('creates a fresh document when nothing was requested', async () => {
    const storage = new MemoryStorage();
    const open = await openOrCreate(storage, null);

    expect(open.filename).toBe('Untitled.adnota');
    expect(open.existed).toBe(false);
    expect(getMeta(open.doc).title).toBe('Untitled');
  });

  it('gives a new document a root node, so the app is not a dead end', async () => {
    const storage = new MemoryStorage();
    const open = await openOrCreate(storage, null);

    // Every action in the app — Tab, Enter, the toolbar, the outline — requires a
    // selected node. A brand-new document with no nodes therefore opens to a canvas the
    // student cannot do anything with and no obvious way out.
    const children = getChildIds(open.doc, ROOT_NODE_ID);
    expect(children).toHaveLength(1);
  });


  it('does not collide with an existing Untitled', async () => {
    const storage = new MemoryStorage();
    await storage.write('Untitled.adnota', new Uint8Array([1]));

    const open = await openOrCreate(storage, null);

    expect(open.filename).toBe('Untitled 2.adnota');
    expect(open.existed).toBe(false);
  });

  it('loads an existing document and reports that it existed', async () => {
    const storage = new MemoryStorage();
    const source = createDoc('Week 3');
    const id = createNode(source, { parentId: ROOT_NODE_ID });
    const { setLabel } = await import('@adnota/core');
    setLabel(source, id, label('Definite integrals'));
    const { buildDocument } = await import('@adnota/core');
    const { bytes } = await buildDocument(source, new Map());
    await storage.write('Week 3.adnota', bytes);

    const open = await openOrCreate(storage, 'Week 3.adnota');

    expect(open.existed).toBe(true);
    expect(open.filename).toBe('Week 3.adnota');
    expect(getMeta(open.doc).title).toBe('Week 3');
    expect(getChildIds(open.doc, ROOT_NODE_ID)).toHaveLength(1);
  });

  it('creates a new document when the requested file is absent', async () => {
    const storage = new MemoryStorage();
    const open = await openOrCreate(storage, 'Gone.adnota');

    expect(open.existed).toBe(false);
    expect(open.filename).not.toBe('Gone.adnota');
  });

  it('refuses to silently replace a file it cannot parse', async () => {
    const storage = new MemoryStorage();
    // Not a ZIP: the shape a truncated or corrupted save leaves behind.
    await storage.write('Broken.adnota', new Uint8Array([1, 2, 3, 4]));

    // Overwriting it with a blank document would turn corruption into silent loss.
    await expect(openOrCreate(storage, 'Broken.adnota')).rejects.toThrow();

    const still = await storage.read('Broken.adnota');
    expect(still).not.toBeNull();
    expect([...(still ?? [])]).toEqual([1, 2, 3, 4]);
  });
});

describe('persistence round trip', () => {
  it('writes edits to disk and reads them back in a later session', async () => {
    const storage = new MemoryStorage();

    const first = await openOrCreate(storage, null);
    const created = createNode(first.doc, { parentId: ROOT_NODE_ID });
    const { setLabel } = await import('@adnota/core');
    setLabel(first.doc, created, label('Squeeze theorem'));
    setTitle(first.doc, 'Week 4');

    expect(first.session.state.dirty).toBe(true);

    await first.session.save();

    expect(first.session.state.dirty).toBe(false);
    expect(first.session.state.lastError).toBeNull();

    // A second launch, as a fresh session over the same storage.
    const second = await openOrCreate(storage, first.filename);

    expect(second.existed).toBe(true);
    expect(getMeta(second.doc).title).toBe('Week 4');

    const reloaded = await loadDocument((await storage.read(first.filename))!);
    // Two nodes: the starter root plus the one added above.
    expect(getChildIds(reloaded.doc, ROOT_NODE_ID)).toHaveLength(2);
  });

  it('keeps the previous good file as a .bak when overwriting', async () => {
    const storage = new MemoryStorage();
    const open = await openOrCreate(storage, null);

    setTitle(open.doc, 'First');
    await open.session.save();
    setTitle(open.doc, 'Second');
    await open.session.save();

    const backup = await storage.read(`${open.filename}.bak`);
    expect(backup).not.toBeNull();
    expect(getMeta((await loadDocument(backup!)).doc).title).toBe('First');
  });

  it('flushes pending edits when the session closes', async () => {
    const storage = new MemoryStorage();
    const open = await openOrCreate(storage, null);

    setTitle(open.doc, 'Unflushed');
    expect(open.session.state.dirty).toBe(true);

    await open.session.close();

    // The window can vanish at any moment; close() is the last chance to write.
    expect(open.session.state.dirty).toBe(false);
    const reloaded = await loadDocument((await storage.read(open.filename))!);
    expect(getMeta(reloaded.doc).title).toBe('Unflushed');
  });
});

describe('recent documents', () => {
  it('remembers the most recent first', () => {
    remember('a.adnota');
    remember('b.adnota');
    remember('c.adnota');

    expect(recallRecent()).toBe('c.adnota');
    expect(listRecent()).toEqual(['c.adnota', 'b.adnota', 'a.adnota']);
  });

  it('promotes a reopened document instead of duplicating it', () => {
    remember('a.adnota');
    remember('b.adnota');
    remember('a.adnota');

    expect(listRecent()).toEqual(['a.adnota', 'b.adnota']);
  });

  it('caps the list so it cannot grow without bound', () => {
    for (let i = 0; i < 40; i += 1) remember(`doc-${i}.adnota`);

    expect(listRecent().length).toBeLessThanOrEqual(10);
    expect(listRecent()[0]).toBe('doc-39.adnota');
  });

  it('reports nothing on a first run rather than throwing', () => {
    expect(recallRecent()).toBeNull();
    expect(listRecent()).toEqual([]);
  });

  it('survives corrupted stored state', () => {
    corruptRecent('not json');

    // A corrupt preference must never stop the app from starting.
    expect(recallRecent()).toBeNull();
    expect(listRecent()).toEqual([]);
  });

  it('ignores non-string entries', () => {
    corruptRecent(JSON.stringify(['a.adnota', 42, null]));

    expect(listRecent()).toEqual(['a.adnota']);
  });

  it('is written when an existing document is opened', async () => {
    const storage = new MemoryStorage();
    const { buildDocument } = await import('@adnota/core');
    const { bytes } = await buildDocument(createDoc('Existing'), new Map());
    await storage.write('Existing.adnota', bytes);

    await openOrCreate(storage, 'Existing.adnota');

    expect(recallRecent()).toBe('Existing.adnota');
  });

  it('remembers a brand-new document so the next launch reopens it', async () => {
    const storage = new MemoryStorage();

    const first = await openOrCreate(storage, null);
    expect(recallRecent()).toBe(first.filename);

    // Previously a new document was *not* remembered, on the reasoning that the file
    // might not exist yet. But autosave writes it on the first edit, so on the next
    // launch `recallRecent` returned null, a second document was created, and the
    // student's first note was stranded beside an empty one. Observed on disk as a new
    // `Untitled 2.adnota` appearing on every launch.
    setTitle(first.doc, 'Work');
    await first.session.save();

    const second = await openOrCreate(storage, recallRecent());
    expect(second.filename).toBe(first.filename);
    expect(second.existed).toBe(true);
  });

  it('reopens the document even when webview storage has been wiped', async () => {
    const storage = new MemoryStorage();

    const first = await openOrCreate(storage, null);
    setTitle(first.doc, 'Survives a reset');
    await first.session.save();

    // Simulate a cleared webview: no localStorage, no remembered list.
    resetRecent();
    setPreferenceStore(newMemoryStore());

    const second = await openOrCreate(storage, null);

    // The pointer file beside the documents is what makes this survive. Relying on
    // webview storage alone meant a "reset app data" silently stranded the student's
    // work and opened an empty document beside it.
    expect(second.filename).toBe(first.filename);
    expect(second.existed).toBe(true);
    expect(getMeta(second.doc).title).toBe('Survives a reset');
  });

  it('ignores a pointer to a file that has been deleted', async () => {
    const storage = new MemoryStorage();
    await openOrCreate(storage, 'Deleted.adnota');

    // A stale pointer must not become an error, and must not resurrect a ghost file.
    const second = await openOrCreate(storage, null);
    expect(second.existed).toBe(false);
    expect(second.filename).not.toBe('Deleted.adnota');
  });

});

describe('freshNameFor', () => {
  it('picks the first free name', () => {
    expect(freshNameFor([])).toBe('Untitled.adnota');
    expect(freshNameFor(['Untitled.adnota'])).toBe('Untitled 2.adnota');
    expect(freshNameFor(['Untitled.adnota', 'Untitled 2.adnota'])).toBe('Untitled 3.adnota');
  });
});

describe('session wiring', () => {
  it('uses a debounce short enough to feel automatic', async () => {
    const storage = new MemoryStorage();
    const open = await openOrCreate(storage, null);
    const started = Date.now();

    setTitle(open.doc, 'Typed');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(open.session.state.dirty).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await storage.exists(open.filename)).toBe(true);
  });

  it('exposes a session compatible with the shared save indicator', async () => {
    const storage = new MemoryStorage();
    const open = await openOrCreate(storage, null);

    // The view package takes this shape structurally; a mismatch here would only show
    // up as a type error in the desktop build, not in the browser harness.
    const source: { filename: string; state: DocumentSession['state']; subscribe: DocumentSession['subscribe'] } = {
      filename: open.filename,
      state: open.session.state,
      subscribe: (listener) => open.session.subscribe(listener),
    };

    let seen = 0;
    const stop = source.subscribe(() => {
      seen += 1;
    });

    setTitle(open.doc, 'Observed');
    expect(seen).toBeGreaterThan(1);

    stop();
  });
});
