/**
 * Standalone SVG export.
 *
 * The scene is already an SVG tree, so exporting it is mostly a matter of taking the part
 * the student actually drew and giving it a document around it. Two things are less
 * obvious than they look.
 *
 * ## The transform has to go
 *
 * On screen the content sits inside a pan-and-zoom `<g>`. Exporting that verbatim produces
 * a file whose contents are off-canvas, or scaled to nothing. So the export copies the
 * content group, strips its transform, and sets the new document's `viewBox` to the
 * laid-out extent instead. The exported map is therefore always framed on the content,
 * whatever the student happened to be looking at.
 *
 * ## The stylesheet has to come along
 *
 * Node boxes and branch lines are drawn with presentation attributes, so they survive
 * being copied into a bare document. Labels do not: they are HTML inside a `foreignObject`,
 * laid out by a stylesheet, and a saved `.svg` file has no access to the app's CSS. Copy a
 * label without its rules and you get unstyled text at the wrong size in the wrong place,
 * with every formula collapsed.
 *
 * So the export reads the stylesheets the page has already loaded and embeds them. That is
 * better than keeping a second copy of the rules for export, which would drift from the
 * real one within a week. The cost is that two kinds of rule are deliberately left out,
 * both noted where they are dropped below.
 */

import { layoutBounds, type LaidOutNode, type NodeSize } from '@adnota/scene';
import type { AdnotaNode } from '@adnota/core';

/** A rectangle in SVG user units, ready to become a `viewBox`. */
export interface SceneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Blank space left around the content, so nodes are not flush against the edge. */
const DEFAULT_PADDING = 24;

/**
 * A document that is somehow empty still has to produce a valid `viewBox`.
 *
 * `viewBox="0 0 0 0"` is an error in some renderers, and a viewBox with a negative
 * dimension is invalid outright.
 */
const MINIMUM_EXTENT = 1;

/**
 * Frame the laid-out content.
 *
 * `layoutBounds` inflates by each node's own box when given a measurer, which matters
 * here: node coordinates are their centres, so bounds taken from the centres alone would
 * cut every box in half.
 */
export function exportViewBox(
  nodes: readonly LaidOutNode[],
  sizeOf?: (node: AdnotaNode) => NodeSize,
  padding = DEFAULT_PADDING,
): SceneRect {
  const bounds = layoutBounds(nodes, sizeOf);

  const x = bounds.minX - padding;
  const y = bounds.minY - padding;
  const width = bounds.maxX - bounds.minX + padding * 2;
  const height = bounds.maxY - bounds.minY + padding * 2;

  return {
    x,
    y,
    width: Math.max(MINIMUM_EXTENT, width),
    height: Math.max(MINIMUM_EXTENT, height),
  };
}

/**
 * Decide whether a stylesheet rule belongs in the exported file.
 *
 * Kept narrow on purpose. Anything the app draws on screen that a bare document cannot
 * supply is dropped rather than emitted and left broken:
 *
 * - `@font-face` names font files by relative URL. Those URLs point into the app's build
 *   output, so in a file saved to the Desktop they resolve to nothing and the browser
 *   silently substitutes a fallback font. Keeping the rule would advertise a font that is
 *   not there; the honest result is that formulas fall back, which is what happens either
 *   way. Embedding the KaTeX font binaries would fix it at the cost of roughly 300 KB per
 *   exported file.
 * - `@media` and `@supports` are flattened. Printing rules in particular can end up
 *   matching by accident once the document is on a different surface, and a rule that
 *   unexpectedly applies is harder to debug than one that is absent.
 */
function ruleBelongsInExport(rule: CSSRule): boolean {
  if (rule instanceof CSSFontFaceRule) return false;
  if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) return false;

  return rule instanceof CSSStyleRule;
}

/**
 * The text of a rule, recursing into conditional groups.
 *
 * Conditional groups are skipped entirely by {@link ruleBelongsInExport}, so the recursion
 * only fires for a structure that has already been judged safe to flatten.
 */
function ruleText(rule: CSSRule, into: string[]): void {
  if (rule instanceof CSSStyleRule) {
    into.push(rule.cssText);
    return;
  }

  if ('cssRules' in rule) {
    const group = rule as CSSGroupingRule;
    for (const inner of Array.from(group.cssRules)) ruleText(inner, into);
  }
}

/**
 * Collect the styles a standalone document needs from the page's own stylesheets.
 *
 * Reads `document.styleSheets` rather than importing the CSS as text, because that way the
 * export cannot disagree with what the student is looking at.
 *
 * A stylesheet that the browser refuses to read — the usual cause is a cross-origin sheet,
 * as with a Google Fonts link — throws `SecurityError` on `cssRules`. That is skipped
 * rather than allowed to fail the export: a document with imperfect styling is worth much
 * more than an error dialog.
 */
export function collectExportStyles(doc: Document): string {
  const collected: string[] = [];

  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;

    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin stylesheet. Nothing to do but carry on without it.
      continue;
    }

    for (const rule of Array.from(rules)) {
      if (ruleBelongsInExport(rule)) ruleText(rule, collected);
    }
  }

  return collected.join('\n');
}

/** Options for {@link buildStandaloneSvg}. */
export interface StandaloneSvgOptions {
  /** The inner markup of the scene, already positioned in scene coordinates. */
  readonly content: string;
  readonly rect: SceneRect;
  /** Stylesheet text to embed, usually from {@link collectExportStyles}. */
  readonly styles?: string;
  /** Document title, used for the filename and the SVG's own title. */
  readonly title?: string;
}

/**
 * Escape text for use in XML character data or an attribute value.
 *
 * `&` and `<` alone would do for well-formedness, but a title is student input and quotes
 * appear in titles, so both delimiters are handled. Anything else is passed through
 * unchanged: over-escaping would corrupt the math in the body. The apostrophe is left
 * alone deliberately, since it is legal in both element text and a double-quoted value.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Assemble a self-contained SVG document around already-positioned content. */
export function buildStandaloneSvg({ content, rect, styles = '', title }: StandaloneSvgOptions): string {
  const viewBox = `${rect.x} ${rect.y} ${rect.width} ${rect.height}`;

  // Width and height are rounded to whole units. Fractional pixel dimensions are legal but
  // make the file behave differently in editors that snap to the pixel grid.
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);

  const heading = title === undefined ? '' : `<title>${escapeXml(title)}</title>`;

  // The namespace is not optional: without it the file renders as an XML tree in a browser
  // rather than a picture.
  const style = styles === '' ? '' : `<style>${styles}</style>`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">`,
    heading,
    // Background first, so the document is opaque wherever the app's own backdrop is
    // transparent. Without it a node with no fill shows whatever is behind the image.
    '<rect x="0" y="0" width="100%" height="100%" fill="#ffffff" />',
    style,
    content,
    '</svg>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}