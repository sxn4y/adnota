/**
 * @adnota/collab — collaboration that costs nothing to run.
 *
 * The centrepiece is `packet.ts`: asynchronous CRDT exchange with no server, no
 * account and no network dependency at all. Live providers are an optional
 * accelerator layered on top of a document that is already mergeable.
 */

export type {
  ApplyPacketResult,
  CreatePacketOptions,
  PacketHeader,
  SyncPacket,
} from './packet.ts';
export {
  PACKET_EXTENSION,
  PACKET_MAGIC,
  PACKET_VERSION,
  applySyncPacket,
  createSyncPacket,
  createSyncPacketWithAssets,
  decodeSyncPacket,
  encodeSyncPacket,
} from './packet.ts';

export type {
  CollaborationProvider,
  ProviderEvents,
  ProviderFactory,
  ProviderOptions,
  ProviderStatus,
} from './provider.ts';
export { createOfflineProvider, normalizeRoomName } from './provider.ts';
