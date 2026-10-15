/**
 * Search over the document.
 *
 * A plain substring scan is genuinely adequate at the scale of a mindmap: a semester's
 * notes are hundreds of nodes, not hundreds of thousands, and an index that must be
 * rebuilt on every keystroke would cost more than it saves.
 *
 * What the naive version gets wrong is scoring and ordering. A student searching for
 * "integral" wants the node titled "Definite integrals" above the one that merely
 * mentions it in passing, and a match inside a formula is usually not what they meant.
 */

import { ROOT_NODE_ID, getChildren } from './schema.ts';
import type { AdnotaNode, BlockDoc, BlockNode, InlineDoc, NodeId } from './model.ts';
import type { Doc as YDoc } from 'yjs';

/** A window of text around a match, with the match's offset relative to the window. */
export interface Snippet {
  readonly text: string;
  readonly start: number;
  readonly length: number;
}

export interface SearchHit {
  readonly id: NodeId;
  readonly node: AdnotaNode;
  readonly score: number;
  /** Plain text of the matched node, for the result list. */
  readonly snippet: string;
  /** Characters of `snippet` that matched, for highlighting. */
  readonly matchStart: number;
  readonly matchLength: number;
}

export interface SearchOptions {
  /** Cap on returned hits, so a very common term cannot flood the palette. */
  readonly limit?: number;
  /** Include nodes whose only match is inside a formula. Off by default. */
  readonly includeMath?: boolean;
}

/**
 * Search a document.
 *
 * Ranking, in order of weight:
 *   1. the match is in the node's label rather than its notes
 *   2. the match starts the label (a title match is what a searcher usually means)
 *   3. shorter labels (a terser node is more likely to be the one meant)
 */
export function search(
  doc: YDoc,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const limit = options.limit ?? 50;
  const hits: SearchHit[] = [];

  const walk = (parentId: NodeId): void => {
    for (const node of getChildren(doc, parentId)) {
      const labelText = plainOf(node.label);
      const labelHit = indexOfCaseInsensitive(labelText, needle);

      if (labelHit >= 0) {
        const snippet = snippetAround(labelText, labelHit, needle.length);
        hits.push({
          id: node.id,
          node,
          score: score(labelHit, labelText.length, needle.length, 3),
          snippet: snippet.text,
          matchStart: snippet.start,
          matchLength: needle.length,
        });
      } else if (options.includeMath && node.notes) {
        const body = `${labelText}\n${plainOfBlock(node.notes)}`;
        const bodyHit = indexOfCaseInsensitive(body, needle);
        if (bodyHit >= 0) {
          const snippet = snippetAround(body, bodyHit, needle.length);
          hits.push({
            id: node.id,
            node,
            score: score(bodyHit, body.length, needle.length, 1),
            snippet: snippet.text,
            matchStart: snippet.start,
            matchLength: needle.length,
          });
        }
      }

      walk(node.id);
    }
  };

  walk(ROOT_NODE_ID);

  hits.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  return hits.slice(0, limit);
}

function score(
  index: number,
  textLength: number,
  needleLength: number,
  weight: number,
): number {
  const startsLabel = index === 0 ? 40 : 0;
  // Brevity: among two matches of equal quality, the shorter label is the better bet.
  const brevity = Math.max(0, 20 - Math.floor(textLength / 12));
  return weight * 100 + startsLabel + brevity + needleLength;
}

function plainOf(doc: InlineDoc): string {
  return doc.content
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'math_inline':
          // Maths is included in the searchable text so `x^2` is findable, but it
          // contributes to the plain text without pretending to be prose.
          return node.latex;
        case 'image':
          return node.alt ?? '';
      }
    })
    .join('');
}

function plainOfBlock(doc: BlockDoc): string {
  return plainOfBlockContent(doc.content);
}

function plainOfBlockContent(content: readonly BlockNode[]): string {
  const parts: string[] = [];

  for (const block of content) {
    switch (block.type) {
      case 'code_block':
        parts.push(block.text);
        break;

      case 'math_display':
        parts.push(block.latex);
        break;

      case 'paragraph':
      case 'heading':
        parts.push(plainOf({ type: 'doc', content: block.content ?? [] }));
        break;

      case 'image':
        parts.push(block.alt ?? '');
        break;

      default:
        // Lists and blockquotes hold more blocks rather than a document of their own.
        if (Array.isArray(block.content)) {
          parts.push(plainOfBlockContent(block.content));
        }
        break;
    }
  }

  return parts.join('\n');
}

export function indexOfCaseInsensitive(haystack: string, needle: string): number {
  return haystack.toLowerCase().indexOf(needle);
}

/** A window of text around a match, with the match's offset relative to it. */
export function snippetAround(
  text: string,
  index: number,
  length: number,
  radius = 48,
): Snippet {
  if (text.length <= radius * 2) {
    return { text, start: index, length };
  }

  let from = Math.max(0, index - radius);
  let to = Math.min(text.length, index + length + radius);

  // Snap to word boundaries so the snippet does not start mid-word.
  if (from > 0) {
    const space = text.indexOf(' ', from);
    if (space >= 0 && space < index) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(' ', to);
    if (space > index) to = space;
  }

  return {
    text: `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`,
    start: (from > 0 ? 1 : 0) + (index - from),
    length,
  };
}