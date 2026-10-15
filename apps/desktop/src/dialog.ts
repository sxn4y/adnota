/**
 * Native file dialogs.
 *
 * Thin wrappers over the Tauri dialog plugin, kept in one place so the rest of the app
 * never imports the plugin directly. That matters because the browser harness cannot
 * load it — a stray import in shared code would break `pnpm dev:web` and every visual
 * test — and because the answer to "where does this path come from" should be auditable
 * from a single file.
 *
 * Every dialog returns `null` when the student cancels. Cancellation is not an error
 * and must never surface as one.
 */

import { open, save, type OpenDialogOptions } from '@tauri-apps/plugin-dialog';
import { CONTAINER_EXTENSION } from '@adnota/core';

const DOCUMENT_FILTERS = [
  { name: 'Adnota document', extensions: [CONTAINER_EXTENSION.replace(/^\./, '')] },
  { name: 'Markdown', extensions: ['md'] },
];

/**
 * Ask for a document to open.
 *
 * `directory: false` and no multi-select: the app opens one document at a time, and a
 * dialog that offers choices the app cannot honour is worse than one that does not offer
 * them.
 */
export async function chooseDocumentToOpen(): Promise<string | null> {
  const options: OpenDialogOptions = {
    multiple: false,
    directory: false,
    title: 'Open a document',
    filters: DOCUMENT_FILTERS,
  };

  const picked = await open(options);
  if (typeof picked === 'string') return picked;

  // `open` returns an array when `multiple` is set; handled anyway so a future change to
  // the options cannot turn a cancel into a crash.
  return Array.isArray(picked) ? (picked[0] ?? null) : null;
}

/**
 * Ask where to save a document.
 *
 * Returns the chosen path, or `null` if cancelled. The caller must decide whether a save
 * replaces the current document or exports a copy — that is a product decision, not a
 * dialog detail.
 */
export async function chooseDocumentToSave(suggestedName: string): Promise<string | null> {
  return save({
    title: 'Save a document',
    defaultPath: suggestedName,
    filters: [
      { name: 'Adnota document', extensions: [CONTAINER_EXTENSION.replace(/^\./, '')] },
    ],
  });
}

/** Ask where to export Markdown. */
export async function chooseMarkdownToExport(suggestedName: string): Promise<string | null> {
  return save({
    title: 'Export Markdown',
    defaultPath: suggestedName,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
}