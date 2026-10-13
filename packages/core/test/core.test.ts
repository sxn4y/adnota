import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ROOT_NODE_ID,
  allNodes,
  buildDocument,
  createDoc,
  createNode,
  emptyLabel,
  getAssets,
  getChildIds,
  getMeta,
  getNode,
  getShapes,
  getStrokes,
  loadDocument,
  mergeDocuments,
  moveNode,
  putAsset,
  putStroke,
  removeNode,
  setCollapsed,
  setLabel,
  subtreeIds,
  type AssetBlob,
  type InlineDoc,
} from '@adnota/core';

function label(text: string): InlineDoc {
  return { type: 'doc', content: [{ type: 'text', text }] };
}

const noAssets: ReadonlyMap<string, AssetBlob> = new Map();

describe('document model', () => {
  it('creates a document with a root and empty metadata', () => {
    const doc = createDoc('Week 3');

    const root = getNode(doc, ROOT_NODE_ID);
    expect(root).not.toBeNull();
    expect(root?.parentId).toBeNull();
    expect(getMeta(doc).title).toBe('Week 3');
    expect(getChildIds(doc, ROOT_NODE_ID)).toHaveLength(0);
  });

  it('adds children in order and reads them back', () => {
    const doc = createDoc();
    const a = createNode(doc, { parentId: ROOT_NODE_ID });
    const b = createNode(doc, { parentId: ROOT_NODE_ID });
    const c = createNode(doc, { parentId: ROOT_NODE_ID });

    expect(getChildIds(doc, ROOT_NODE_ID)).toEqual([a, b, c]);
    expect(getNode(doc, a)?.parentId).toBe(ROOT_NODE_ID);
  });

  it('inserts at an explicit index', () => {
    const doc = createDoc();
    const a = createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: ROOT_NODE_ID });
    const middle = createNode(doc, { parentId: ROOT_NODE_ID, index: 1 });

    expect(getChildIds(doc, ROOT_NODE_ID)[1]).toBe(middle);
    expect(getChildIds(doc, ROOT_NODE_ID)).toContain(a);
  });

  it('removes a node together with its whole subtree', () => {
    const doc = createDoc();
    const parent = createNode(doc, { parentId: ROOT_NODE_ID });
    const child = createNode(doc, { parentId: parent });
    const grandchild = createNode(doc, { parentId: child });
    const survivor = createNode(doc, { parentId: ROOT_NODE_ID });

    expect(subtreeIds(doc, parent)).toEqual([child, grandchild]);

    removeNode(doc, parent);

    expect(getNode(doc, parent)).toBeNull();
    expect(getNode(doc, child)).toBeNull();
    expect(getNode(doc, grandchild)).toBeNull();
    expect(getNode(doc, survivor)).not.toBeNull();
    expect(getChildIds(doc, ROOT_NODE_ID)).toEqual([survivor]);
  });

  it('refuses to move a node into its own subtree', () => {
    const doc = createDoc();
    const parent = createNode(doc, { parentId: ROOT_NODE_ID });
    const child = createNode(doc, { parentId: parent });

    moveNode(doc, parent, child);

    expect(getNode(doc, parent)?.parentId).toBe(ROOT_NODE_ID);
  });

  it('reparents a node and detaches it from its old siblings', () => {
    const doc = createDoc();
    const a = createNode(doc, { parentId: ROOT_NODE_ID });
    const b = createNode(doc, { parentId: ROOT_NODE_ID });
    const target = createNode(doc, { parentId: ROOT_NODE_ID });

    moveNode(doc, b, a);

    expect(getChildIds(doc, ROOT_NODE_ID)).toEqual([a, target]);
    expect(getChildIds(doc, a)).toEqual([b]);
    expect(getNode(doc, b)?.parentId).toBe(a);
  });

  it('discards ink anchored to a removed subtree', () => {
    const doc = createDoc();
    const parent = createNode(doc, { parentId: ROOT_NODE_ID });
    const child = createNode(doc, { parentId: parent });

    putStroke(doc, {
      id: 's1',
      points: [{ x: 0, y: 0, pressure: 0.5 }],
      color: '#000',
      width: 2,
      tool: 'pen',
      opacity: 1,
      anchorNodeId: child,
      anchorOrigin: { x: 10, y: 10 },
    });
    putStroke(doc, {
      id: 's2',
      points: [{ x: 0, y: 0, pressure: 0.5 }],
      color: '#000',
      width: 2,
      tool: 'pen',
      opacity: 1,
      anchorNodeId: null,
      anchorOrigin: null,
    });

    removeNode(doc, parent);

    expect(doc.getMap('strokes').has('s1')).toBe(false);
    expect(doc.getMap('strokes').has('s2')).toBe(true);
  });

  it('hides the subtree of a collapsed node when walking', () => {
    const doc = createDoc();
    const parent = createNode(doc, { parentId: ROOT_NODE_ID });
    const child = createNode(doc, { parentId: parent });

    const seen: string[] = [];
    const walk = (): void => {
      seen.length = 0;
      const recurse = (id: string): void => {
        for (const childId of getChildIds(doc, id)) {
          seen.push(childId);
          if (!getNode(doc, childId)?.collapsed) recurse(childId);
        }
      };
      recurse(ROOT_NODE_ID);
    };

    walk();
    expect(seen).toEqual([parent, child]);

    setCollapsed(doc, parent, true);
    walk();
    expect(seen).toEqual([parent]);
  });
});

describe('container format', () => {
  it('round-trips a document without loss', async () => {
    const doc = createDoc('Biology');
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    const child = createNode(doc, { parentId: root });
    setLabel(doc, child, label('Mitochondria'));
    setLabel(doc, root, label('Cell'));

    const { bytes, update } = await buildDocument(doc, noAssets);
    const loaded = await loadDocument(bytes);

    expect(getMeta(loaded.doc).title).toBe('Biology');
    expect(getChildIds(loaded.doc, ROOT_NODE_ID)).toEqual([root]);
    expect(getChildIds(loaded.doc, root)).toEqual([child]);
    expect(getNode(loaded.doc, child)?.label).toEqual(label('Mitochondria'));

    // The stored document state must be identical, not merely equivalent.
    expect(Y.encodeStateAsUpdate(loaded.doc)).toEqual(update);
  });

  it('produces byte-identical output when re-saving an unchanged document', async () => {
    // The invariant that matters is that the encoder introduces no nondeterminism:
    // saving the same document twice must not change the file, or the format is
    // useless for diffing and for deduplicating synced copies.
    const doc = createDoc('Deterministic');
    const node = createNode(doc, { parentId: ROOT_NODE_ID });
    setLabel(doc, node, label('Cell'));

    const first = await buildDocument(doc, noAssets);
    const second = await buildDocument(doc, noAssets);

    expect(second.bytes).toEqual(first.bytes);
  });

  it('preserves LaTeX in a node label', async () => {
    const doc = createDoc();
    const node = createNode(doc, { parentId: ROOT_NODE_ID });
    setLabel(doc, node, {
      type: 'doc',
      content: [
        { type: 'text', text: 'where ' },
        { type: 'math_inline', latex: String.raw`\int_0^1 x^2\,dx` },
      ],
    });

    const { bytes } = await buildDocument(doc, noAssets);
    const loaded = await loadDocument(bytes);

    expect(getNode(loaded.doc, node)?.label).toEqual({
      type: 'doc',
      content: [
        { type: 'text', text: 'where ' },
        { type: 'math_inline', latex: String.raw`\int_0^1 x^2\,dx` },
      ],
    });
  });

  it('embeds assets and reads them back', async () => {
    const doc = createDoc('With image');
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

    putAsset(doc, {
      id: 'a1',
      mime: 'image/png',
      byteLength: bytes.byteLength,
      width: 1,
      height: 1,
      hash: 'abc123',
      extension: 'png',
    });

    const blobs: ReadonlyMap<string, AssetBlob> = new Map([
      ['abc123', { hash: 'abc123', extension: 'png', bytes }],
    ]);

    const { bytes: container } = await buildDocument(doc, blobs);
    const loaded = await loadDocument(container);

    expect(loaded.assets.size).toBe(1);
    expect(loaded.assets.get('abc123')?.bytes).toEqual(bytes);
  });

  it('refuses to save when a referenced asset is missing', async () => {
    const doc = createDoc();

    putAsset(doc, {
      id: 'a1',
      mime: 'image/png',
      byteLength: 10,
      width: null,
      height: null,
      hash: 'deadbeef',
      extension: 'png',
    });

    await expect(buildDocument(doc, noAssets)).rejects.toThrow(/asset\(s\) missing/);
  });

  it('skips malformed entries rather than failing the whole document', async () => {
    // Regression: a value that is not a Y.Map (written by an older build, or by
    // something that edited the file directly) must not crash the readers. Losing one
    // bad record is recoverable; refusing to open the document is not.
    const doc = createDoc('Resilient');
    const good = createNode(doc, { parentId: ROOT_NODE_ID });

    doc.getMap('assets').set('bogus', { id: 'bogus', hash: 'x' } as never);
    doc.getMap('assets').set('alsoBogus', 42 as never);
    doc.getMap('nodes').set('bogus-node', 'not a map' as never);
    doc.getMap('strokes').set('bogus-stroke', null as never);
    doc.getMap('shapes').set('bogus-shape', 7 as never);

    expect(() => getAssets(doc)).not.toThrow();
    expect(getAssets(doc)).toEqual([]);
    expect(() => getStrokes(doc)).not.toThrow();
    expect(() => getShapes(doc)).not.toThrow();
    expect(() => allNodes(doc)).not.toThrow();
    expect(getNode(doc, good)).not.toBeNull();
    expect(getNode(doc, 'bogus-node')).toBeNull();
  });

  it('rejects a file it cannot recognise', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(loadDocument(garbage)).rejects.toThrow();
  });
});

describe('collaborative merge', () => {
  it('unions edits made independently in two copies', async () => {
    // A shared starting point, then two people diverge from it.
    const base = createDoc('Shared');
    const branch = createNode(base, { parentId: ROOT_NODE_ID });
    setLabel(base, branch, label('Homeostasis'));
    const { bytes: baseBytes } = await buildDocument(base, noAssets);

    const left = (await loadDocument(baseBytes)).doc;
    const right = (await loadDocument(baseBytes)).doc;

    createNode(left, { parentId: ROOT_NODE_ID });
    createNode(right, { parentId: ROOT_NODE_ID });

    const [leftBytes, rightBytes] = await Promise.all([
      buildDocument(left, noAssets),
      buildDocument(right, noAssets),
    ]);

    const merged = await loadDocument(await mergeDocuments(leftBytes.bytes, rightBytes.bytes));

    // Both divergent additions survive the merge.
    expect(getChildIds(merged.doc, ROOT_NODE_ID)).toHaveLength(3);
    expect(getNode(merged.doc, branch)?.label).toEqual(label('Homeostasis'));
  });

  it('merges concurrent edits to different fields of the same node', async () => {
    const base = createDoc();
    const node = createNode(base, { parentId: ROOT_NODE_ID });
    const { bytes: baseBytes } = await buildDocument(base, noAssets);

    const left = (await loadDocument(baseBytes)).doc;
    const right = (await loadDocument(baseBytes)).doc;

    // One person renames it, the other collapses it. Neither should lose their work.
    setLabel(left, node, label('Mitosis'));
    setCollapsed(right, node, true);

    const [leftBytes, rightBytes] = await Promise.all([
      buildDocument(left, noAssets),
      buildDocument(right, noAssets),
    ]);

    const merged = await loadDocument(await mergeDocuments(leftBytes.bytes, rightBytes.bytes));
    const mergedNode = getNode(merged.doc, node);

    expect(mergedNode?.label).toEqual(label('Mitosis'));
    expect(mergedNode?.collapsed).toBe(true);
  });
});

describe('labels', () => {
  it('treats an empty label as an empty document, not null', () => {
    expect(emptyLabel()).toEqual({ type: 'doc', content: [] });
  });
});
