/**
 * Image bytes: what they are, how big they are, and what they hash to.
 *
 * Everything here is deliberately free of DOM and canvas so it runs in Node under test
 * and inside a worker, and so that a picture's pixel dimensions are known *before*
 * anything has decided to draw it. Measurement has to happen synchronously during layout;
 * the alternative, decoding through `createImageBitmap` and then re-laying out, makes the
 * map jump every time a picture finishes loading.
 *
 * That is the whole reason this module parses headers by hand. `Image.width` exists, but
 * it only exists after a decode, and a layout engine cannot wait.
 *
 * ## What is recognised
 *
 * PNG, JPEG, GIF and WebP. These cover screenshots (PNG), photographs (JPEG and WebP),
 * and anything a textbook PDF was screenshotted into. An SVG is deliberately *not*
 * accepted: it is a document that can carry script, and dropping one into a notes file
 * would mean storing something that executes when the container is viewed elsewhere.
 */

/** What a byte string turned out to be. */
export interface ImageInfo {
  readonly mime: string;
  /** Lowercase, without the dot — the filename inside the container. */
  readonly extension: string;
  /** Intrinsic width in pixels, or null when the header does not say. */
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * Ceiling on a single image.
 *
 * Not an aesthetic limit. Bytes reach Rust through Tauri's JSON argument path, where a
 * `Uint8Array` becomes an array of numbers and costs about four bytes per byte on the
 * wire; an 8 MiB screenshot is a ~32 MB save every time autosave fires. This number
 * exists to keep that bounded while the bridge moves to a raw-body channel. When it
 * does, this ceiling should be revisited rather than simply raised.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Formats a picture may be stored as. */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/** True for a MIME type this build will store. */
export function isImageMime(mime: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Identify an image from its bytes, or return null.
 *
 * The magic bytes are checked rather than the MIME type a caller claims, because the
 * claim is the thing being verified: a clipboard item labelled `image/png` is routinely a
 * fragment of something else entirely, and the extension is what ends up in the
 * container's filename.
 */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
}

/** Why an image was refused, phrased for a student rather than a log. */
export class ImageRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRejected';
  }
}

/**
 * Check an image is one we can store, throwing a `ImageRejected` with the reason.
 *
 * The two failure modes a student actually hits are "that is not a picture" and "that
 * picture is too big", and both deserve a sentence rather than a stack trace.
 */
export function requireStorableImage(bytes: Uint8Array): ImageInfo {
  const info = sniffImage(bytes);
  if (!info) {
    throw new ImageRejected('That is not a PNG, JPEG, GIF or WebP image.');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageRejected(
      `That image is ${formatBytes(bytes.byteLength)}. The limit is ${formatBytes(MAX_IMAGE_BYTES)}.`,
    );
  }
  return info;
}

/** Human-readable byte count, for the messages a student reads. */
export function formatBytes(count: number): string {
  if (count < 1024) return `${count} bytes`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(0)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Content hash, as lowercase hex.
 *
 * SHA-256 over the bytes, via WebCrypto, which is present in Node 22 and in every
 * webview Adnota runs in. This is the filename inside the container, which is what makes
 * assets deduplicate: the same screenshot pasted into two documents occupies one blob
 * in each file rather than two.
 */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  // `subtle.digest` wants a BufferSource whose buffer is not shared with a larger
  // allocation. `Uint8Array.from` copies only when the input is a view onto a bigger
  // buffer, which a `File.arrayBuffer()` result never is.
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

import { assetIdFor, hashBytes, requireStorableImage } from './assets.ts';
import type { NodeId } from './model.ts';
import { createNode, getAssets, putAsset, setLabel } from './schema.ts';
import type { YDoc } from 'yjs';

/**
 * Put a picture into a document as a new node, and return its id.
 *
 * The whole insertion path in one call, because the three steps have to agree with each
 * other and the only thing worse than a broken feature is one that half-works: record the
 * asset, reference it from a node, and have the node's size in the layout depend on the
 * asset's dimensions. Split across three call sites, the second and third can be skipped.
 *
 * Content-addressed, so pasting the same screenshot into the same document twice adds one
 * blob and two nodes — and `getAssets` still reports one asset, because it is keyed by a
 * hash-derived id.
 *
 * The label is optional and becomes the caption. Nothing is inferred from the file name:
 * a student pasting `Screenshot 2026-10-15 at 14.22.07.png` wants the caption they
 * typed, not the caption their operating system guessed.
 *
 * Throws `ImageRejected` when the bytes are not a storable image, so the caller can
 * report the reason instead of inserting a node that will never draw.
 */
export async function insertImageNode(
  doc: YDoc,
  input: { readonly bytes: Uint8Array; readonly parentId: NodeId; readonly alt?: string },
): Promise<NodeId> {
  const info = requireStorableImage(input.bytes);
  const hash = await hashBytes(input.bytes);
  const assetId = assetIdFor(hash);

  const known = getAssets(doc).find((asset) => asset.id === assetId);
  if (!known) {
    putAsset(doc, {
      id: assetId,
      mime: info.mime,
      byteLength: input.bytes.byteLength,
      width: info.width,
      height: info.height,
      hash,
      extension: info.extension,
    });
  }

  const id = createNode(doc, {
    parentId: input.parentId,
    image: { assetId, alt: input.alt ?? '' },
  });

  if (input.alt) setLabel(doc, id, { type: 'doc', content: [{ type: 'text', text: input.alt }] });

  return id;
}

/** An identifier for an asset, derived from its content rather than its arrival time. */
export function assetIdFor(hash: string): string {
  return `a_${hash.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/** PNG: 8-byte signature, then an IHDR chunk carrying width and height. */
function png(bytes: Uint8Array): ImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!startsWith(bytes, signature)) return null;
  // Bytes 12..16 spell "IHDR"; the dimensions are the next two big-endian uint32s.
  if (!spells(bytes, 12, 'IHDR')) return null;

  return {
    mime: 'image/png',
    extension: 'png',
    width: readUint32(bytes, 16),
    height: readUint32(bytes, 20),
  };
}

/** GIF: "GIF87a" or "GIF89a", then the logical screen descriptor. */
function gif(bytes: Uint8Array): ImageInfo | null {
  if (!spells(bytes, 0, 'GIF8')) return null;
  // Bytes 3..6 are "7a" or "9a"; the version is irrelevant to the dimensions.
  const size = readUint16LE(bytes, 6);
  return {
    mime: 'image/gif',
    extension: 'gif',
    width: size > 0 ? size : null,
    height: (() => {
      const height = readUint16LE(bytes, 8);
      return height > 0 ? height : null;
    })(),
  };
}

/**
 * JPEG: walk the marker segments to the frame header.
 *
 * The only format here without a fixed offset. Each segment starts `FF` then a marker
 * byte; four of them — SOF0 through SOF15, skipping the non-frame markers DHT, JPG and
 * DAC — carry the dimensions. Everything after the dimensions is irrelevant, so the
 * walk stops at the first one it recognises.
 */
function jpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) {
      // Padding between segments is legal; skip it rather than giving up.
      at += 1;
      continue;
    }

    const marker = bytes[at + 1];
    // 0xFF is a fill byte, 0x00 is a stuffed zero inside entropy-coded data.
    if (marker === 0xff || marker === 0x00 || marker === 0xd8 || marker === 0xd9) {
      at += 2;
      continue;
    }

    const length = readUint16BE(bytes, at + 2);
    if (length < 2) return null;

    if (isStartOfFrame(marker)) {
      // Height then width, then a component count. One byte of precision first.
      const height = readUint16BE(bytes, at + 5);
      const width = readUint16BE(bytes, at + 7);
      return {
        mime: 'image/jpeg',
        extension: 'jpg',
        width: width > 0 ? width : null,
        height: height > 0 ? height : null,
      };
    }

    at += 2 + length;
  }

  // A JPEG whose frame header was never reached: it is still a JPEG, and the layout will
  // fall back to a default box rather than refusing to open the document.
  return { mime: 'image/jpeg', extension: 'jpg', width: null, height: null };
}

/**
 * WebP: a RIFF container whose payload is a VP8, VP8L or VP8X chunk.
 *
 * Three bitstreams behind one container, because the format dates from three codecs.
 * Each puts its dimensions in a different place and at a different bit depth, so they
 * are read separately rather than through one clever expression.
 */
function webp(bytes: Uint8Array): ImageInfo | null {
  if (!spells(bytes, 0, 'RIFF') || !spells(bytes, 8, 'WEBP')) return null;

  const base = { mime: 'image/webp', extension: 'webp' } as const;

  if (spells(bytes, 12, 'VP8 ')) {
    // Lossy: a 3-byte frame tag, then 14 bits each of width and height.
    return { ...base, width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff };
  }

  if (spells(bytes, 12, 'VP8L')) {
    // Lossless: 14 bits width, 14 bits height, packed after a 1-bit signature.
    const bits = readUint32LE(bytes, 21);
    return { ...base, width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }

  if (spells(bytes, 12, 'VP8X')) {
    // Extended: 24-bit width minus one, then 24-bit height minus one, both little-endian.
    const width = readUintLE(bytes, 24, 3) + 1;
    const height = readUintLE(bytes, 27, 3) + 1;
    return { ...base, width, height };
  }

  return { ...base, width: null, height: null };
}

/** SOF0..SOF15, minus the three markers in that range that are not frame headers. */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  // DHT (c4), JPG (c8) and DAC (cc) share the range but define tables, not a picture.
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function spells(bytes: Uint8Array, at: number, text: string): boolean {
  if (bytes.length < at + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[at + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readUint16BE(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function readUint16LE(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function readUint32BE(bytes: Uint8Array, at: number): number {
  // Unsigned: `<< 24` produces a signed result above 2^31, and a picture that wide
  // should report a wrong number rather than a negative one.
  return (
    bytes[at] * 0x1000000 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]
  );
}

function readUint32LE(bytes: Uint8Array, at: number): number {
  return bytes[at] + bytes[at + 1] * 0x100 + bytes[at + 2] * 0x10000 + bytes[at + 3] * 0x1000000;
}

/** `count` little-endian bytes at `at`, as an unsigned integer. */
function readUintLE(bytes: Uint8Array, at: number, count: number): number {
  let value = 0;
  for (let index = count - 1; index >= 0; index -= 1) {
    value = value * 0x100 + (bytes[at + index] ?? 0);
  }
  return value;
}