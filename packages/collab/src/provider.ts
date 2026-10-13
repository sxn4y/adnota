/**
 * Provider interface for live collaboration.
 *
 * Sync packets (see `packet.ts`) need no provider at all, which is deliberate: the
 * app is fully collaborative-capable with zero infrastructure, and live providers are
 * an optional accelerator for people who want simultaneous editing.
 *
 * Every rung below costs nothing to run, which is a hard requirement for the project:
 *
 *   local-folder   no provider. The file lives in Dropbox or Syncthing and Yjs merges
 *                  on open. This is the default and needs no code.
 *   packet         no provider. `packet.ts`. Async exchange over any channel.
 *   webrtc         peer-to-peer mesh, needs a signalling server to introduce peers.
 *   relay          an optional self-hosted WebSocket relay, e.g. on Cloudflare
 *                  Workers' free tier or a Hocuspocus instance the user runs.
 *
 * There is no provider backed by a service we operate, and no account system.
 */

import type * as Y from 'yjs';

export type ProviderStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface ProviderEvents {
  status: (status: ProviderStatus, detail?: string) => void;
  /** A remote peer joined or left. */
  peers: (count: number) => void;
  /** Bytes received over the wire, for the diagnostics panel. */
  traffic: (bytesIn: number, bytesOut: number) => void;
}

export interface CollaborationProvider {
  readonly name: string;
  readonly doc: Y.Doc;
  readonly status: ProviderStatus;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Release resources. Must be safe to call more than once. */
  destroy(): void;

  on<K extends keyof ProviderEvents>(event: K, handler: ProviderEvents[K]): () => void;
}

export type ProviderFactory = (doc: Y.Doc, options: ProviderOptions) => CollaborationProvider;

export interface ProviderOptions {
  /** Room or document identifier shared with the other participants. */
  readonly room: string;
  /** Where to send presence and awareness updates. */
  readonly user: { readonly name: string; readonly color: string };
  /** Optional signalling server for peer-to-peer providers. */
  readonly signallingUrl?: string;
  readonly onError?: (error: Error) => void;
}

/**
 * The default provider: none.
 *
 * Returning this rather than `null` keeps call sites free of null checks, and makes
 * the standalone case explicit in the type system instead of an emergent property of
 * "no provider happened to be configured".
 */
export function createOfflineProvider(doc: Y.Doc): CollaborationProvider {
  const status = 'idle' as ProviderStatus;
  let destroyed = false;

  return {
    name: 'offline',
    doc,
    get status() {
      return status;
    },
    async connect() {
      /* Nothing to connect. The document is already durable on disk. */
    },
    async disconnect() {
      /* Nothing to disconnect. */
    },
    destroy() {
      destroyed = true;
    },
    on() {
      return () => undefined;
    },
    get destroyed() {
      return destroyed;
    },
  } as CollaborationProvider & { readonly destroyed: boolean };
}

/**
 * Validate a room name before it reaches a provider.
 *
 * Room names appear in shared links and become filenames when exported, so the
 * validation is deliberately narrow: no path separators, no traversal, bounded length.
 */
export function normalizeRoomName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Room name cannot be empty');
  }
  if (trimmed.length > 64) {
    throw new Error('Room name cannot be longer than 64 characters');
  }
  if (/[\\/:*?"<>|]/.test(trimmed)) {
    throw new Error('Room name cannot contain path separators or reserved characters');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('Room name cannot be a relative path');
  }
  return trimmed;
}
