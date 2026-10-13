/**
 * Document model for Adnota.
 *
 * These types describe the shape of the data, not how it is stored. The canonical
 * representation is a Yjs document; see `schema.ts` for how these map onto it.
 *
 * This module deliberately has no DOM and no ProseMirror dependency so that it can
 * run in Node for tests and in Rust-side tooling. The inline document shape matches
 * ProseMirror's JSON so the editor can round-trip it without translation.
 */

/** Opaque identifier. Short, URL-safe, and sortable by creation time. */
export type NodeId = string;
export type StrokeId = string;
export type AssetId = string;

/**
 * Inline content, a node in the ProseMirror JSON shape.
 *
 * `math_inline` and `math_display` mirror the node names used by prosemirror-math so
 * that a document round-trips through the editor without a translation layer.
 */
export type InlineDoc = {
  readonly type: 'doc';
  readonly content: readonly InlineNode[];
};

export type InlineNode =
  | { readonly type: 'text'; readonly text: string; readonly marks?: readonly Mark[] }
  | { readonly type: 'math_inline'; readonly latex: string }
  | { readonly type: 'image'; readonly assetId: AssetId; readonly alt?: string };

/**
 * Marks are kept as plain records rather than a closed union. ProseMirror owns the
 * authoritative mark set; core only needs to round-trip it losslessly.
 */
export type Mark = {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
};

/** How a node's box is drawn. */
export type NodeShape = 'none' | 'underline' | 'round' | 'pill' | 'box';

/**
 * Colour is a palette slot rather than a raw hex string so that themes can restyle a
 * whole document consistently. A literal hex is accepted for one-off overrides.
 */
export type NodeColor = string;

export interface AdnotaNode {
  readonly id: NodeId;
  readonly parentId: NodeId | null;

  /** Short line shown on the canvas. Inline content only, so it stays readable. */
  readonly label: InlineDoc;

  /** Optional rich body shown in the notes panel. Null when empty. */
  readonly notes: BlockDoc | null;

  readonly shape: NodeShape;
  readonly color: NodeColor;
  readonly collapsed: boolean;

  /**
   * When pinned, the layout engine leaves this node where the author put it and the
   * surrounding layout flows around it. Lets a student hand-place a diagram without
   * losing tree structure.
   */
  readonly pinned: boolean;
  readonly offset: Readonly<{ x: number; y: number }>;

  readonly createdAt: number;
  readonly updatedAt: number;
}

export type BlockDoc = {
  readonly type: 'doc';
  readonly content: readonly BlockNode[];
};

export type BlockNode =
  | { readonly type: 'paragraph'; readonly content?: readonly InlineNode[] }
  | { readonly type: 'heading'; readonly attrs: Readonly<{ level: number }>; readonly content?: readonly InlineNode[] }
  | { readonly type: 'bullet_list'; readonly content: readonly BlockNode[] }
  | { readonly type: 'ordered_list'; readonly content: readonly BlockNode[] }
  | { readonly type: 'list_item'; readonly content: readonly BlockNode[] }
  | { readonly type: 'code_block'; readonly text: string }
  | { readonly type: 'blockquote'; readonly content: readonly BlockNode[] }
  | { readonly type: 'math_display'; readonly latex: string }
  | { readonly type: 'image'; readonly assetId: AssetId; readonly alt?: string };

/** Ink and shape geometry. */
export type InkTool = 'pen' | 'highlighter' | 'eraser';

/**
 * A stroke is either world-anchored (floating annotation) or node-anchored.
 *
 * Node-anchored strokes store their points in the node's local coordinate frame, so
 * handwriting stays glued to the thing it annotates across re-layout, collapse and
 * expand, and export. This is the single most important invariant in the geometry
 * model; see `anchoring.ts`.
 */
export interface AdnotaStroke {
  readonly id: StrokeId;

  /** Normalised points in the anchor's local frame, or world space when unanchored. */
  readonly points: readonly StrokePoint[];

  readonly color: string;
  readonly width: number;
  readonly tool: InkTool;
  readonly opacity: number;

  readonly anchorNodeId: NodeId | null;
  /** Position of the anchor's origin at the time the stroke was drawn. */
  readonly anchorOrigin: Readonly<{ x: number; y: number }> | null;
}

export interface StrokePoint {
  /** Position in the stroke's frame. */
  readonly x: number;
  readonly y: number;
  /** Pointer pressure, 0..1. Always present so a stroke drawn without a pressure
   *  stylus still round-trips identically. */
  readonly pressure: number;
}

/** Non-ink canvas objects: shapes and connectors. */
export interface AdnotaShape {
  readonly id: string;
  readonly kind: 'rect' | 'ellipse' | 'line' | 'arrow';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly strokeColor: string;
  readonly fillColor: string | null;
  readonly strokeWidth: number;
  readonly anchorNodeId: NodeId | null;
}

/** A binary asset stored alongside the document. */
export interface AdnotaAsset {
  readonly id: AssetId;
  readonly mime: string;
  readonly byteLength: number;
  readonly width: number | null;
  readonly height: number | null;
  /** Content hash, used as the filename inside the container. */
  readonly hash: string;
  readonly extension: string;
}

export interface DocMeta {
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly themeId: string;
}

/** The current on-disk container version. */
export const ADNOTA_FORMAT_VERSION = 1 as const;
