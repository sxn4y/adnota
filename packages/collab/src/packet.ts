/**
 * Sync packets.
 *
 * This is the collaboration rung that costs nothing and needs no infrastructure, and
 * it is the one that actually matches how students work: you do not need a live
 * shared session, you need to hand a classmate your Week 3 map before Friday.
 *
 * A packet is a Yjs *diff* plus any assets the receiver may be missing. Applying it
 * to a document that has diverged merges cleanly, because that is what CRDTs are for,
 * and applying it to a document that is identical is a no-op, so sending the same
 * packet twice is harmless.
 *
 * Because the packet is a diff against a known state, the sender can shrink it by
 * passing the receiver's state vector. In the common case of "here is my map, merge
 * it" the receiver has nothing, so the full update goes across; for a follow-up
 * exchange between two people who already share a history, only the new bytes do.
 */

import * as Y from 'yjs';
import { getAssets, loadDocument, buildDocument, type AssetBlob } from '@adnota/core';

export const PACKET_EXTENSION = '.adnotasync';
export const PACKET_MAGIC = 'ADNOTASYNC';

/**
 * Packet envelope format version.
 *
 * Separate from the `.adnota` container version because the two evolve for different
 * reasons: a container change concerns document layout, a packet change concerns the
 * exchange protocol.
 */
export const PACKET_VERSION = 1 as const;

export interface PacketHeader {
  readonly magic: typeof PACKET_MAGIC;
  readonly version: number;
  /** Hex-encoded state vector of the sending document. */
  readonly stateVector: string;
  /** Names and hashes of the assets the sender believes the receiver may lack. */
  readonly assetHashes: readonly string[];
  readonly createdAt: number;
}

export interface SyncPacket {
  readonly header: PacketHeader;
  /** Yjs update bytes. */
  readonly update: Uint8Array;
  /** Bytes for any asset listed in `header.assetHashes`. */
  readonly assets: ReadonlyMap<string, AssetBlob>;
}

export interface CreatePacketOptions {
  /**
   * The receiver's state vector, if known.
   *
   * Supplying it produces a diff instead of a full document. `null` or omitted sends
   * everything, which is the right default when the receiver may be starting fresh.
   */
  readonly since?: Uint8Array | null;
  /**
   * Asset hashes the receiver already has, so they can be left out.
   *
   * Getting this wrong in the safe direction costs bandwidth; getting it wrong in the
   * unsafe direction leaves a dangling reference, so only pass hashes you are certain
   * about.
   */
  readonly excludeAssets?: ReadonlySet<string>;
}

export function createSyncPacket(
  doc: Y.Doc,
  options: CreatePacketOptions = {},
): SyncPacket {
  const stateVector = Y.encodeStateVector(doc);
  const update = Y.encodeStateAsUpdate(doc, options.since ?? undefined);

  const excluded = options.excludeAssets ?? new Set<string>();

  const wanted = getAssets(doc).filter((asset) => !excluded.has(asset.hash));

  return {
    header: {
      magic: PACKET_MAGIC,
      version: PACKET_VERSION,
      stateVector: toHex(stateVector),
      assetHashes: wanted.map((asset) => asset.hash),
      createdAt: Date.now(),
    },
    update,
    assets: new Map(), // Populated by `createSyncPacketWithAssets`.
  };
}

/**
 * Build a packet, pulling asset bytes from the same place the document reads them.
 *
 * Split from `createSyncPacket` so the pure CRDT logic can be tested without a
 * filesystem, and so a caller can decide its own asset policy.
 */
export function createSyncPacketWithAssets(
  doc: Y.Doc,
  assetBytes: (hash: string) => Promise<Uint8Array | null>,
  options: CreatePacketOptions = {},
): Promise<SyncPacket> {
  const base = createSyncPacket(doc, options);

  return (async () => {
    const assets = new Map<string, AssetBlob>();
    const declared = getAssets(doc);
    const extensionByHash = new Map(declared.map((asset) => [asset.hash, asset.extension]));

    for (const hash of base.header.assetHashes) {
      const bytes = await assetBytes(hash);
      // A missing asset is not fatal. The document still merges; the image is simply
      // absent, and the receiving app reports it rather than refusing the whole packet.
      // Losing one picture is a far better failure than losing the notes.
      if (!bytes) continue;
      assets.set(hash, {
        hash,
        extension: extensionByHash.get(hash) ?? 'bin',
        bytes,
      });
    }

    return { header: base.header, update: base.update, assets };
  })();
}

export interface ApplyPacketResult {
  /** Bytes actually added to the document. Zero means the receiver was already current. */
  readonly bytesApplied: number;
  /** Asset bytes carried by the packet, for the caller to persist. */
  readonly assets: ReadonlyMap<string, AssetBlob>;
}

/**
 * Merge a packet into a document.
 *
 * Applied under a distinct origin so that receiving a packet does not mark the
 * document as locally dirty, and does not land in the local undo history. A student's
 * `Ctrl+Z` should undo their own typing, never their classmate's contribution.
 */
export function applySyncPacket(
  doc: Y.Doc,
  packet: SyncPacket,
  remoteOrigin: symbol,
): ApplyPacketResult {
  if (packet.header.magic !== PACKET_MAGIC) {
    throw new Error('Not an Adnota sync packet');
  }
  if (packet.header.version > PACKET_VERSION) {
    throw new Error(
      `This sync packet uses format ${packet.header.version}; this build understands ${PACKET_VERSION}. Update Adnota to read it.`,
    );
  }

  // The update is a diff against the sender's history, but Yjs merges by comparing
  // against the receiver's own state vector, so a diff computed for a specific peer is
  // still safe to apply anywhere. Anything the receiver lacks is added; anything it
  // already has is ignored.
  const before = Y.encodeStateVector(doc);
  Y.applyUpdate(doc, packet.update, remoteOrigin);
  const after = Y.encodeStateVector(doc);

  return {
    bytesApplied: differenceBytes(before, after),
    assets: packet.assets,
  };
}

/**
 * Serialise a packet for transport over any channel.
 *
 * A packet on the wire is exactly a `.adnota` container holding the update and the
 * assets, so the existing container writer is reused rather than a second archive
 * implementation being maintained.
 *
 * The header is not carried on the wire. `stateVector` only has meaning to the sender
 * that produced it, and `assetHashes` is recoverable from the archive itself. Both are
 * regenerated on decode, which keeps one container format rather than two.
 */
export async function encodeSyncPacket(packet: SyncPacket): Promise<Uint8Array> {
  const carrier = new Y.Doc();
  Y.applyUpdate(carrier, packet.update);

  const { bytes } = await buildDocument(carrier, packet.assets, {
    generator: `adnota/sync/${PACKET_VERSION}`,
  });
  return bytes;
}

/** Decode a packet produced by `encodeSyncPacket`. */
export async function decodeSyncPacket(bytes: Uint8Array): Promise<SyncPacket> {
  const loaded = await loadDocument(bytes);

  return {
    header: {
      magic: PACKET_MAGIC,
      version: PACKET_VERSION,
      stateVector: toHex(Y.encodeStateVector(loaded.doc)),
      assetHashes: [...loaded.assets.keys()],
      createdAt: Date.now(),
    },
    update: Y.encodeStateAsUpdate(loaded.doc),
    assets: loaded.assets,
  };
}

/**
 * Rough measure of how much a merge changed the document.
 *
 * Used only to report "this packet added N updates" to the user, so an approximation
 * from state-vector sizes is sufficient and avoids a second pass over the update.
 */
function differenceBytes(before: Uint8Array, after: Uint8Array): number {
  return Math.max(0, after.byteLength - before.byteLength);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
