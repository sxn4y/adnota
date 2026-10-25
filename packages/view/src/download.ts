/**
 * File download.
 *
 * Kept in its own module so the export path can be tested without a real browser and
 * so the rest of the view never touches `document` directly.
 */

export interface DownloadResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Save text to a file via a temporary object URL.
 *
 * The anchor is removed before the click is dispatched rather than after: in Firefox
 * a lingering detached anchor occasionally leaks the download, and the URL is revoked
 * on the next frame because revoking it synchronously can cancel the download before
 * it has started.
 */
export function downloadText(filename: string, text: string, mime: string): DownloadResult {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { ok: false, error: 'Downloads are unavailable in this environment.' };
  }

  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  const cleanup = (): void => {
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoked on the next frame, not synchronously: revoking the URL before the
  // browser has read it cancels the download mid-flight.
  const timer = setTimeout(() => {
    clearTimeout(timer);
    cleanup();
  }, 0);

  return { ok: true };
}

/**
 * Turn a document title into a safe filename.
 *
 * Students type things like "Week 3: integrals (revision!)" and the platform will
 * reject or mangle several of those characters, so they are folded away rather than
 * passed through.
 *
 * The extension is a parameter because the same title has to become a `.md`, an `.svg` or a
 * `.adnota`, and deriving it twice in two places is how the two drift apart.
 */
export function toFilename(title: string, fallback = 'mindmap', extension = 'md'): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);

  return `${cleaned || fallback}.${extension}`;
}