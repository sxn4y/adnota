import { expect, test, type Page } from '@playwright/test';

/**
 * The desktop entry point, loaded for real.
 *
 * This file exists because of a specific failure. `apps/desktop/src/main.tsx` shipped
 * with four undeclared symbols; the window opened and immediately showed "Adnota could
 * not open your notes", and nothing caught it — not `pnpm typecheck` (the package was
 * absent from the root `tsconfig.json` references), not the bundler (unimported values
 * used only as types are not build errors), and not the tests, because every one of them
 * ran against the browser harness.
 *
 * So the desktop bundle is loaded here, with the Tauri IPC boundary replaced by an
 * in-memory filesystem. That is the one thing the harness cannot tell us: whether the
 * app the student actually launches mounts, or throws on its first statement.
 *
 * It is deliberately narrow. It does not try to re-test the storage commands — those
 * have their own Rust tests — only that the entry point runs, wires a library, and
 * renders the scene.
 */

/**
 * Replace Tauri's IPC with an in-memory filesystem.
 *
 * `window.__TAURI_INTERNALS__.invoke` is the single seam every Tauri command goes
 * through, so stubbing it exercises the real `TauriStorage`, the real session logic and
 * the real app — only the disk is fake.
 */
async function stubTauri(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const files = new Map<string, Uint8Array>();
    const BASE = 'C:/stub';

    const internals = {
      // Tauri's callback plumbing. Unused by this app, but `invoke` touches it when a
      // command is given an options object.
      transformCallback: (callback: unknown) => callback,
      unregisterCallback: () => undefined,
      convertFileSrc: (path: string) => path,

      async invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
        const path = String(args?.path ?? '');
        const base = String(args?.base ?? BASE);
        if (base !== BASE) throw new Error(`unexpected base: ${base}`);

        switch (cmd) {
          case 'default_base':
            return BASE;

          case 'read': {
            const bytes = files.get(path);
            return bytes === null ? null : [...bytes];
          }

          case 'write': {
            const bytes = args?.bytes;
            files.set(path, Uint8Array.from(bytes as number[]));
            return null;
          }

          case 'remove':
            files.delete(path);
            return null;

          case 'exists':
            return files.has(path);

          case 'list':
            return [...files.keys()].filter((name) => name.startsWith(String(args?.prefix ?? '')));

          case 'modified_at':
            // A fixed, monotonically increasing stamp so listings order stably.
            return files.has(path) ? 1_700_000_000_000 : null;

          default:
            throw new Error(`unstubbed Tauri command: ${cmd}`);
        }
      },
    };

    (window as unknown as { __TAURI_INTERNALS__: typeof internals }).__TAURI_INTERNALS__ = internals;
  });
}

/** Open the desktop bundle and wait for the scene, not merely for a window. */
async function openDesktop(page: Page): Promise<void> {
  await stubTauri(page);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');

  // The scene appearing is the assertion that matters. Checking that the page loaded
  // would pass while the app rendered nothing but an error panel.
  await expect(page.getByTestId('scene')).toBeVisible();
  await expect(page.locator('.adnota-boot-error')).toHaveCount(0);
  expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
}

test.describe('desktop entry', () => {
  test('mounts the app rather than showing the boot error', async ({ page }) => {
    await openDesktop(page);

    await expect(page.locator('g[data-node-id]').first()).toBeVisible();
  });

  test('creates a starting document with a node the student can select', async ({ page }) => {
    await openDesktop(page);

    // Every action in the app needs a selected node, so a document that starts with
    // none is a dead end.
    await expect(page.locator('g[data-node-id]')).toHaveCount(1);
  });

  test('shows the save indicator, which only a session provides', async ({ page }) => {
    await openDesktop(page);

    // The browser harness has no session and therefore no save status. Its presence
    // proves the desktop wiring is live.
    await expect(page.getByTestId('save-status')).toContainText('.adnota');
  });

  test('offers the Documents panel, wired to the library', async ({ page }) => {
    await openDesktop(page);

    await page.getByTestId('open-documents').click();
    await expect(page.getByTestId('documents-panel')).toBeVisible();

    // Empty, correctly: a first launch creates a document in memory and does not write
    // it until there is something to save, so there is genuinely nothing to list yet.
    // What this proves is that the panel is reachable and talking to a real library —
    // the browser harness's button is absent, because it has no library at all.
    await expect(page.getByTestId('documents-panel')).toContainText('No documents yet');
    await expect(page.getByTestId('documents-new')).toBeVisible();
  });

  test('creates a document that the library then lists', async ({ page }) => {
    await openDesktop(page);
    await page.getByTestId('open-documents').click();

    await page.getByTestId('documents-new').click();

    // Creating writes the file immediately rather than leaving it to the first autosave,
    // so the name the student chose is on disk even if they close straight away.
    await expect(page.getByTestId('save-status')).toContainText('.adnota');
    await page.getByTestId('open-documents').click();
    await expect(page.getByTestId('documents-row')).toHaveCount(1);
  });

  test('opens the documented node for editing', async ({ page }) => {
    await openDesktop(page);

    // The whole point of loading the desktop bundle: this is the path that was broken.
    const node = page.locator('g[data-node-id]').first();
    await node.dblclick();

    await expect(page.getByTestId('node-editor')).toBeVisible();
  });
});