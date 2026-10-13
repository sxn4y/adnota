/**
 * Yjs schema: how the document model in `model.ts` is stored in a `Y.Doc`.
 *
 * Design notes
 * ------------
 * Every entity is a nested `Y.Map` rather than a plain JavaScript object stored as a
 * map value. This matters for collaboration: with nested maps, two people editing
 * *different fields of the same node* merge cleanly, whereas a plain object would be
 * replaced wholesale and silently lose one person's edit.
 *
 * Child ordering lives in a separate `Y.Map<Y.Array<NodeId>>` keyed by parent id.
 * `Y.Array` gives us positional moves for free and keeps sibling order stable under
 * concurrent insertion at different positions.
 *
 * The `LOCAL_ORIGIN` symbol tags transactions that originate on this device so that
 * `Y.UndoManager` tracks exactly the edits a user is responsible for and not remote
 * ones.
 */

import * as Y from 'yjs';
import type {
  AdnotaAsset,
  AdnotaNode,
  AdnotaShape,
  AdnotaStroke,
  BlockDoc,
  DocMeta,
  InlineDoc,
  NodeColor,
  NodeId,
  NodeShape,
} from './model.ts';

export const LOCAL_ORIGIN = Symbol('adnota.local');
export const REMOTE_ORIGIN = Symbol('adnota.remote');

/** Top-level map keys on the document root. */
export const SCHEMA_KEYS = {
  nodes: 'nodes',
  children: 'children',
  strokes: 'strokes',
  shapes: 'shapes',
  assets: 'assets',
  meta: 'meta',
} as const;

/** Field keys within a node map. */
const NODE_FIELDS = {
  id: 'id',
  parentId: 'parentId',
  label: 'label',
  notes: 'notes',
  shape: 'shape',
  color: 'color',
  collapsed: 'collapsed',
  pinned: 'pinned',
  offsetX: 'offsetX',
  offsetY: 'offsetY',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
} as const;

export const ROOT_NODE_ID: NodeId = 'root';

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

export function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(SCHEMA_KEYS.nodes);
}

export function childrenMap(doc: Y.Doc): Y.Map<Y.Array<NodeId>> {
  return doc.getMap<Y.Array<NodeId>>(SCHEMA_KEYS.children);
}

export function strokesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(SCHEMA_KEYS.strokes);
}

export function shapesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(SCHEMA_KEYS.shapes);
}

export function assetsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(SCHEMA_KEYS.assets);
}

export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(SCHEMA_KEYS.meta);
}

// ---------------------------------------------------------------------------
// Identifier generation
// ---------------------------------------------------------------------------

let sequence = 0;

/**
 * Short, sortable, collision-resistant identifier.
 *
 * Sortable by creation time so that iterating insertion order is meaningful, and
 * short enough to be readable in a JSON dump when debugging a merge conflict.
 */
export function newId(prefix: string): string {
  sequence = (sequence + 1) % 46656;
  const time = Date.now().toString(36);
  const counter = sequence.toString(36).padStart(3, '0');
  const random = Math.floor(Math.random() * 1679616)
    .toString(36)
    .padStart(4, '0');
  return `${prefix}_${time}${counter}${random}`;
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

const EMPTY_DOC: InlineDoc = { type: 'doc', content: [] };

export function emptyLabel(): InlineDoc {
  return { type: 'doc', content: [] };
}

/** Create a document with the schema initialised and a root node in place. */
export function createDoc(title = 'Untitled'): Y.Doc {
  const doc = new Y.Doc();

  doc.transact(() => {
    const root = new Y.Map<unknown>();
    root.set(NODE_FIELDS.id, ROOT_NODE_ID);
    root.set(NODE_FIELDS.parentId, null);
    root.set(NODE_FIELDS.label, emptyLabel());
    root.set(NODE_FIELDS.notes, null);
    root.set(NODE_FIELDS.shape, 'pill');
    root.set(NODE_FIELDS.color, 'accent');
    root.set(NODE_FIELDS.collapsed, false);
    root.set(NODE_FIELDS.pinned, false);
    root.set(NODE_FIELDS.offsetX, 0);
    root.set(NODE_FIELDS.offsetY, 0);
    root.set(NODE_FIELDS.createdAt, Date.now());
    root.set(NODE_FIELDS.updatedAt, Date.now());
    nodesMap(doc).set(ROOT_NODE_ID, root);

    const rootChildren = new Y.Array<NodeId>();
    childrenMap(doc).set(ROOT_NODE_ID, rootChildren);

    const meta = metaMap(doc);
    meta.set('title', title);
    meta.set('createdAt', Date.now());
    meta.set('updatedAt', Date.now());
    meta.set('themeId', 'default');
  }, LOCAL_ORIGIN);

  return doc;
}

// ---------------------------------------------------------------------------
// Node reads
// ---------------------------------------------------------------------------

function readNode(map: Y.Map<unknown>): AdnotaNode | null {
  // A value here is only well-formed if it is a Y.Map. Anything else means the
  // document was written by something other than this code path, or arrived through a
  // hand-edited or partially-synced file. Skipping the bad entry keeps one corrupt
  // node from taking down the whole document.
  if (!isYMap(map)) return null;

  const id = map.get(NODE_FIELDS.id);
  if (typeof id !== 'string') return null;

  const parentId = map.get(NODE_FIELDS.parentId);
  const label = map.get(NODE_FIELDS.label);
  const notes = map.get(NODE_FIELDS.notes);
  const shape = map.get(NODE_FIELDS.shape);
  const color = map.get(NODE_FIELDS.color);
  const offsetX = map.get(NODE_FIELDS.offsetX);
  const offsetY = map.get(NODE_FIELDS.offsetY);
  const createdAt = map.get(NODE_FIELDS.createdAt);
  const updatedAt = map.get(NODE_FIELDS.updatedAt);

  return {
    id,
    parentId: typeof parentId === 'string' ? parentId : null,
    label: isInlineDoc(label) ? label : EMPTY_DOC,
    notes: isBlockDoc(notes) ? notes : null,
    shape: isNodeShape(shape) ? shape : 'box',
    color: typeof color === 'string' ? color : 'neutral',
    collapsed: map.get(NODE_FIELDS.collapsed) === true,
    pinned: map.get(NODE_FIELDS.pinned) === true,
    offset: {
      x: typeof offsetX === 'number' ? offsetX : 0,
      y: typeof offsetY === 'number' ? offsetY : 0,
    },
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  };
}

export function getNode(doc: Y.Doc, id: NodeId): AdnotaNode | null {
  const map = nodesMap(doc).get(id);
  return map ? readNode(map) : null;
}

/** Every node in the document, in unspecified order. */
export function allNodes(doc: Y.Doc): AdnotaNode[] {
  const out: AdnotaNode[] = [];
  for (const map of nodesMap(doc).values()) {
    const node = readNode(map);
    if (node) out.push(node);
  }
  return out;
}

export function getMeta(doc: Y.Doc): DocMeta {
  const meta = metaMap(doc);
  return {
    title: readString(meta, 'title') ?? 'Untitled',
    createdAt: readNumber(meta, 'createdAt') ?? 0,
    updatedAt: readNumber(meta, 'updatedAt') ?? 0,
    themeId: readString(meta, 'themeId') ?? 'default',
  };
}

export function setTitle(doc: Y.Doc, title: string): void {
  doc.transact(() => {
    metaMap(doc).set('title', title);
    metaMap(doc).set('updatedAt', Date.now());
  }, LOCAL_ORIGIN);
}

// ---------------------------------------------------------------------------
// Child order
// ---------------------------------------------------------------------------

export function getChildIds(doc: Y.Doc, parentId: NodeId): NodeId[] {
  return childrenMap(doc).get(parentId)?.toArray() ?? [];
}

export function getChildren(doc: Y.Doc, parentId: NodeId): AdnotaNode[] {
  const out: AdnotaNode[] = [];
  for (const childId of getChildIds(doc, parentId)) {
    const node = getNode(doc, childId);
    if (node) out.push(node);
  }
  return out;
}

/** Depth-first walk from the root, skipping the subtree under any collapsed node. */
export function walkVisible(
  doc: Y.Doc,
  visit: (node: AdnotaNode, depth: number) => void,
): void {
  const recurse = (parentId: NodeId, depth: number): void => {
    for (const childId of getChildIds(doc, parentId)) {
      const node = getNode(doc, childId);
      if (!node) continue;
      visit(node, depth);
      if (!node.collapsed) recurse(node.id, depth + 1);
    }
  };
  recurse(ROOT_NODE_ID, 0);
}

/** Every node id in the subtree rooted at `id`, excluding `id` itself. */
export function subtreeIds(doc: Y.Doc, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const recurse = (current: NodeId): void => {
    for (const childId of getChildIds(doc, current)) {
      out.push(childId);
      recurse(childId);
    }
  };
  recurse(id);
  return out;
}

// ---------------------------------------------------------------------------
// Node writes
// ---------------------------------------------------------------------------

export interface CreateNodeInput {
  readonly parentId: NodeId;
  readonly label?: InlineDoc;
  readonly index?: number;
}

export function createNode(doc: Y.Doc, input: CreateNodeInput): NodeId {
  const id = newId('n');
  const now = Date.now();

  doc.transact(() => {
    const node = new Y.Map<unknown>();
    node.set(NODE_FIELDS.id, id);
    node.set(NODE_FIELDS.parentId, input.parentId);
    node.set(NODE_FIELDS.label, input.label ?? emptyLabel());
    node.set(NODE_FIELDS.notes, null);
    node.set(NODE_FIELDS.shape, 'box');
    node.set(NODE_FIELDS.color, 'neutral');
    node.set(NODE_FIELDS.collapsed, false);
    node.set(NODE_FIELDS.pinned, false);
    node.set(NODE_FIELDS.offsetX, 0);
    node.set(NODE_FIELDS.offsetY, 0);
    node.set(NODE_FIELDS.createdAt, now);
    node.set(NODE_FIELDS.updatedAt, now);
    nodesMap(doc).set(id, node);

    let siblings = childrenMap(doc).get(input.parentId);
    if (!siblings) {
      siblings = new Y.Array<NodeId>();
      childrenMap(doc).set(input.parentId, siblings);
    }
    const index = input.index ?? siblings.length;
    siblings.insert(Math.max(0, Math.min(index, siblings.length)), [id]);
  }, LOCAL_ORIGIN);

  return id;
}

export function setLabel(doc: Y.Doc, id: NodeId, label: InlineDoc): void {
  const node = nodesMap(doc).get(id);
  if (!node) return;
  doc.transact(() => {
    node.set(NODE_FIELDS.label, label);
    node.set(NODE_FIELDS.updatedAt, Date.now());
  }, LOCAL_ORIGIN);
}

export function setNotes(doc: Y.Doc, id: NodeId, notes: BlockDoc | null): void {
  const node = nodesMap(doc).get(id);
  if (!node) return;
  doc.transact(() => {
    node.set(NODE_FIELDS.notes, notes);
    node.set(NODE_FIELDS.updatedAt, Date.now());
  }, LOCAL_ORIGIN);
}

export function setCollapsed(doc: Y.Doc, id: NodeId, collapsed: boolean): void {
  const node = nodesMap(doc).get(id);
  if (!node) return;
  doc.transact(() => {
    node.set(NODE_FIELDS.collapsed, collapsed);
    node.set(NODE_FIELDS.updatedAt, Date.now());
  }, LOCAL_ORIGIN);
}

export function setAppearance(
  doc: Y.Doc,
  id: NodeId,
  patch: { readonly shape?: NodeShape; readonly color?: NodeColor },
): void {
  const node = nodesMap(doc).get(id);
  if (!node) return;
  doc.transact(() => {
    if (patch.shape !== undefined) node.set(NODE_FIELDS.shape, patch.shape);
    if (patch.color !== undefined) node.set(NODE_FIELDS.color, patch.color);
    node.set(NODE_FIELDS.updatedAt, Date.now());
  }, LOCAL_ORIGIN);
}

export function setPinned(
  doc: Y.Doc,
  id: NodeId,
  pinned: boolean,
  offset?: Readonly<{ x: number; y: number }>,
): void {
  const node = nodesMap(doc).get(id);
  if (!node) return;
  doc.transact(() => {
    node.set(NODE_FIELDS.pinned, pinned);
    if (offset) {
      node.set(NODE_FIELDS.offsetX, offset.x);
      node.set(NODE_FIELDS.offsetY, offset.y);
    }
    node.set(NODE_FIELDS.updatedAt, Date.now());
  }, LOCAL_ORIGIN);
}

/**
 * Remove a node and everything beneath it.
 *
 * Also detaches any strokes, shapes and assets anchored to the removed subtree, so
 * that ink does not survive orphaned. This matters because anchored strokes are
 * stored in the node's local frame: leaving them behind would strand them at a stale
 * origin.
 */
export function removeNode(doc: Y.Doc, id: NodeId): void {
  if (id === ROOT_NODE_ID) return;

  const doomed = new Set<NodeId>([id, ...subtreeIds(doc, id)]);

  doc.transact(() => {
    const node = nodesMap(doc).get(id);
    const parentId = node?.get(NODE_FIELDS.parentId);
    if (typeof parentId === 'string') {
      const siblings = childrenMap(doc).get(parentId);
      const index = siblings ? siblings.toArray().indexOf(id) : -1;
      if (index >= 0) siblings?.delete(index, 1);
    }

    for (const doomedId of doomed) {
      nodesMap(doc).delete(doomedId);
      childrenMap(doc).delete(doomedId);
    }

    // Detach anchored ink and shapes, and drop unanchored ones that referenced the
    // removed subtree.
    for (const [strokeId, stroke] of strokesMap(doc).entries()) {
      const anchor = stroke.get('anchorNodeId');
      if (typeof anchor === 'string' && doomed.has(anchor)) {
        strokesMap(doc).delete(strokeId);
      }
    }
    for (const [shapeId, shape] of shapesMap(doc).entries()) {
      const anchor = shape.get('anchorNodeId');
      if (typeof anchor === 'string' && doomed.has(anchor)) {
        shapesMap(doc).delete(shapeId);
      }
    }
  }, LOCAL_ORIGIN);
}

/** Reparent a node, optionally repositioning it among its new siblings. */
export function moveNode(
  doc: Y.Doc,
  id: NodeId,
  newParentId: NodeId,
  index?: number,
): void {
  if (id === ROOT_NODE_ID || id === newParentId) return;
  // Refuse to move a node into its own subtree, which would detach the tree.
  if (subtreeIds(doc, id).includes(newParentId)) return;

  const node = nodesMap(doc).get(id);
  if (!node) return;

  doc.transact(() => {
    const oldParentId = node.get(NODE_FIELDS.parentId);
    if (typeof oldParentId === 'string') {
      const oldSiblings = childrenMap(doc).get(oldParentId);
      const oldIndex = oldSiblings ? oldSiblings.toArray().indexOf(id) : -1;
      if (oldIndex >= 0) oldSiblings?.delete(oldIndex, 1);
    }

    let siblings = childrenMap(doc).get(newParentId);
    if (!siblings) {
      siblings = new Y.Array<NodeId>();
      childrenMap(doc).set(newParentId, siblings);
    }
    const target = index ?? siblings.length;
    siblings.insert(Math.max(0, Math.min(target, siblings.length)), [id]);

    node.set(NODE_FIELDS.parentId, newParentId);
    node.set(NODE_FIELDS.updatedAt, Date.now());
  }, LOCAL_ORIGIN);
}

// ---------------------------------------------------------------------------
// Geometry writes
// ---------------------------------------------------------------------------

export function putStroke(doc: Y.Doc, stroke: AdnotaStroke): void {
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set('id', stroke.id);
    map.set('points', stroke.points.map((p) => ({ x: p.x, y: p.y, pressure: p.pressure })));
    map.set('color', stroke.color);
    map.set('width', stroke.width);
    map.set('tool', stroke.tool);
    map.set('opacity', stroke.opacity);
    map.set('anchorNodeId', stroke.anchorNodeId);
    map.set('anchorOrigin', stroke.anchorOrigin ? { x: stroke.anchorOrigin.x, y: stroke.anchorOrigin.y } : null);
    strokesMap(doc).set(stroke.id, map);
  }, LOCAL_ORIGIN);
}

export function getStrokes(doc: Y.Doc): AdnotaStroke[] {
  const out: AdnotaStroke[] = [];
  for (const value of strokesMap(doc).values()) {
    if (!isYMap(value)) continue;
    const stroke = readStroke(value);
    if (stroke) out.push(stroke);
  }
  return out;
}

function readStroke(map: Y.Map<unknown>): AdnotaStroke | null {
  const id = map.get('id');
  const rawPoints = map.get('points');
  if (typeof id !== 'string' || !Array.isArray(rawPoints)) return null;

  const points = rawPoints.filter(isPoint).map((p) => ({ x: p.x, y: p.y, pressure: p.pressure }));
  const origin = map.get('anchorOrigin');
  const anchorNodeId = map.get('anchorNodeId');

  return {
    id,
    points,
    color: readString(map, 'color') ?? '#1f2430',
    width: readNumber(map, 'width') ?? 2,
    tool: (readString(map, 'tool') as AdnotaStroke['tool']) ?? 'pen',
    opacity: readNumber(map, 'opacity') ?? 1,
    anchorNodeId: typeof anchorNodeId === 'string' ? anchorNodeId : null,
    anchorOrigin: isPointLike(origin) ? { x: origin.x, y: origin.y } : null,
  };
}

export function putShape(doc: Y.Doc, shape: AdnotaShape): void {
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(shape)) map.set(key, value);
    shapesMap(doc).set(shape.id, map);
  }, LOCAL_ORIGIN);
}

export function getShapes(doc: Y.Doc): AdnotaShape[] {
  const out: AdnotaShape[] = [];
  for (const map of shapesMap(doc).values()) {
    if (!isYMap(map)) continue;
    const id = map.get('id');
    if (typeof id !== 'string') continue;
    out.push({
      id,
      kind: (readString(map, 'kind') as AdnotaShape['kind']) ?? 'rect',
      x: readNumber(map, 'x') ?? 0,
      y: readNumber(map, 'y') ?? 0,
      width: readNumber(map, 'width') ?? 0,
      height: readNumber(map, 'height') ?? 0,
      strokeColor: readString(map, 'strokeColor') ?? '#1f2430',
      fillColor: typeof map.get('fillColor') === 'string' ? (map.get('fillColor') as string) : null,
      strokeWidth: readNumber(map, 'strokeWidth') ?? 1,
      anchorNodeId: typeof map.get('anchorNodeId') === 'string' ? (map.get('anchorNodeId') as string) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export function putAsset(doc: Y.Doc, asset: AdnotaAsset): void {
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set('id', asset.id);
    map.set('mime', asset.mime);
    map.set('byteLength', asset.byteLength);
    map.set('width', asset.width);
    map.set('height', asset.height);
    map.set('hash', asset.hash);
    map.set('extension', asset.extension);
    assetsMap(doc).set(asset.id, map);
  }, LOCAL_ORIGIN);
}

export function getAssets(doc: Y.Doc): AdnotaAsset[] {
  const out: AdnotaAsset[] = [];
  for (const map of assetsMap(doc).values()) {
    if (!isYMap(map)) continue;
    const id = map.get('id');
    const hash = map.get('hash');
    if (typeof id !== 'string' || typeof hash !== 'string') continue;
    out.push({
      id,
      mime: readString(map, 'mime') ?? 'application/octet-stream',
      byteLength: readNumber(map, 'byteLength') ?? 0,
      width: typeof map.get('width') === 'number' ? (map.get('width') as number) : null,
      height: typeof map.get('height') === 'number' ? (map.get('height') as number) : null,
      hash,
      extension: readString(map, 'extension') ?? 'bin',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

function isYMap(value: unknown): value is Y.Map<unknown> {
  return value instanceof Y.Map;
}

function readString(map: Y.Map<unknown>, key: string): string | null {
  const value = map.get(key);
  return typeof value === 'string' ? value : null;
}

function readNumber(map: Y.Map<unknown>, key: string): number | null {
  const value = map.get(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPoint(value: unknown): value is { x: number; y: number; pressure: number } {
  return isPointLike(value) && typeof (value as { pressure?: unknown }).pressure === 'number';
}

function isPointLike(value: unknown): value is { x: number; y: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { x?: unknown }).x === 'number' &&
    typeof (value as { y?: unknown }).y === 'number'
  );
}

function isInlineDoc(value: unknown): value is InlineDoc {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc';
}

function isBlockDoc(value: unknown): value is BlockDoc {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc';
}

const NODE_SHAPES: readonly NodeShape[] = ['none', 'underline', 'round', 'pill', 'box'];

function isNodeShape(value: unknown): value is NodeShape {
  return typeof value === 'string' && (NODE_SHAPES as readonly string[]).includes(value);
}
