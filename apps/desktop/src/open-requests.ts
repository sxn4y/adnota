/**
 * "Open this document" requests that come from outside the app.
 *
 * These are the only two ways a file reaches Adnota without the student picking it in a
 * dialog: the argument the operating system supplied at launch, and a second launch while
 * the app is already running. Both end up here so the rest of the app has one entry point
 * for them, rather than two.
 *
 * Worth being clear about what this is *not*. The single-instance plugin is not a security
 * boundary. Anything that can run `adnota.exe C:\whatever.adnota` gets that file opened,
 * and the read is still subject to the same extension allowlist and size ceiling as the
 * dialog path. What the plugin does buy is correctness: a second launch hands over and
 * exits instead of starting a rival instance that would autosave over the first one's work.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { openedAtLaunch } from './storage.ts';

/**
 * Event name, matching `OPEN_EVENT` in `src-tauri/src/lib.rs`.
 *
 * Duplicated rather than shared because it crosses the Rust/TypeScript boundary, and a
 * codegen step for one string constant is more machinery than the constant is worth. The
 * Rust test for that constant, and the desktop-bundle test here, are what catch a drift.
 */
export const OPEN_EVENT = 'adnota://open-document';

export { openedAtLaunch };

/**
 * Deliver later open requests to `handler`.
 *
 * Resolves to an unsubscribe function. Registration is deliberately not awaited by the
 * caller during startup: `listen` completes asynchronously, and making boot wait on it
 * would delay the first paint for no benefit.
 */
export async function onOpenRequest(handler: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>(OPEN_EVENT, (event) => handler(event.payload));
}