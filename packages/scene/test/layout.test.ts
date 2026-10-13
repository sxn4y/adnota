import { describe, expect, it } from 'vitest';
import {
  ROOT_NODE_ID,
  createDoc,
  createNode,
  getChildren,
  getNode,
  setCollapsed,
  setLabel,
  type AdnotaNode,
  type NodeId,
} from '@adnota/core';
import {
  DEFAULT_LAYOUT,
  layoutTree,
  resolveVisualRoot,
  type LaidOutNode,
  type NodeSize,
} from '@adnota/scene';

interface Fixture {
  root: AdnotaNode;
  names: Map<NodeId, string>;
  sizes: Map<NodeId, NodeSize>;
  childrenOf: (id: NodeId) => AdnotaNode[];
  sizeOf: (node: AdnotaNode) => NodeSize;
}

/**
 * Build a tree from names, with per-node heights so layout has real variation.
 *
 * `createDoc` already creates the structural root at `ROOT_NODE_ID` with an empty
 * label, exactly as the app produces. The fixture keys that node under the name
 * `root` so the specs below read naturally.
 *
 * Specs are written parent-name-first, so both directions of the name/id mapping are
 * kept: `names` for reporting and `byName` for resolving a spec key to a parent.
 */
function build(spec: Record<string, string[]>, heights: Record<string, number> = {}): Fixture {
  const doc = createDoc('layout');
  const names = new Map<NodeId, string>([[ROOT_NODE_ID, 'root']]);
  const byName = new Map<string, NodeId>([['root', ROOT_NODE_ID]]);
  const sizes = new Map<NodeId, NodeSize>();

  const make = (parentId: NodeId, name: string): NodeId => {
    const id = createNode(doc, { parentId });
    names.set(id, name);
    byName.set(name, id);
    setLabel(doc, id, { type: 'doc', content: [{ type: 'text', text: name }] });
    sizes.set(id, { width: 200, height: heights[name] ?? 40 });
    return id;
  };

  for (const [parentName, childNames] of Object.entries(spec)) {
    const parentId = byName.get(parentName) ?? ROOT_NODE_ID;
    for (const childName of childNames) make(parentId, childName);
  }

  const root = getNode(doc, ROOT_NODE_ID)!;

  return {
    root,
    names,
    sizes,
    childrenOf: (id: NodeId) => getChildren(doc, id),
    sizeOf: (node: AdnotaNode) => sizes.get(node.id) ?? { width: 200, height: 40 },
  };
}

/** Positions plus the boxes they occupy, for overlap assertions. */
function boxes(laid: readonly LaidOutNode[], fixture: Fixture): Map<string, { x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const entry of laid) {
    const size = fixture.sizeOf(entry.node);
    out.set(fixture.names.get(entry.id) ?? entry.id, {
      x: entry.x - size.width / 2,
      y: entry.y - size.height / 2,
      w: size.width,
      h: size.height,
    });
  }
  return out;
}

function overlaps(
  laid: readonly LaidOutNode[],
  fixture: Fixture,
): string[] {
  const mapped = [...boxes(laid, fixture).entries()];
  const clashes: string[] = [];
  for (let i = 0; i < mapped.length; i += 1) {
    for (let j = i + 1; j < mapped.length; j += 1) {
      const [nameA, a] = mapped[i]!;
      const [nameB, b] = mapped[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        clashes.push(`${nameA} overlaps ${nameB}`);
      }
    }
  }
  return clashes;
}

const SAMPLE: Record<string, string[]> = {
  root: ['Definite', 'Improper', 'Substitutions', 'Volume', 'Broken'],
  Definite: ['Fundamental', 'ByParts'],
  Improper: ['Converges', 'Diverges'],
  Substitutions: ['Trig'],
};

describe('resolveVisualRoot', () => {
  it('promotes the only top-level node to be the visual root', () => {
    const fixture = build({ root: ['Subject'] });
    const resolved = resolveVisualRoot(fixture.root, fixture.childrenOf);

    expect(fixture.names.get(resolved.id)).toBe('Subject');
  });

  it('keeps the structural root when there are several top-level nodes', () => {
    const fixture = build({ root: ['Alpha', 'Beta'] });
    const resolved = resolveVisualRoot(fixture.root, fixture.childrenOf);

    expect(resolved.id).toBe(fixture.root.id);
  });

  it('keeps the structural root when it carries a label of its own', () => {
    const fixture = build({ root: ['Subject'] });
    const labelled = { ...fixture.root, label: { type: 'doc' as const, content: [{ type: 'text' as const, text: 'Real' }] } };
    const resolved = resolveVisualRoot(labelled, fixture.childrenOf);

    expect(resolved.id).toBe(fixture.root.id);
  });
});

describe('layout', () => {
  it('places the visual root at the origin', () => {
    const fixture = build({ root: ['Subject'] });
    const laid = layoutTree(
      resolveVisualRoot(fixture.root, fixture.childrenOf),
      fixture.childrenOf,
      fixture.sizeOf,
      DEFAULT_LAYOUT,
    );

    const rootEntry = laid.find((e) => fixture.names.get(e.id) === 'Subject')!;
    expect(rootEntry.x).toBe(0);
    expect(rootEntry.y).toBe(0);
  });

  it('lays out every node exactly once', () => {
    const fixture = build(SAMPLE);
    const laid = layoutTree(
      resolveVisualRoot(fixture.root, fixture.childrenOf),
      fixture.childrenOf,
      fixture.sizeOf,
      DEFAULT_LAYOUT,
    );

    const names = laid.map((e) => fixture.names.get(e.id));
    expect(names).toHaveLength(11);
    expect(new Set(names).size).toBe(11);
  });

  for (const kind of ['two-sided', 'left', 'radial'] as const) {
    it(`produces no overlapping nodes in the ${kind} layout`, () => {
      const fixture = build(SAMPLE, { Fundamental: 85, Substitutions: 74 });
      const laid = layoutTree(
        resolveVisualRoot(fixture.root, fixture.childrenOf),
        fixture.childrenOf,
        fixture.sizeOf,
        { ...DEFAULT_LAYOUT, kind },
      );

      expect(overlaps(laid, fixture)).toEqual([]);
    });
  }

  it('produces no overlaps when a child is far taller than its parent', () => {
    const fixture = build(
      { root: ['Short', 'TallChild', 'After'] },
      { Short: 20, TallChild: 200, After: 20 },
    );
    const laid = layoutTree(
      resolveVisualRoot(fixture.root, fixture.childrenOf),
      fixture.childrenOf,
      fixture.sizeOf,
      { ...DEFAULT_LAYOUT, kind: 'left' },
    );

    expect(overlaps(laid, fixture)).toEqual([]);
  });

  it('mirrors left-hand branches to negative x in the two-sided layout', () => {
    const fixture = build({ root: ['Alpha', 'Beta', 'Gamma'] });
    const laid = layoutTree(
      resolveVisualRoot(fixture.root, fixture.childrenOf),
      fixture.childrenOf,
      fixture.sizeOf,
      { ...DEFAULT_LAYOUT, kind: 'two-sided' },
    );

    const alpha = laid.find((e) => fixture.names.get(e.id) === 'Alpha')!;
    const beta = laid.find((e) => fixture.names.get(e.id) === 'Beta')!;

    expect(alpha.side).toBe(1);
    expect(alpha.x).toBeGreaterThan(0);
    expect(beta.side).toBe(-1);
    expect(beta.x).toBeLessThan(0);
  });

  it('keeps a whole subtree on one side of the two-sided layout', () => {
    // Alternating happens at the first level below the root; deeper branches stay put.
    const fixture = build({
      root: ['Subject'],
      Subject: ['Parent'],
      Parent: ['ChildA', 'ChildB'],
    });
    const laid = layoutTree(
      resolveVisualRoot(fixture.root, fixture.childrenOf),
      fixture.childrenOf,
      fixture.sizeOf,
      { ...DEFAULT_LAYOUT, kind: 'two-sided' },
    );

    const byName = (name: string) => laid.find((e) => fixture.names.get(e.id) === name)!;

    const parent = byName('Parent');
    const childA = byName('ChildA');
    const childB = byName('ChildB');

    expect(parent.side).toBe(1);
    expect(childA.side).toBe(parent.side);
    expect(childB.side).toBe(parent.side);
  });

  it('spaces siblings by at least the configured separation', () => {
    const fixture = build({ root: ['A', 'B', 'C'] });
    const laid = layoutTree(
      resolveVisualRoot(fixture.root, fixture.childrenOf),
      fixture.childrenOf,
      fixture.sizeOf,
      { ...DEFAULT_LAYOUT, kind: 'left' },
    );

    const sorted = laid
      .filter((e) => e.depth === 1)
      .sort((a, b) => a.y - b.y);

    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;
      const gap = current.y - previous.y - (fixture.sizeOf(previous.node).height + fixture.sizeOf(current.node).height) / 2;
      expect(gap).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.siblingSeparation - 0.001);
    }
  });

  it('keeps a collapsed subtree out of the layout', () => {
    const doc = createDoc('collapsed');
    const rootId = createNode(doc, { parentId: ROOT_NODE_ID });
    setLabel(doc, rootId, { type: 'doc', content: [{ type: 'text', text: 'Subject' }] });
    const parent = createNode(doc, { parentId: rootId });
    setLabel(doc, parent, { type: 'doc', content: [{ type: 'text', text: 'Parent' }] });
    const hidden = createNode(doc, { parentId: parent });
    setLabel(doc, hidden, { type: 'doc', content: [{ type: 'text', text: 'Hidden' }] });

    setCollapsed(doc, parent, true);

    const root = getNode(doc, rootId)!;
    const childrenOf = (id: NodeId) => getChildren(doc, id);
    const sizeOf = (): NodeSize => ({ width: 200, height: 40 });

    const laid = layoutTree(resolveVisualRoot(root, childrenOf), childrenOf, sizeOf, DEFAULT_LAYOUT);
    const names = laid.map((e) => e.node.label.content[0]);

    expect(names).toContainEqual({ type: 'text', text: 'Parent' });
    expect(names).not.toContainEqual({ type: 'text', text: 'Hidden' });
  });

  it('handles a root with no children', () => {
    const fixture = build({ root: [] });
    const laid = layoutTree(
      resolveVisualRoot(fixture.root, fixture.childrenOf),
      fixture.childrenOf,
      fixture.sizeOf,
      DEFAULT_LAYOUT,
    );

    expect(laid).toHaveLength(1);
    expect(overlaps(laid, fixture)).toEqual([]);
  });

  it('produces finite coordinates for every layout', () => {
    const fixture = build(SAMPLE);
    for (const kind of ['two-sided', 'left', 'radial'] as const) {
      const laid = layoutTree(
        resolveVisualRoot(fixture.root, fixture.childrenOf),
        fixture.childrenOf,
        fixture.sizeOf,
        { ...DEFAULT_LAYOUT, kind },
      );
      for (const entry of laid) {
        expect(Number.isFinite(entry.x), `${kind} ${fixture.names.get(entry.id)} x`).toBe(true);
        expect(Number.isFinite(entry.y), `${kind} ${fixture.names.get(entry.id)} y`).toBe(true);
      }
    }
  });
});
