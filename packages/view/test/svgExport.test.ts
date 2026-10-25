/**
 * Tests for standalone SVG export.
 *
 * The interesting parts are the two transformations the export performs — reframing the
 * content, and choosing which stylesheet rules travel with it. Both are pure, so both are
 * tested here under Node. The part that genuinely needs a browser — reading the page's real
 * stylesheets — is covered in `tests/visual/export.spec.ts`.
 */

import { describe, expect, test } from 'vitest';
import type { LaidOutNode, NodeSize } from '@adnota/scene';
import type { AdnotaNode } from '@adnota/core';
import { buildStandaloneSvg, escapeXml, exportViewBox } from '../src/svgExport.ts';

/** A node entry at a known position, so the expected framing is arithmetic rather than a guess. */
function entryAt(x: number, y: number): LaidOutNode {
  return {
    id: `n${x}-${y}`,
    node: { id: `n${x}-${y}`, parentId: 'root' } as unknown as AdnotaNode,
    x,
    y,
    depth: 1,
    side: 'right',
    width: 0,
    height: 0,
  } as unknown as LaidOutNode;
}

describe('exportViewBox', () => {
  test('frames the content with padding on every side', () => {
    const rect = exportViewBox([entryAt(-100, -50), entryAt(100, 50)], undefined, 10);

    expect(rect).toEqual({ x: -110, y: -60, width: 220, height: 120 });
  });

  test('inflates by each node box, because positions are centres', () => {
    // Without a measurer the bounds are taken from node centres, which would slice every
    // box in half. This is the case that makes the exported map look clipped.
    const wide = { width: 200, height: 40 } satisfies NodeSize;
    const rect = exportViewBox([entryAt(0, 0)], () => wide, 0);

    expect(rect).toEqual({ x: -100, y: -20, width: 200, height: 40 });
  });

  test('never produces a zero or negative extent', () => {
    // `viewBox` with a non-positive dimension is invalid, and an empty document is a real
    // state rather than a hypothetical one.
    const rect = exportViewBox([], undefined, 0);

    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  });

  test('a single node still gets a drawable frame', () => {
    const rect = exportViewBox([entryAt(7, 9)], undefined, 5);

    expect(rect.x).toBe(2);
    expect(rect.y).toBe(4);
    expect(rect.width).toBe(10);
    expect(rect.height).toBe(10);
  });
});

describe('buildStandaloneSvg', () => {
  const rect = { x: -10, y: -10, width: 220, height: 120 };

  test('declares the SVG namespace, without which browsers show a tree, not a picture', () => {
    const svg = buildStandaloneSvg({ content: '<g/>', rect });

    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  test('frames the document on the content rather than the viewport', () => {
    const svg = buildStandaloneSvg({ content: '<g/>', rect });

    expect(svg).toContain('viewBox="-10 -10 220 120"');
    // Rounded, because fractional pixel dimensions behave oddly in editors that snap.
    expect(svg).toContain('width="220"');
    expect(svg).toContain('height="120"');
  });

  test('carries the content through unchanged', () => {
    const svg = buildStandaloneSvg({ content: '<g data-node-id="n1"><rect /></g>', rect });

    expect(svg).toContain('<g data-node-id="n1"><rect /></g>');
  });

  test('embeds the stylesheet so labels are not left unstyled', () => {
    const svg = buildStandaloneSvg({
      content: '<g/>',
      rect,
      styles: '.adnota-node-label { text-align: center; }',
    });

    expect(svg).toContain('<style>.adnota-node-label { text-align: center; }</style>');
  });

  test('omits the style element entirely when there is nothing to embed', () => {
    const svg = buildStandaloneSvg({ content: '<g/>', rect, styles: '' });

    expect(svg).not.toContain('<style>');
  });

  test('puts an opaque background behind the nodes', () => {
    // Without this, a node with no fill shows whatever is behind the image when it is
    // placed on a dark page.
    const svg = buildStandaloneSvg({ content: '<g/>', rect });

    expect(svg).toContain('<rect x="0" y="0" width="100%" height="100%" fill="#ffffff" />');
  });

  test('includes a title only when there is one', () => {
    expect(buildStandaloneSvg({ content: '<g/>', rect })).not.toContain('<title>');
    expect(buildStandaloneSvg({ content: '<g/>', rect, title: 'Week 3' })).toContain(
      '<title>Week 3</title>',
    );
  });

  test('escapes a title rather than letting student input break the XML', () => {
    const svg = buildStandaloneSvg({ content: '<g/>', rect, title: 'a & b <c> "d"' });

    expect(svg).toContain('<title>a &amp; b &lt;c&gt; &quot;d&quot;</title>');
    expect(svg).not.toContain('<c>');
  });

  test('is well-formed XML', () => {
    const svg = buildStandaloneSvg({ content: '<g><rect /></g>', rect, title: 'ok' });

    // Cheap structural check: one root, one close, declaration present. Enough to catch the
    // unclosed-element and stray-character mistakes that actually happen here.
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svg.match(/<svg\b/g)).toHaveLength(1);
    expect(svg.match(/<\/svg>/g)).toHaveLength(1);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });
});

describe('escapeXml', () => {
  test('handles the XML delimiters that matter here', () => {
    expect(escapeXml(`&<>"`)).toBe('&amp;&lt;&gt;&quot;');
  });

  test('leaves an apostrophe alone, which is legal in text and in quoted values', () => {
    expect(escapeXml("Sam's notes")).toBe("Sam's notes");
  });

  test('leaves ordinary text alone', () => {
    expect(escapeXml('Week 3: integrals (revision)')).toBe('Week 3: integrals (revision)');
  });
});