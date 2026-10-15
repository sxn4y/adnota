import { describe, expect, it } from 'vitest';
import {
  CONTAINER_EXTENSION,
  MemoryStorage,
  buildDocument,
  createDoc,
  readSummary,
  sortSummaries,
  titleFromName,
  type DocumentSummary,
} from '@adnota/core';

async function containerWith(title: string): Promise<Uint8Array> {
  const { bytes } = await buildDocument(createDoc(title), new Map(), { title });
  return bytes;
}

describe('titleFromName', () => {
  it('drops the extension', () => {
    expect(titleFromName(`Week 3${CONTAINER_EXTENSION}`)).toBe('Week 3');
  });

  it('turns separators into spaces rather than leaving underscores', () => {
    expect(titleFromName('week_3.notes.adnota')).toBe('week 3 notes');
  });

  it('copes with a name that is only an extension', () => {
    expect(titleFromName(CONTAINER_EXTENSION)).toBe('');
  });
});

describe('readSummary', () => {
  it('reads the title written into the container', async () => {
    const summary = await readSummary('x.adnota', await containerWith('Integration by parts'));

    expect(summary.title).toBe('Integration by parts');
    expect(summary.name).toBe('x.adnota');
  });

  it('falls back to the filename for a container with no title', async () => {
    // Built by hand because `buildDocument` always writes the title now. Files written
    // before the field existed are the real case, and they must still list.
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('format.json', JSON.stringify({ format: 1, app: 'adnota', generator: 'adnota/old', createdAt: 0 }));
    zip.file('doc.yjs', new Uint8Array([0]));

    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const summary = await readSummary('Semester one.adnota', bytes);

    expect(summary.title).toBe('Semester one');
  });

  it('falls back to the filename for bytes that are not a document at all', async () => {
    const summary = await readSummary('broken.adnota', new Uint8Array([1, 2, 3, 4]));

    expect(summary.title).toBe('broken');
    expect(summary.updatedAt).toBeNull();
  });

  it('never throws, because one bad file must not hide the rest of the library', async () => {
    await expect(readSummary('bad.adnota', new Uint8Array(0))).resolves.toBeTruthy();
    await expect(readSummary('bad.adnota', new Uint8Array([0xff, 0xfe, 0xfd]))).resolves.toBeTruthy();
  });

  it('leaves the modified time to the filesystem', async () => {
    // Asserted so the reason stays attached to the decision: a wall-clock value inside
    // the container would break byte-identical re-saving.
    const summary = await readSummary('x.adnota', await containerWith('T'));

    expect(summary.updatedAt).toBeNull();
  });
});

describe('sortSummaries', () => {
  const at = (name: string, updatedAt: number | null): DocumentSummary => ({
    name,
    title: name,
    updatedAt,
  });

  it('puts the most recent first', () => {
    const sorted = sortSummaries([at('old', 100), at('new', 300), at('mid', 200)]);

    expect(sorted.map((s) => s.name)).toEqual(['new', 'mid', 'old']);
  });

  it('puts undated documents last rather than first', () => {
    const sorted = sortSummaries([at('unknown', null), at('known', 100)]);

    expect(sorted.map((s) => s.name)).toEqual(['known', 'unknown']);
  });

  it('is stable by title when timestamps tie', () => {
    const sorted = sortSummaries([at('b', 100), at('a', 100)]);

    expect(sorted.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('does not mutate its input', () => {
    const input = [at('b', 100), at('a', 200)];

    sortSummaries(input);

    expect(input.map((s) => s.name)).toEqual(['b', 'a']);
  });
});

describe('container determinism', () => {
  it('still produces byte-identical output when re-saving an unchanged document', async () => {
    // The reason the modified time lives on the filesystem rather than in the
    // container: a value that changed on every save would break this.
    const doc = createDoc('Deterministic');
    const { createNode, ROOT_NODE_ID, setLabel } = await import('@adnota/core');
    const node = createNode(doc, { parentId: ROOT_NODE_ID });
    setLabel(doc, node, { type: 'doc', content: [{ type: 'text', text: 'Cell' }] });

    const first = await buildDocument(doc, new Map());
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await buildDocument(doc, new Map());

    expect([...second.bytes]).toEqual([...first.bytes]);
  });

  it('mirrors the title into the header so listing need not open the document', async () => {
    const doc = createDoc('Readable without opening');
    const { bytes } = await buildDocument(doc, new Map());

    expect((await readSummary('any-name.adnota', bytes)).title).toBe('Readable without opening');
  });
});

describe('MemoryStorage still satisfies the library contract', () => {
  it('can create, read back, and remove', async () => {
    const storage = new MemoryStorage();
    const bytes = await containerWith('Notes');

    await storage.write('Notes.adnota', bytes);
    expect(await storage.exists('Notes.adnota')).toBe(true);

    await storage.remove('Notes.adnota');
    expect(await storage.exists('Notes.adnota')).toBe(false);
  });
});
