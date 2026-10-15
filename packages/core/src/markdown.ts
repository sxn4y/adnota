/**
 * Markdown export.
 *
 * Exists so a student's notes outlive the app. A mindmap that can only be reopened in
 * Adnota is a trap; one that exports to Markdown can be read by Obsidian, Typora, a
 * text editor, a repository, or a word processor.
 *
 * Two decisions worth stating:
 *
 *   - **Maths round-trips as LaTeX, not as an image.** `$...$` and `$$...$$` are what
 *     the student typed and what they will want to search and edit later. Rendering to
 *     a picture would be prettier and would make the notes unsearchable.
 *   - **Structure comes from the tree, not from the layout.** A node at depth two
 *     exports as a nested bullet at two levels, so the exported document re-imports as
 *     the same mindmap and reads as an outline in a plain viewer.
 */

import {
  ROOT_NODE_ID,
  getChildIds,
  getChildren,
  getNode,
} from './schema.ts';
import type {
  AdnotaNode,
  BlockDoc,
  BlockNode,
  InlineDoc,
  InlineNode,
  NodeId,
} from './model.ts';
import type { Doc as YDoc } from 'yjs';

export interface MarkdownOptions {
  /** Include each node's rich notes body beneath its bullet. Off by default. */
  readonly includeNotes?: boolean;
  /** Emit a `# Title` heading from the document title. */
  readonly includeTitle?: boolean;
  /** Bullet character. `-` is what most Markdown parsers expect. */
  readonly bullet?: '-' | '*' | '+';
}

/**
 * Characters that would otherwise start Markdown structure or an HTML tag.
 *
 * Only the leading character is escaped, and only where it could actually be
 * misread: escaping every asterisk and underscore would make the output unreadable
 * for no benefit.
 */
function escapeInline(text: string): string {
  let out = '';

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    const isStructure = /[\\`*_{}[\]()#+\-.!|]/.test(char);

    // Only escape a character that could actually be misread as structure: at the
    // very start, or immediately after a space. Escaping every asterisk would make
    // the output unreadable for no benefit.
    const startsConstruct = i === 0 || text[i - 1] === ' ';

    out += isStructure && startsConstruct ? `\\${char}` : char;
  }

  // Angle brackets would open an HTML tag on re-import.
  return out.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render inline content, preserving maths and emphasis. */
export function inlineToMarkdown(doc: InlineDoc): string {
  return doc.content.map(inlineNodeToMarkdown).join('');
}

function inlineNodeToMarkdown(node: InlineNode): string {
  switch (node.type) {
    case 'text':
      return applyMarks(node.text, node.marks);

    case 'math_inline':
      // A dollar sign inside the formula would close the delimiter early and the
      // formula would silently become plain text on re-import. Students write prices
      // and intervals often enough for this to matter.
      return `$${node.latex.replace(/\$/g, '\\$')}$`;

    case 'image':
      // No file path is available at this layer, so the alt text stands alone rather
      // than emitting a link to a file that does not exist.
      return node.alt ? `*[${node.alt}]*` : `*[image]*`;
  }
}

function applyMarks(
  text: string,
  marks: readonly { readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> }[] | undefined,
): string {
  let out = escapeInline(text);

  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'strong':
        out = `**${out}**`;
        break;
      case 'em':
        out = `*${out}*`;
        break;
      case 'code':
        out = `\`${out}\``;
        break;
      case 'strike':
        out = `~~${out}~~`;
        break;
      default:
        break;
    }
  }

  return out;
}

/**
 * Convert a document to Markdown.
 *
 * Collapsed branches are still exported. Collapse is a view state, not part of the
 * notes, and silently dropping a branch the student had folded away would be data
 * loss dressed up as a feature.
 */
export function toMarkdown(
  doc: YDoc,
  options: MarkdownOptions = {},
): string {
  const bullet = options.bullet ?? '-';
  const lines: string[] = [];

  const meta = doc.getMap('meta');
  const title = typeof meta.get('title') === 'string' ? (meta.get('title') as string) : '';

  if (options.includeTitle && title) {
    lines.push(`# ${escapeInline(title)}`, '');
  }

  const emit = (parentId: NodeId, depth: number): void => {
    const indent = '  '.repeat(depth);

    for (const child of getChildren(doc, parentId)) {
      const label = inlineToMarkdown(child.label).trim();
      // An empty node still gets a bullet, so the exported outline keeps its shape
      // and the student can see where they had not written yet.
      lines.push(`${indent}${bullet} ${label}`.trimEnd());

      if (options.includeNotes && child.notes) {
        for (const line of blockToMarkdown(child.notes, depth + 1)) {
          lines.push(line);
        }
      }

      emit(child.id, depth + 1);
    }
  };

  emit(ROOT_NODE_ID, 0);

  return `${lines.join('\n').trimEnd()}\n`;
}

/** Render a notes body as indented Markdown beneath its node's bullet. */
export function blockToMarkdown(doc: BlockDoc, depth: number): string[] {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];

  for (const block of doc.content) {
    switch (block.type) {
      case 'paragraph':
        lines.push(`${indent}${inlineToMarkdown({ type: 'doc', content: block.content ?? [] })}`);
        break;

      case 'heading': {
        const level = Math.min(6, Math.max(1, block.attrs.level));
        lines.push(`${indent}${'#'.repeat(level)} ${inlineToMarkdown({ type: 'doc', content: block.content ?? [] })}`);
        break;
      }

      case 'bullet_list':
      case 'ordered_list': {
        const ordered = block.type === 'ordered_list';
        block.content.forEach((item: BlockNode, index: number) => {
          const marker = ordered ? `${index + 1}.` : '-';
          const [first, ...rest] = blockToMarkdown({ type: 'doc', content: [item] }, depth + 1);
          lines.push(`${indent}${marker} ${(first ?? '').trim()}`);
          lines.push(...rest);
        });
        break;
      }

      case 'list_item':
        lines.push(...blockToMarkdown({ type: 'doc', content: block.content }, depth));
        break;

      case 'blockquote':
        for (const line of blockToMarkdown({ type: 'doc', content: block.content }, depth)) {
          lines.push(`${indent}> ${line.trim()}`);
        }
        break;

      case 'code_block':
        lines.push(`${indent}\`\`\``, `${indent}${block.text}`, `${indent}\`\`\``);
        break;

      case 'math_display':
        lines.push(`${indent}$$${block.latex.replace(/\$/g, '\\$')}$$`);
        break;

      case 'image':
        lines.push(`${indent}*[${block.alt ?? 'image'}]*`);
        break;
    }
  }

  return lines;
}

/**
 * Convert to a flat outline, one line per node.
 *
 * The revision format: a list of levels with no bullet characters, which pastes
 * cleanly into a document and re-imports as a structure.
 */
export interface OutlineEntry {
  readonly id: NodeId;
  readonly depth: number;
  readonly text: string;
  readonly node: AdnotaNode;
}

export function toOutline(doc: YDoc): OutlineEntry[] {
  const out: OutlineEntry[] = [];

  const walk = (parentId: NodeId, depth: number): void => {
    for (const childId of getChildIds(doc, parentId)) {
      const node = getNode(doc, childId);
      if (!node) continue;

      out.push({
        id: node.id,
        depth,
        text: inlineToMarkdown(node.label).trim(),
        node,
      });

      if (!node.collapsed) walk(node.id, depth + 1);
    }
  };

  walk(ROOT_NODE_ID, 0);
  return out;
}

/** Plain text of the whole document, for search indexing and word counts. */
export function toPlainText(doc: YDoc): string {
  const parts: string[] = [];

  const walk = (parentId: NodeId): void => {
    for (const child of getChildren(doc, parentId)) {
      parts.push(plainInline(child.label));
      if (child.notes) parts.push(plainBlock(child.notes));
      walk(child.id);
    }
  };

  walk(ROOT_NODE_ID);
  return parts.join('\n');
}

function plainInline(doc: InlineDoc): string {
  return doc.content
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'math_inline':
          return node.latex;
        case 'image':
          return node.alt ?? '';
      }
    })
    .join('');
}

function plainBlock(doc: BlockDoc): string {
  return plainBlockContent(doc.content);
}

function plainBlockContent(content: readonly BlockNode[]): string {
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
        // These hold inline content directly.
        parts.push(plainInline({ type: 'doc', content: block.content ?? [] }));
        break;

      case 'image':
        parts.push(block.alt ?? '');
        break;

      default:
        // Lists and blockquotes hold more blocks rather than a document of their own.
        if (Array.isArray(block.content)) {
          parts.push(plainBlockContent(block.content));
        }
        break;
    }
  }

  return parts.join('\n');
}