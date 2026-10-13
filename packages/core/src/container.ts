/**
 * The `.adnota` container format.
 *
 * A `.adnota` file is a ZIP archive:
 *
 * ```
 *   format.json          container version and generator metadata
 *   doc.yjs              Yjs binary document state (Y.encodeStateAsUpdate)
 *   assets/<hash>.<ext>  binary assets, deduplicated by content hash
 * ```
 *
 * Storing the Yjs update rather than a serialisation of the model is what makes the
 * format collaborative: two `.adnota` files produced from divergent histories can be
 * merged losslessly, which a plain JSON dump could not do.
 *
 * ZIP entry timestamps are pinned so that encoding the same document twice produces
 * byte-identical output. That makes the format reproducible and diffable, which
 * matters when a user commits their notes to git.
 */

import JSZip from 'jszip';
import * as Y from 'yjs';
import { ADNOTA_FORMAT_VERSION, type AdnotaAsset } from './model.ts';
import { getAssets } from './schema.ts';

export const CONTAINER_EXTENSION = '.adnota';
export const MIME_TYPE = 'application/x-adnota';

const PATH_FORMAT = 'format.json';
const PATH_DOC = 'doc.yjs';
const ASSET_PREFIX = 'assets/';

/**
 * Pinned ZIP timestamp (1980-01-01T00:00:00Z), the earliest value the ZIP format
 * can represent. Any later date would make output non-reproducible.
 */
const FIXED_ENTRY_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

export interface ContainerFormat {
  readonly format: number;
  readonly app: 'adnota';
  readonly generator: string;
  readonly createdAt: number;
}

export interface AssetBlob {
  readonly hash: string;
  readonly extension: string;
  readonly bytes: Uint8Array;
}

export interface LoadedDocument {
  readonly doc: Y.Doc;
  readonly assets: ReadonlyMap<string, AssetBlob>;
}

export interface SerializeOptions {
  readonly generator?: string;
  readonly createdAt?: number;
}

export interface SerializedDocument {
  readonly bytes: Uint8Array;
  /** The Yjs update bytes, exposed so callers can persist or merge them directly. */
  readonly update: Uint8Array;
}

/**
 * Encode a document into container bytes.
 *
 * `assetBlobs` supplies the bytes for any asset referenced by the document. Assets
 * referenced but not supplied are an error rather than being silently dropped: a
 * `.adnota` file with a dangling image reference is a corrupt file, and failing loudly
 * at save time is far cheaper than discovering it after the user closes the app.
 *
 * Async because DEFLATE is. The document state itself is STOREd rather than
 * compressed, since it is already a compact binary encoding and deflating it would
 * cost CPU on every autosave for very little gain.
 */
export async function buildDocument(
  doc: Y.Doc,
  assetBlobs: ReadonlyMap<string, AssetBlob>,
  options: SerializeOptions = {},
): Promise<SerializedDocument> {
  const declared = getAssets(doc);
  const missing = declared.filter((asset) => !assetBlobs.has(asset.hash));
  if (missing.length > 0) {
    const names = missing.map((a) => a.hash.slice(0, 12)).join(', ');
    throw new Error(`Cannot save: ${missing.length} asset(s) missing from storage (${names}...)`);
  }

  const update = Y.encodeStateAsUpdate(doc);
  const zip = new JSZip();

  zip.file(
    PATH_FORMAT,
    JSON.stringify(
      {
        format: ADNOTA_FORMAT_VERSION,
        app: 'adnota',
        generator: options.generator ?? 'adnota/unknown',
        createdAt: options.createdAt ?? readCreatedAt(doc),
      } satisfies ContainerFormat,
      null,
      2,
    ),
  );

  zip.file(PATH_DOC, update, { date: FIXED_ENTRY_DATE, compression: 'STORE' });

  for (const asset of declared) {
    const blob = assetBlobs.get(asset.hash);
    if (!blob) continue;
    zip.file(assetPath(asset), blob.bytes, {
      date: FIXED_ENTRY_DATE,
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }

  const blob = await zip.generateAsync({
    type: 'uint8array',
    // Fixed so the archive is reproducible.
    platform: 'UNIX',
    mimeType: MIME_TYPE,
  });

  return { bytes: blob, update };
}

function readCreatedAt(doc: Y.Doc): number {
  const value = doc.getMap('meta').get('createdAt');
  return typeof value === 'number' ? value : Date.now();
}

/** Decode container bytes back into a live document plus its asset blobs. */
export async function loadDocument(bytes: Uint8Array): Promise<LoadedDocument> {
  const zip = await JSZip.loadAsync(bytes);

  const formatEntry = zip.file(PATH_FORMAT);
  if (!formatEntry) {
    throw new Error('Not an Adnota file: missing format.json');
  }

  let format: ContainerFormat;
  try {
    format = JSON.parse(await formatEntry.async('string')) as ContainerFormat;
  } catch {
    throw new Error('Not an Adnota file: format.json is unreadable');
  }

  if (format.app !== 'adnota') {
    throw new Error(`Not an Adnota file: unexpected producer "${String(format.app)}"`);
  }
  if (typeof format.format !== 'number') {
    throw new Error('Not an Adnota file: format.json has no version');
  }
  if (format.format > ADNOTA_FORMAT_VERSION) {
    throw new Error(
      `This file was written by a newer version of Adnota (format ${format.format}, ` +
        `this build understands ${ADNOTA_FORMAT_VERSION}). Update Adnota to open it.`,
    );
  }

  const docEntry = zip.file(PATH_DOC);
  if (!docEntry) {
    throw new Error('Not an Adnota file: missing doc.yjs');
  }

  const update = await docEntry.async('uint8array');
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);

  const assets = new Map<string, AssetBlob>();
  for (const asset of getAssets(doc)) {
    const entry = zip.file(assetPath(asset));
    if (!entry) {
      throw new Error(
        `This file is damaged: image ${asset.hash.slice(0, 12)} is referenced but not present in the archive.`,
      );
    }
    assets.set(asset.hash, {
      hash: asset.hash,
      extension: asset.extension,
      bytes: await entry.async('uint8array'),
    });
  }

  return { doc, assets };
}

export function assetPath(asset: AdnotaAsset): string {
  return `${ASSET_PREFIX}${asset.hash}.${asset.extension}`;
}

/**
 * Merge two container files produced from divergent histories.
 *
 * This is what makes folder sync work: put the file in Dropbox or Syncthing and the
 * CRDT reconciles concurrent edits when both copies are next opened. Returns the
 * union of both asset sets.
 */
export async function mergeDocuments(
  a: Uint8Array,
  b: Uint8Array,
): Promise<Uint8Array> {
  const [left, right] = await Promise.all([loadDocument(a), loadDocument(b)]);

  const merged = new Y.Doc();
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(left.doc));
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(right.doc));

  const blobs = new Map<string, AssetBlob>();
  for (const [hash, blob] of left.assets) blobs.set(hash, blob);
  for (const [hash, blob] of right.assets) blobs.set(hash, blob);

  const built = await buildDocument(merged, blobs);
  return built.bytes;
}
