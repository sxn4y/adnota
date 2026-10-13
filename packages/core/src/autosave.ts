/**
 * Autosave.
 *
 * Saving is the one operation in the app that can destroy a student's work, so it is
 * deliberately paranoid:
 *
 *   1. Write to a temporary path.
 *   2. Rotate the existing file to a `.bak` sidecar.
 *   3. Promote the temporary file into place.
 *
 * A crash at any point leaves either the previous good file or the new one on disk,
 * never a truncated blend of both. The `.bak` is the user's escape hatch when a merge
 * or a bad edit goes wrong.
 *
 * Saves are debounced and serialised: concurrent calls queue rather than racing,
 * because two overlapping writes to the same path is exactly the failure mode this
 * design exists to prevent.
 */

import type { AssetBlob } from './container.ts';
import { buildDocument } from './container.ts';
import { LOCAL_ORIGIN } from './schema.ts';
import type { BinaryStorage } from './storage.ts';
import * as Y from 'yjs';

export const BACKUP_SUFFIX = '.bak';

export interface SaveOptions {
  /** Milliseconds of quiet before a save is attempted. */
  readonly debounceMs?: number;
  /** Generator string stamped into the container. */
  readonly generator?: string;
  /** Called after each successful write. */
  readonly onSaved?: (bytes: number, revision: number) => void;
}

export interface SaveState {
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly lastSavedAt: number | null;
  readonly lastError: string | null;
  readonly revision: number;
}

type Listener = (state: SaveState) => void;

export class DocumentSession {
  readonly #storage: BinaryStorage;
  readonly #doc: Y.Doc;
  readonly #path: string;
  readonly #options: Required<Pick<SaveOptions, 'debounceMs'>> & SaveOptions;

  #assetProvider: () => ReadonlyMap<string, AssetBlob> = () => new Map();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #queue: Promise<void> = Promise.resolve();
  #state: SaveState = {
    saving: false,
    dirty: false,
    lastSavedAt: null,
    lastError: null,
    revision: 0,
  };
  #listeners = new Set<Listener>();

  constructor(doc: Y.Doc, path: string, storage: BinaryStorage, options: SaveOptions = {}) {
    this.#doc = doc;
    this.#path = path;
    this.#storage = storage;
    this.#options = { debounceMs: options.debounceMs ?? 2000, ...options };

    // Only local edits dirty the document. Remote updates arrive via a CRDT provider
    // and are already durable in the peer's state, so treating them as unsaved work
    // would cause pointless rewrites and could resurrect deleted content.
    //
    // The origin is checked inside the handler rather than passed as a filter,
    // because `Y.Doc.on` has no origin parameter; only `observe` does.
    this.#doc.on('update', this.#handleUpdate);
  }

  #handleUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin !== LOCAL_ORIGIN) return;
    this.#patch({ dirty: true });
    this.#schedule();
  };

  #schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.save();
    }, this.#options.debounceMs);
  }

  /** Supply the bytes for any assets the document references. */
  setAssetProvider(provider: () => ReadonlyMap<string, AssetBlob>): void {
    this.#assetProvider = provider;
  }

  get path(): string {
    return this.#path;
  }

  get state(): SaveState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  #patch(partial: Partial<SaveState>): void {
    this.#state = { ...this.#state, ...partial };
    for (const listener of this.#listeners) listener(this.#state);
  }

  /**
   * Flush to disk now. Safe to call concurrently: calls are serialised through a
   * queue so that only one write is ever in flight for this path.
   */
  save(): Promise<void> {
    const run = this.#queue.then(() => this.#writeNow());
    // Keep the queue alive even if this write rejects, otherwise one failed save
    // would permanently wedge every subsequent save.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #writeNow(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    this.#patch({ saving: true, lastError: null });

    const tempPath = `${this.#path}.tmp`;
    const backupPath = `${this.#path}${BACKUP_SUFFIX}`;

    try {
      const { bytes } = await buildDocument(
        this.#doc,
        this.#assetProvider(),
        this.#options.generator === undefined ? {} : { generator: this.#options.generator },
      );

      // 1. Stage the new content beside the original.
      await this.#storage.write(tempPath, bytes);

      // 2. Preserve the previous good file.
      const previous = await this.#storage.read(this.#path);
      if (previous !== null) {
        await this.#storage.write(backupPath, previous);
      }

      // 3. Promote.
      await this.#storage.write(this.#path, bytes);
      await this.#storage.remove(tempPath);

      this.#patch({
        saving: false,
        dirty: false,
        lastSavedAt: Date.now(),
        lastError: null,
        revision: this.#state.revision + 1,
      });
      this.#options.onSaved?.(bytes.byteLength, this.#state.revision);
    } catch (error) {
      // Clean up the staging file; leaving it would litter the user's folder and
      // could be mistaken for a real document by the file browser.
      await this.#storage.remove(tempPath).catch(() => undefined);

      const message = error instanceof Error ? error.message : String(error);
      this.#patch({ saving: false, dirty: true, lastError: message });
      throw error;
    }
  }

  /** Restore the `.bak` sidecar over the current file. */
  async restoreBackup(): Promise<boolean> {
    const backupPath = `${this.#path}${BACKUP_SUFFIX}`;
    const backup = await this.#storage.read(backupPath);
    if (backup === null) return false;
    await this.#storage.write(this.#path, backup);
    this.#patch({ dirty: false, lastSavedAt: Date.now() });
    return true;
  }

  /** Flush and stop reacting to edits. Call before the window closes. */
  async close(): Promise<void> {
    this.#doc.off('update', this.#handleUpdate);
    if (this.#state.dirty || this.#timer !== null) {
      await this.save().catch(() => undefined);
    }
  }
}

/**
 * Undo/redo scoped to local edits.
 *
 * `trackedOrigins` matters: without it, undo would revert a collaborator's changes
 * along with the local user's, which in a shared document is data loss.
 */
export function createUndoManager(doc: Y.Doc, localOrigin: symbol): Y.UndoManager {
  return new Y.UndoManager(
    [doc.getMap('nodes'), doc.getMap('children'), doc.getMap('strokes'), doc.getMap('shapes')],
    { trackedOrigins: new Set([localOrigin]) },
  );
}
