/**
 * @adnota/core — document model, CRDT bindings, container format, and persistence.
 *
 * This package has no DOM dependency and no React. It runs unchanged in Node for
 * tests, in the browser for the development harness, and inside the Tauri shell.
 */

export type {
  AdnotaAsset,
  AdnotaNode,
  AdnotaShape,
  AdnotaStroke,
  AssetId,
  BlockDoc,
  BlockNode,
  DocMeta,
  InkTool,
  InlineDoc,
  InlineNode,
  Mark,
  NodeColor,
  NodeId,
  NodeShape,
  StrokeId,
  StrokePoint,
} from './model.ts';
export { ADNOTA_FORMAT_VERSION } from './model.ts';

/**
 * Yjs types, re-exported so consumers do not need a direct `yjs` dependency.
 *
 * A workspace package that touches the document must not also need to pin its own
 * Yjs version, or the two can resolve to different CRDT implementations and silently
 * stop interoperating. Going through core keeps a single version in the tree.
 */
export type { Doc as YDoc, Map as YMap, Array as YArray, UndoManager as YUndoManager } from 'yjs';

export {
  LOCAL_ORIGIN,
  REMOTE_ORIGIN,
  ROOT_NODE_ID,
  SCHEMA_KEYS,
  allNodes,
  assetsMap,
  childrenMap,
  createDoc,
  createNode,
  emptyLabel,
  getAssets,
  getChildIds,
  getChildren,
  getMeta,
  getNode,
  getShapes,
getStrokes,
  migrateChildrenLayout,
  moveNode,
  newId,
  nodesMap,
  putAsset,
  putShape,
  putStroke,
  removeNode,
  setAppearance,
  setCollapsed,
  setLabel,
  setNotes,
  setPinned,
  setTitle,
  shapesMap,
  strokesMap,
  subtreeIds,
  walkVisible,
} from './schema.ts';

export type { AssetBlob, ContainerFormat, LoadedDocument, SerializeOptions, SerializedDocument } from './container.ts';
export {
  CONTAINER_EXTENSION,
  MIME_TYPE,
  assetPath,
  buildDocument,
  loadDocument,
  mergeDocuments,
} from './container.ts';

export type { BinaryStorage } from './storage.ts';
export { MemoryStorage } from './storage.ts';

export type { DocumentSummary } from './summary.ts';
export { readSummary, sortSummaries, titleFromName } from './summary.ts';

export type { SaveOptions, SaveState } from './autosave.ts';
export { BACKUP_SUFFIX, DocumentSession, createUndoManager } from './autosave.ts';

export type { MarkdownOptions, OutlineEntry } from './markdown.ts';
export { blockToMarkdown, inlineToMarkdown, toMarkdown, toOutline, toPlainText } from './markdown.ts';

export type { SearchHit, SearchOptions, Snippet } from './search.ts';
export { indexOfCaseInsensitive, search, snippetAround } from './search.ts';
