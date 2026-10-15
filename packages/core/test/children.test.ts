import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ROOT_NODE_ID,
  SCHEMA_KEYS,
  buildDocument,
  createDoc,
  createNode,
  getChildIds,
  getChildren,
  loadDocument,
  migrateChildrenLayout,
  moveNode,
  removeNode,
  setLabel,
  subtreeIds,
  walkVisible,
  childrenMap,
  nodesMap,
  type InlineDoc,
} from '@adnota/core';

/**
 * Child ordering on the node's own map.
 *
 * The children of a node used to live in a shared `Y.Map<Y.Array<NodeId>>` keyed by
 * parent id. That is a map-key conflict waiting to happen: two peers editing the same
 * parent each hold their own array under that key, and Yjs settles it last-writer-wins.
 * A whole child list was discarded, silently.
 *
 * These tests pin the replacement behaviour: the array lives on the node, so concurrent
 * pushes merge, and containers written by the old layout are moved forward on open.
 */

function label(text: string): InlineDoc {
  return { type: 'doc', content: [{ type: 'text', text }] };
}

describe('children live on the parent node', () => {
  it('stores the children array on the parent, not in a shared map', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: root });

    const stored = nodesMap(doc).get(root)?.get('children');
    expect(stored).toBeInstanceOf(Y.Array);
    expect(stored?.toArray()).toHaveLength(1);
  });

  it('writes nothing to the legacy children map for a new document', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: root });

    expect(childrenMap(doc).size).toBe(0);
  });

it('reads children back through the parent', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    const a = createNode(doc, { parentId: root });
    const b = createNode(doc, { parentId: root });

    expect(getChildIds(doc, root)).toEqual([a, b]);
    expect(getChildren(doc, root)).toHaveLength(2);
  });

  it('keeps sibling order across insert, move and remove', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    const a = createNode(doc, { parentId: root });
    const b = createNode(doc, { parentId: root });
    const c = createNode(doc, { parentId: root });

    expect(getChildIds(doc, root)).toEqual([a, b, c]);

    moveNode(doc, c, root, 0);
    expect(getChildIds(doc, root)).toEqual([c, a, b]);

    removeNode(doc, a);
    expect(getChildIds(doc, root)).toEqual([c, b]);
  });

  it('walks and gathers subtrees from the parent array', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    const mid = createNode(doc, { parentId: root });
    const leaf = createNode(doc, { parentId: mid });

    expect(subtreeIds(doc, root)).toEqual([mid, leaf]);

    // `walkVisible` starts at the document root, so it visits every node in order,
    // `root` included — the order a student reads in.
    const seen: string[] = [];
    walkVisible(doc, (node) => seen.push(node.id));
    expect(seen).toEqual([root, mid, leaf]);
  });

  it('a moved node leaves the old parent', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    const one = createNode(doc, { parentId: root });
    const two = createNode(doc, { parentId: root });

    moveNode(doc, two, one);

    expect(getChildIds(doc, root)).toEqual([one]);
    expect(getChildIds(doc, one)).toEqual([two]);
  });
});

describe('concurrent edits merge', () => {
  it('two peers adding children to the same parent keep everything', () => {
    // The regression this layout change exists for.
    const base = createDoc('Shared');
    const root = createNode(base, { parentId: ROOT_NODE_ID });

    const a = createDoc('A');
    const b = createDoc('B');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base));

    createNode(a, { parentId: root });
    createNode(a, { parentId: root });
    createNode(b, { parentId: root });

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    expect(getChildIds(a, root)).toHaveLength(3);
    expect(getChildIds(b, root)).toHaveLength(3);
  });

  it('concurrent edits to the same node’s label keep one of them rather than corrupting', () => {
    const base = createDoc('Shared');
    const root = createNode(base, { parentId: ROOT_NODE_ID });

    const a = createDoc('A');
    const b = createDoc('B');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base));

    setLabel(a, root, label('From A'));
    setLabel(b, root, label('From B'));

    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Last writer wins on a single scalar field, which is fine: the point is that the
    // documents agree and neither is corrupt.
    expect(getChildren(a, ROOT_NODE_ID)[0]?.label).toEqual(getChildren(b, ROOT_NODE_ID)[0]?.label);
  });
});

/** Build a document in the legacy layout, where children live in the shared map. */
function legacyDocument(): Y.Doc {
  const doc = new Y.Doc();

  doc.transact(() => {
    const root = new Y.Map<unknown>();
    root.set('id', ROOT_NODE_ID);
    root.set('parentId', null);
    root.set('label', { type: 'doc', content: [{ type: 'text', text: 'Legacy' }] });
    root.set('collapsed', false);
    nodesMap(doc).set(ROOT_NODE_ID, root);

    const order = new Y.Array<string>();
    const childId = 'n_legacy_child';
    const child = new Y.Map<unknown>();
    child.set('id', childId);
    child.set('parentId', ROOT_NODE_ID);
    child.set('label', { type: 'doc', content: [{ type: 'text', text: 'Old child' }] });
    child.set('collapsed', false);
    nodesMap(doc).set(childId, child);

    order.insert(0, [childId]);
    childrenMap(doc).set(ROOT_NODE_ID, order);
  });

  return doc;
}

describe('migrateChildrenLayout', () => {
  it('reads a legacy document before migrating', () => {
    const doc = legacyDocument();

    // The read path falls back, so an old file opens rather than showing an empty map.
    expect(getChildIds(doc, ROOT_NODE_ID)).toEqual(['n_legacy_child']);
  });

  it('moves the order onto the parent node', () => {
    const doc = legacyDocument();

    migrateChildrenLayout(doc);

    expect(nodesMap(doc).get(ROOT_NODE_ID)?.get('children')).toBeInstanceOf(Y.Array);
    expect(getChildIds(doc, ROOT_NODE_ID)).toEqual(['n_legacy_child']);
  });

  it('empties the legacy map once migrated', () => {
    const doc = legacyDocument();

    migrateChildrenLayout(doc);

    expect(childrenMap(doc).size).toBe(0);
  });

  it('is idempotent', () => {
    const doc = legacyDocument();

    migrateChildrenLayout(doc);
    migrateChildrenLayout(doc);

    expect(getChildIds(doc, ROOT_NODE_ID)).toEqual(['n_legacy_child']);
  });

  it('drops an entry whose parent no longer exists', () => {
    const doc = legacyDocument();
    childrenMap(doc).set('n_gone', Y.Array.from(['n_x']));

    migrateChildrenLayout(doc);

    expect(childrenMap(doc).size).toBe(0);
  });

  it('leaves a current document alone', () => {
    const doc = createDoc();
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    createNode(doc, { parentId: root });

    migrateChildrenLayout(doc);

    expect(getChildIds(doc, root)).toHaveLength(1);
  });

  it('a write to a legacy parent carries the order forward', () => {
    const doc = legacyDocument();
    const root = ROOT_NODE_ID;

    // The write path seeds the node's array from the legacy map, so an old file that is
    // edited before being migrated does not lose its branches.
    createNode(doc, { parentId: root });

    expect(getChildIds(doc, root)).toHaveLength(2);
  });
});

describe('containers survive the layout change', () => {
  it('a saved document reopens with its children', async () => {
    const doc = createDoc('Saved');
    const root = createNode(doc, { parentId: ROOT_NODE_ID });
    const child = createNode(doc, { parentId: root });
    setLabel(doc, child, label('Kept'));

    const { bytes } = await buildDocument(doc, new Map());
    const reloaded = (await loadDocument(bytes)).doc;

    expect(getChildIds(reloaded, root)).toHaveLength(1);
    expect(getChildren(reloaded, root)[0]?.label).toEqual(label('Kept'));
  });

  it('a legacy container is migrated on open', async () => {
    const legacy = legacyDocument();
    const { bytes } = await buildDocument(legacy, new Map());

    const reloaded = (await loadDocument(bytes)).doc;

    // Opening is the migration trigger, so the rest of the app only ever sees one
    // layout.
    expect(getChildIds(reloaded, ROOT_NODE_ID)).toEqual(['n_legacy_child']);
    expect(nodesMap(reloaded).get(ROOT_NODE_ID)?.get('children')).toBeInstanceOf(Y.Array);
    expect(childrenMap(reloaded).size).toBe(0);
  });

  it('the legacy key is still recognised so old files are readable', () => {
    expect(SCHEMA_KEYS.children).toBe('children');
  });
});