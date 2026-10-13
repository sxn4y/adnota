/**
 * Scene state: layout, selection, and the keyboard model.
 *
 * The keyboard model is the defining interaction of a mindmap, and it is cheap to
 * get wrong in ways that feel broken rather than wrong: `Tab` doing something
 * unfocused, `Enter` adding a sibling when the student meant a line break, arrow
 * keys scrolling the page instead of walking the tree.
 *
 * Every command is expressed against the document model and returns whether it
 * fired, so the key handler can decide whether to prevent the browser default.
 * A command that did not apply must never swallow the keystroke.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  ROOT_NODE_ID,
  createNode,
  getChildIds,
  getChildren,
  getNode,
  moveNode,
  removeNode,
  setCollapsed,
  type AdnotaNode,
  type InlineDoc,
  type NodeId,
  type YDoc,
} from '@adnota/core';
import {
  layoutBounds,
  layoutTree,
  measureLabel,
  resolveVisualRoot,
  type LaidOutNode,
  type LayoutKind,
  type NodeSize,
} from '@adnota/scene';

export const LABEL_FONT_SIZE = 15;
export const LABEL_MAX_WIDTH = 260;
export const PADDING_X = 18;
export const PADDING_Y = 10;

/** Measured size of a node's drawn box. */
export function measureNode(node: AdnotaNode): NodeSize {
  return measureLabelBox(node.label);
}

/**
 * Measured size of the box a label needs.
 *
 * Takes the label rather than the node because the editing overlay has only a label to
 * go on while the student is typing and the node has not been committed yet.
 */
export function measureLabelBox(label: InlineDoc): NodeSize {
  const metrics = measureLabel(label, LABEL_FONT_SIZE, LABEL_MAX_WIDTH);
  return {
    width: metrics.width + PADDING_X * 2,
    height: metrics.height + PADDING_Y * 2,
  };
}

export interface SceneState {
  readonly laid: readonly LaidOutNode[];
  readonly byId: ReadonlyMap<NodeId, LaidOutNode>;
  readonly visualRoot: AdnotaNode | null;
}

export interface UseSceneOptions {
  readonly doc: YDoc;
  readonly kind: LayoutKind;
  readonly nodeSeparation?: number;
  readonly siblingSeparation?: number;
  /** Bumped by the caller whenever the document changes, to force a re-layout. */
  readonly revision: number;
}

/**
 * Lay the visible tree out.
 *
 * Keyed on an explicit `revision` rather than on the document identity, because a
 * `Y.Doc` is mutable: its identity never changes even as its contents do, so
 * relying on it would make the layout silently stale after the first edit.
 */
export function useScene({ doc, kind, nodeSeparation = 120, siblingSeparation = 16, revision }: UseSceneOptions): SceneState {
  return useMemo(() => {
    const structuralRoot = getNode(doc, ROOT_NODE_ID);
    if (!structuralRoot) {
      return { laid: [], byId: new Map(), visualRoot: null };
    }

    const childrenOf = (id: NodeId) => getChildren(doc, id);
    // Laying out from the structural root would draw an empty box in the middle of
    // the canvas; the first top-level node is the real subject.
    const visualRoot = resolveVisualRoot(structuralRoot, childrenOf);

    const laid = layoutTree(visualRoot, childrenOf, measureNode, {
      kind,
      nodeSeparation,
      siblingSeparation,
    });

    const byId = new Map<NodeId, LaidOutNode>(laid.map((entry) => [entry.id, entry]));

    return { laid, byId, visualRoot };
    // `revision` is read by the linter as an unused dependency, and it is. It exists
    // precisely because a `Y.Doc` is mutable: its identity never changes, so a memo
    // keyed on it would serve a stale layout forever after the first edit. The
    // alternative, subscribing to every map separately, costs more than a counter and
    // is easy to get subtly wrong when a new entity type is added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, kind, nodeSeparation, siblingSeparation, revision]);
}

export interface SceneBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

export function useSceneBounds(scene: SceneState): SceneBounds {
  return useMemo(() => {
    const raw = layoutBounds(scene.laid, measureNode);
    return {
      ...raw,
      width: raw.maxX - raw.minX,
      height: raw.maxY - raw.minY,
    };
  }, [scene]);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface SelectionState {
  readonly selectedId: NodeId | null;
  readonly editingId: NodeId | null;
  readonly setSelected: (id: NodeId | null) => void;
  readonly beginEditing: (id: NodeId) => void;
  readonly endEditing: () => void;
}

export function useSelection(): SelectionState {
  const [selectedId, setSelected] = useState<NodeId | null>(null);
  const [editingId, setEditingId] = useState<NodeId | null>(null);

  // Only one node can be edited at a time, so editing implies selection.
  const beginEditing = useCallback((id: NodeId) => {
    setSelected(id);
    setEditingId(id);
  }, []);

  const endEditing = useCallback(() => setEditingId(null), []);

  const setSelectedSafe = useCallback((id: NodeId | null) => {
    setSelected(id);
    // Selecting elsewhere abandons an edit rather than leaving the caret stranded.
    setEditingId(null);
  }, []);

  return {
    selectedId,
    editingId,
    setSelected: setSelectedSafe,
    beginEditing,
    endEditing,
  };
}

// ---------------------------------------------------------------------------
// Keyboard model
// ---------------------------------------------------------------------------

export interface NodeCommands {
  readonly addChild: (parentId: NodeId) => NodeId | null;
  readonly addSibling: (id: NodeId) => NodeId | null;
  readonly outdent: (id: NodeId) => void;
  readonly indent: (id: NodeId) => void;
  readonly remove: (id: NodeId) => void;
  readonly toggleCollapsed: (id: NodeId) => void;
  readonly moveSelection: (id: NodeId, direction: 'up' | 'down' | 'left' | 'right') => NodeId | null;
}

export interface UseNodeCommandsOptions {
  readonly doc: YDoc;
  readonly kind: LayoutKind;
  /** Called after any structural change so the caller can bump the layout revision. */
  readonly onChange: () => void;
}

export function useNodeCommands({ doc, kind, onChange }: UseNodeCommandsOptions): NodeCommands {
  const addChild = useCallback(
    (parentId: NodeId): NodeId | null => {
      if (!getNode(doc, parentId)) return null;
      // A collapsed branch that receives a child should show it, or the new node
      // would be invisible and the student would think the keystroke failed.
      const parent = getNode(doc, parentId);
      if (parent?.collapsed) setCollapsed(doc, parentId, false);
      const id = createNode(doc, { parentId });
      onChange();
      return id;
    },
    [doc, onChange],
  );

  const addSibling = useCallback(
    (id: NodeId): NodeId | null => {
      const node = getNode(doc, id);
      if (!node || !node.parentId) return null;
      const siblings = getChildIds(doc, node.parentId);
      const index = siblings.indexOf(id);
      const created = createNode(doc, { parentId: node.parentId, index: index + 1 });
      onChange();
      return created;
    },
    [doc, onChange],
  );

  const outdent = useCallback(
    (id: NodeId): void => {
      const node = getNode(doc, id);
      if (!node?.parentId) return;

      const grandparentId = node.parentId;
      const grandparent = getNode(doc, grandparentId);
      // The visual root has no parent to outdent into.
      if (!grandparent || grandparent.parentId === null) return;

      const uncleSiblings = getChildIds(doc, grandparent.parentId);
      const uncleIndex = uncleSiblings.indexOf(grandparentId);

      moveNode(doc, id, grandparent.parentId, uncleIndex + 1);
      onChange();
    },
    [doc, onChange],
  );

  const indent = useCallback(
    (id: NodeId): void => {
      const node = getNode(doc, id);
      if (!node?.parentId) return;

      const siblings = getChildIds(doc, node.parentId);
      const index = siblings.indexOf(id);
      // The last sibling has no following node to become this node's child.
      if (index < 0 || index >= siblings.length - 1) return;

      const newParent = siblings[index + 1];
      if (!newParent) return;

      moveNode(doc, id, newParent);
      // The branch that just adopted the node may have been collapsed.
      const parent = getNode(doc, newParent);
      if (parent?.collapsed) setCollapsed(doc, newParent, false);
      onChange();
    },
    [doc, onChange],
  );

  const remove = useCallback(
    (id: NodeId): void => {
      if (id === ROOT_NODE_ID) return;
      removeNode(doc, id);
      onChange();
    },
    [doc, onChange],
  );

  const toggleCollapsed = useCallback(
    (id: NodeId): void => {
      const node = getNode(doc, id);
      if (!node || getChildIds(doc, id).length === 0) return;
      setCollapsed(doc, id, !node.collapsed);
      onChange();
    },
    [doc, onChange],
  );

  /**
   * Move to the next node in reading order.
   *
   * Up and down walk the visible tree depth-first, which is the order a student
   * reads in. Left and right follow the branch, and are no-ops in a radial layout
   * where "deeper" does not mean a consistent direction.
   */
  const moveSelection = useCallback(
    (id: NodeId, direction: 'up' | 'down' | 'left' | 'right'): NodeId | null => {
      if (direction === 'left' || direction === 'right') {
        if (kind === 'radial') return null;
        const node = getNode(doc, id);
        if (!node) return null;

        if (direction === 'right') {
          // Deeper first: a node's first child, or its next sibling at the same level.
          const children = getChildIds(doc, id);
          return children[0] ?? siblingsOf(doc, id)[0] ?? null;
        }

        // Shallower: the parent, or the previous sibling when there is no parent to
        // climb to.
        if (node.parentId) return node.parentId;
        return siblingsOf(doc, id)[0] ?? null;
      }

      const order = visibleOrder(doc);
      const index = order.indexOf(id);
      if (index < 0) return null;
      const target = direction === 'up' ? index - 1 : index + 1;
      return order[target] ?? null;
    },
    [doc, kind],
  );

  return { addChild, addSibling, outdent, indent, remove, toggleCollapsed, moveSelection };
}

function siblingsOf(doc: YDoc, id: NodeId): NodeId[] {
  const node = getNode(doc, id);
  if (!node?.parentId) return [];
  return getChildIds(doc, node.parentId).filter((sibling) => sibling !== id);
}

/** Every visible node id, in depth-first reading order. */
export function visibleOrder(doc: YDoc): NodeId[] {
  const out: NodeId[] = [];
  const walk = (parentId: NodeId): void => {
    for (const childId of getChildIds(doc, parentId)) {
      out.push(childId);
      const child = getNode(doc, childId);
      if (child && !child.collapsed) walk(childId);
    }
  };
  walk(ROOT_NODE_ID);
  return out;
}