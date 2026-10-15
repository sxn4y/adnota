/**
 * Storage abstraction.
 *
 * Adnota runs in three environments and none of them should leak into the document
 * layer: the Tauri desktop shell (Rust commands), the browser development harness
 * (IndexedDB), and Node during tests (fs). Each implements `BinaryStorage`, and the
 * document layer above knows none of the difference.
 *
 * All writes are expected to be atomic at this boundary. A half-written `.adnota`
 * file is data loss, and the user cannot tell it happened.
 */

/** A binary blob addressed by an opaque string path. */
export interface BinaryStorage {  /** Resolve to `null` when the path does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /** Must replace any existing file atomically; never leave a partial write. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Paths under `prefix`, not full paths. Used to enumerate sibling documents. */
  list(prefix: string): Promise<string[]>;
}

/** An in-memory storage. Used by tests and by the browser harness. */
export class MemoryStorage implements BinaryStorage {
  private readonly files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    const found = this.files.get(path);
    // Copy on read: callers should not be able to mutate stored bytes by accident.
    return found ? new Uint8Array(found) : null;
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, new Uint8Array(bytes));
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((key) => key.startsWith(prefix));
  }

  /** Test helper: the keys currently held. */
  keys(): string[] {
    return [...this.files.keys()];
  }
}
