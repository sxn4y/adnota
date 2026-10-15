/**
 * Document summaries.
 *
 * Reading a document's name and modified time by opening it would mean decompressing
 * and applying the whole CRDT for every file in the folder. A student with a term's
 * worth of notes would feel that as a pause before the file list appeared, and it gets
 * worse with every file added.
 *
 * `format.json` carries the same two facts, so a listing reads only that — a few bytes
 * per file instead of the whole document.
 *
 * Optional by design: a file written before these fields existed still opens, and simply
 * falls back to its filename and an unknown date.
 */

import JSZip from 'jszip';
import { CONTAINER_EXTENSION } from './container.ts';

export interface DocumentSummary {
  /** Filename relative to the storage base, extension included. */
  readonly name: string;
  /** Human title from the container, or the filename stem when absent. */
  readonly title: string;
  /** Epoch milliseconds, or `null` when the container did not record one. */
  readonly updatedAt: number | null;
}

const PATH_FORMAT = 'format.json';

/** The title shown when a container records none: the filename without its extension. */
export function titleFromName(name: string): string {
  return name.replace(new RegExp(`\\${CONTAINER_EXTENSION}$`), '').replace(/[._]+/g, ' ').trim();
}

/**
 * Read a document's summary from its bytes.
 *
 * Returns a usable summary for anything that parses as a ZIP with a `format.json`, and
 * a filename-derived fallback otherwise. Throwing here would mean one damaged file in a
 * folder stopped the student opening any of the others, which is the opposite of what a
 * file list is for.
 */
export async function readSummary(name: string, bytes: Uint8Array): Promise<DocumentSummary> {
  const fallback: DocumentSummary = { name, title: titleFromName(name), updatedAt: null };

  try {
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file(PATH_FORMAT);
    if (!entry) return fallback;

    const parsed: unknown = JSON.parse(await entry.async('string'));
    if (typeof parsed !== 'object' || parsed === null) return fallback;

    const record = parsed as Record<string, unknown>;
    const title = typeof record.title === 'string' && record.title.length > 0 ? record.title : null;

    return { name, title: title ?? fallback.title, updatedAt: null };
  } catch {
    return fallback;
  }
}

/** Newest first, undated last, then by name so the order is stable. */
export function sortSummaries(summaries: readonly DocumentSummary[]): DocumentSummary[] {
  return [...summaries].sort((a, b) => {
    if (a.updatedAt === null && b.updatedAt !== null) return 1;
    if (a.updatedAt !== null && b.updatedAt === null) return -1;
    if (a.updatedAt !== b.updatedAt) return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    return a.title.localeCompare(b.title);
  });
}
