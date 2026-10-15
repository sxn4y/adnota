/**
 * Tauri-backed `BinaryStorage`.
 *
 * The only file in the desktop app that knows a filesystem exists. Everything above it
 * sees the same five async methods the browser harness implements over a `Map`, which
 * is what lets the document layer, the autosave logic, and the container format be
 * tested under Node with no window in sight.
 *
 * ## Byte encoding
 *
 * Tauri serialises command arguments as JSON, and JSON has no byte type, so `Uint8Array`
 * arrives in Rust as a `Vec<u8>` only after crossing that boundary. The cost is real —
 * a `Uint8Array` becomes an array of numbers, roughly an order of magnitude larger on
 * the wire — which is fine for a text document and unacceptable for a photograph.
 *
 * Assets are not implemented yet, so nothing hits this today. Images will need Tauri's
 * raw-body channel instead. The same limitation is documented on the Rust side; it is
 * recorded in both places deliberately so neither half can be changed alone.
 */

import { invoke } from '@tauri-apps/api/core';
import type { BinaryStorage } from '@adnota/core';

export class TauriStorage implements BinaryStorage {
  /**
   * The absolute directory every path is resolved against.
   *
   * Held as a constructor argument rather than passed per call so that it cannot be
   * swapped midway through a save. The Rust side rejects absolute paths and parent
   * traversal, so this is the single place containment is anchored.
   */
  readonly #base: string;

  constructor(base: string) {
    this.#base = base;
  }

  get base(): string {
    return this.#base;
  }

  async read(path: string): Promise<Uint8Array | null> {
    const bytes = await invoke<number[] | null>('read', { base: this.#base, path });
    // Null means "no such file", which is a normal outcome, not a failure.
    return bytes === null ? null : Uint8Array.from(bytes);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await invoke('write', { base: this.#base, path, bytes: Array.from(bytes) });
  }

  async remove(path: string): Promise<void> {
    await invoke('remove', { base: this.#base, path });
  }

  async exists(path: string): Promise<boolean> {
    return invoke<boolean>('exists', { base: this.#base, path });
  }

  async list(prefix: string): Promise<string[]> {
    return invoke<string[]>('list', { base: this.#base, prefix });
  }

  /** Epoch milliseconds of the last write, or null when the file is absent. */
  async modifiedAt(path: string): Promise<number | null> {
    const value = await invoke<number | null>('modified_at', { base: this.#base, path });
    return value === null ? null : value;
  }
}

/** Ask Rust where documents live, creating the directory if it is missing. */
export function resolveBase(): Promise<string> {
  return invoke<string>('default_base');
}

/**
 * Read a document the student picked through a dialog.
 *
 * A separate path from {@link TauriStorage} on purpose. Every method above resolves
 * inside the library base and refuses to leave it; these two are the single, narrow way
 * out, and Rust re-validates them — extension allowlist, no parent traversal, absolute
 * paths only, and a size ceiling on reads.
 */
export function readExternal(path: string): Promise<Uint8Array> {
  return invoke<number[]>('read_external', { path }).then((bytes) => Uint8Array.from(bytes));
}

/** Write a document to a path the student picked through a dialog, atomically. */
export function writeExternal(path: string, bytes: Uint8Array): Promise<void> {
  return invoke('write_external', { path, bytes: Array.from(bytes) });
}
