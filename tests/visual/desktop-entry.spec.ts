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
 * So the desktop bundle is loaded here, with the Tauri IPC boundary replaced by a fake
 * disk. That is the one thing the harness cannot tell us: whether the app the student
 * actually launches mounts, or throws on its first statement.
 *
 * It is deliberately narrow. It does not try to re-test the storage commands — those
 * have their own Rust tests — only that the entry point runs, wires a library, renders the
 * scene, and round-trips a document through a real save and a real restart.
 */

/** The base every stubbed command resolves against. Any other base is a test bug. */
const STUB_BASE = 'C:/stub';

/**
 * A fake disk that lives in the Playwright process rather than in the page.
 *
 * The first version of this stub kept its files in a `Map` inside the init script, which
 * looked like a disk right up until a test reloaded the page. A reload tears down the
 * page's JavaScript heap, so the document the app had just saved ceased to exist — and the
 * test written to prove a document survives a restart could not have passed no matter what
 * the app did. Nothing inside the page outlives a navigation.
 *
 * Putting the files outside the page puts them on the same side of a host boundary the
 * real ones are on: the webview asks, the process answers. It also gives the test
 * somewhere to *look*, so a save can be waited for instead of guessed at with a sleep.
 */
interface FakeDisk {
  /**
   * Bytes served for `read_external`.
   *
   * Null models an absolute path that is not there, which the real command rejects. An
   * empty array models a file that exists and turns out not to be a document.
   */
  external: Uint8Array | null;

  /** Every path present, unsorted. */
  names(): string[];
  /** A copy of the bytes stored at `path`, or null when the file is absent. */
  read(path: string): number[] | null;
  write(path: string, bytes: number[]): void;
  remove(path: string): void;
  /** Last write in epoch milliseconds, or null when the file is absent. */
  modifiedAt(path: string): number | null;
}

function newDisk(external: Uint8Array | null = null): FakeDisk {
  const files = new Map<string, Uint8Array>();
  const stamps = new Map<string, number>();
  // A fixed epoch rather than the wall clock. A listing that ordered differently on every
  // run would make 'newest first' untestable, and a regression suite that cannot repeat
  // itself is one nobody believes when it fails.
  let clock = 1_700_000_000_000;

  return {
    external,
    names: () => [...files.keys()],
    read: (path) =>
      files.has(path) ? [...(files.get(path) as Uint8Array)] : null,
    write: (path, bytes) => {
      clock += 1000;
      files.set(path, Uint8Array.from(bytes));
      stamps.set(path, clock);
    },
    remove: (path) => {
      files.delete(path);
      stamps.delete(path);
    },
    modifiedAt: (path) => stamps.get(path) ?? null,
  };
}

/**
 * Answer one storage command, the way `src-tauri/src/storage.rs` would.
 *
 * The detail that matters most: a missing file is `Ok(None)`, which arrives in JavaScript
 * as `null`. A `Map.get` returns `undefined` for the same case, and `[...undefined]`
 * throws `bytes is not iterable` from inside `TauriStorage.read`.
 *
 * Nothing noticed for the whole life of the first stub, because the only read of a file
 * that might not exist was the pointer file — and `readPointer` swallows every error by
 * design. Reloading the page made `recallRecent()`, whose `localStorage` *does* survive a
 * navigation, name a document; the app went looking for it through a stub that claimed
 * missing files were errors, and the app reported a boot failure it had no way to cause.
 */
function serve(
  disk: FakeDisk,
  launchedWith: string | null,
  cmd: string,
  args: Record<string, unknown>,
): unknown {
  const path = String(args?.path ?? '');
  const base = String(args?.base ?? STUB_BASE);
  if (base !== STUB_BASE) throw new Error(`unexpected base: ${base}`);

  switch (cmd) {
    case 'default_base':
      return STUB_BASE;

    case 'opened_path':
      return launchedWith;

    case 'read':
      return disk.read(path);

    case 'write':
      disk.write(path, args?.bytes as number[]);
      return null;

    case 'remove':
      disk.remove(path);
      return null;

    case 'exists':
      return disk.read(path) !== null;

    case 'list': {
      const prefix = String(args?.prefix ?? '');
      return disk.names().filter((name) => name.startsWith(prefix));
    }

    case 'modified_at':
      return disk.modifiedAt(path);

    case 'read_external': {
      if (disk.external === null) throw new Error(`no such file: ${path}`);
      return [...disk.external];
    }

    case 'write_external':
      // Outside the library base, so deliberately not recorded. No test asserts on it,
      // and pretending otherwise would put a second fake in a suite that exists because
      // the first one lied.
      return null;

    default:
      throw new Error(`unstubbed Tauri command: ${cmd}`);
  }
}

/**
 * Replace Tauri's IPC with the fake disk.
 *
 * `window.__TAURI_INTERNALS__.invoke` is the single seam every Tauri command goes
 * through, so replacing it exercises the real `TauriStorage`, the real session logic and
 * the real app — only the disk is fake.
 *
 * `launchedWith` mimics a document handed over by the operating system, which is what a
 * double-clicked `.adnota` looks like to the app. Left null, this is an ordinary launch.
 */
async function stubTauri(
  page: Page,
  disk: FakeDisk,
  launchedWith: string | null = null,
): Promise<void> {
  // The disk lives here, in Node. Playwright re-installs the binding on every navigation,
  // so it is still answering after a reload, which is the entire point.
  await page.exposeBinding(
    '__adnotaFs',
    async (_source, cmd: string, args: Record<string, unknown>) =>
      serve(disk, launchedWith, cmd, args ?? {}),
  );

  await page.addInitScript(() => {
    const bridge = window as unknown as {
      __adnotaFs: (
        cmd: string,
        args: Record<string, unknown>,
      ) => Promise<unknown>;
    };

    const internals = {
      // Tauri's callback plumbing. Unused by this app, but `invoke` touches it when a
      // command is given an options object.
      transformCallback: (callback: unknown) => callback,
      unregisterCallback: () => undefined,
      convertFileSrc: (path: string) => path,

      async invoke(
        cmd: string,
        args: Record<string, unknown>,
      ): Promise<unknown> {
        // `listen` is how the frontend subscribes to open requests. The real handler
        // registry is not simulated — no test needs to fire an event — but the call
        // must succeed or startup would throw.
        if (cmd === 'plugin:event|listen') return 1;

        return bridge.__adnotaFs(cmd, args ?? {});
      },
    };

    (
      window as unknown as { __TAURI_INTERNALS__: typeof internals }
    ).__TAURI_INTERNALS__ = internals;
  });
}

/** Open the desktop bundle and wait for the scene, not merely for a window. */
async function openDesktop(
  page: Page,
  disk: FakeDisk,
  launchedWith: string | null = null,
): Promise<void> {
  await stubTauri(page, disk, launchedWith);

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
  test('mounts the app rather than showing the boot error', async ({
    page,
  }) => {
    await openDesktop(page, newDisk());

    await expect(page.locator('g[data-node-id]').first()).toBeVisible();
  });

  test('creates a starting document with a node the student can select', async ({
    page,
  }) => {
    await openDesktop(page, newDisk());

    // Every action in the app needs a selected node, so a document that starts with
    // none is a dead end.
    await expect(page.locator('g[data-node-id]')).toHaveCount(1);
  });

  test('shows the save indicator, which only a session provides', async ({
    page,
  }) => {
    await openDesktop(page, newDisk());

    // The browser harness has no session and therefore no save status. Its presence
    // proves the desktop wiring is live.
    await expect(page.getByTestId('save-status')).toContainText('.adnota');
  });

  test('offers the Documents panel, wired to the library', async ({ page }) => {
    await openDesktop(page, newDisk());

    await page.getByTestId('open-documents').click();
    await expect(page.getByTestId('documents-panel')).toBeVisible();

    // Empty, correctly: a first launch creates a document in memory and does not write
    // it until there is something to save, so there is genuinely nothing to list yet.
    // What this proves is that the panel is reachable and talking to a real library —
    // the browser harness's button is absent, because it has no library at all.
    await expect(page.getByTestId('documents-panel')).toContainText(
      'No documents yet',
    );
    await expect(page.getByTestId('documents-new')).toBeVisible();
  });

  test('creates a document that the library then lists', async ({ page }) => {
    await openDesktop(page, newDisk());
    await page.getByTestId('open-documents').click();
    await expect(page.getByTestId('documents-panel')).toBeVisible();

    await page.getByTestId('documents-new').click();

    // Creating writes the file immediately rather than leaving it to the first autosave,
    // so the name the student chose is on disk even if they close straight away.
    await expect(page.getByTestId('save-status')).toContainText('.adnota');

    // Creating also closes the panel. Reopening is a toggle, so it is clicked only once
    // the panel is confirmed closed — otherwise it closes it again instead.
    await expect(page.getByTestId('documents-panel')).toHaveCount(0);
    await page.getByTestId('open-documents').click();
    await expect(page.getByTestId('documents-panel')).toBeVisible();
    await expect(page.getByTestId('documents-row')).toHaveCount(1);
  });

  test('opens the documented node for editing', async ({ page }) => {
    await openDesktop(page, newDisk());

    // The whole point of loading the desktop bundle: this is the path that was broken.
    const node = page.locator('g[data-node-id]').first();
    await node.dblclick();

    await expect(page.getByTestId('node-editor')).toBeVisible();
  });

  test('keeps a node appearance across a real reload of a real file', async ({
    page,
  }) => {
    const disk = newDisk();
    await openDesktop(page, disk);

    // Appearance that draws but does not survive a restart is a trick. The harness's
    // in-memory library cannot show this, because it forgets everything on reload by
    // design; here the bytes really are written, really are kept, and really are read
    // back by a second boot of the app.
    const node = page.locator('g[data-node-id]').first();
    await node.click();

    // What is on disk at this instant. Autosave writes within its debounce, so waiting
    // for the file to change is a condition rather than a guess about timing — the first
    // version slept for three seconds and hoped.
    const before = disk.read('Untitled.adnota');

    await page.getByTestId('style-color-amber').click();
    await page.getByTestId('style-shape-pill').click();
    await expect(node).toHaveAttribute('data-color', 'amber');

    await expect
      .poll(() => disk.read('Untitled.adnota'), { timeout: 15_000 })
      .not.toEqual(before);

    await page.reload();

    // The desktop bundle is served by a dev server, so the reload recompiles it. Five
    // seconds is the default expect timeout and is not enough for a cold module graph.
    await expect(page.getByTestId('scene')).toBeVisible({ timeout: 30_000 });

    const reopened = page.locator('g[data-node-id]').first();
    await expect(reopened).toHaveAttribute('data-color', 'amber');
    await expect(reopened).toHaveAttribute('data-shape', 'pill');
  });

  test('starts again when the remembered document is no longer there', async ({
    page,
  }) => {
    // The first launch remembers `Untitled.adnota` and writes the pointer file beside it,
    // but a document nobody has edited is never written — so the library holds a name and
    // not the file behind it. That is the ordinary state of a student who tidied up their
    // folder, and it must cost them a fresh document rather than a window that will not
    // open.
    //
    // Left to arise by itself rather than arranged by deleting the file mid-flight, which
    // would race the autosave heartbeat that writes it straight back.
    await openDesktop(page, newDisk());
    await page.reload();

    await expect(page.locator('.adnota-boot-error')).toHaveCount(0);
    await expect(page.locator('g[data-node-id]')).toHaveCount(1);
  });

  /**
   * A minimal but valid container, so the import path is exercised for real.
   *
   * Built by importing core's source directly rather than by hand-rolling bytes: a
   * hand-made zip that the reader happens to accept would not prove that a real document
   * survives the round trip, which is the whole point of the test.
   */
  async function aDocumentLabelled(label: string): Promise<Uint8Array> {
    const { buildDocument, createDoc, createNode, ROOT_NODE_ID } =
      await import('../../packages/core/src/index.ts');

    const doc = createDoc(label);
    // The root node already exists in a new document; adding a child is what makes the
    // imported file look like real notes rather than an empty shell.
    createNode(doc, {
      parentId: ROOT_NODE_ID,
      label: [{ type: 'text', text: label }],
    });

    const { bytes } = await buildDocument(doc, new Map());
    return bytes;
  }

  test.describe('opened from the file manager', () => {
    test('opens the requested document instead of a blank one', async ({
      page,
    }) => {
      await openDesktop(
        page,
        newDisk(await aDocumentLabelled('Linear algebra')),
        'D:/Elsewhere/Linear algebra.adnota',
      );

      // The failure this guards against is subtle: the app starts perfectly either way,
      // because a blank document is a perfectly good document. What matters is that the
      // *requested* one is what appears, and that it arrived under a name of its own.
      await expect(page.getByTestId('save-status')).toContainText(
        'Linear algebra',
      );
    });

    test('imports it into the library rather than editing the original in place', async ({
      page,
    }) => {
      await openDesktop(
        page,
        newDisk(await aDocumentLabelled('Linear algebra')),
        'D:/Elsewhere/Linear algebra.adnota',
      );

      await page.getByTestId('open-documents').click();

      // Adnota owns the file it edits, so an external document is copied in. The copy
      // keeps the original's name; the student can rename it like any other. The row
      // is labelled by title rather than filename, as it is everywhere else in the app.
      await expect(page.getByTestId('documents-row')).toHaveCount(1);
      await expect(page.getByTestId('documents-panel')).toContainText(
        'Linear algebra',
      );
    });

    test('falls back to a usable window when the requested file is gone', async ({
      page,
    }) => {
      // Zero bytes, which is a file that exists and is not a container.
      await openDesktop(
        page,
        newDisk(new Uint8Array()),
        'D:/Elsewhere/Deleted.adnota',
      );

      // A stale file association must never leave a student staring at a blank app or an
      // error page. They get a working document and can open another from the panel.
      await expect(page.locator('.adnota-boot-error')).toHaveCount(0);
      await expect(page.locator('g[data-node-id]')).toHaveCount(1);
    });

    test('shows no Open / Save As buttons when there is no dialog, as before', async ({
      page,
    }) => {
      await openDesktop(
        page,
        newDisk(await aDocumentLabelled('Linear algebra')),
        'D:/Elsewhere/Linear algebra.adnota',
      );

      // Guards against the desktop app losing its native dialogs during this change: the
      // buttons exist only where a real dialog can answer them.
      await expect(page.getByTestId('documents-open')).toHaveCount(0);
      await expect(page.getByTestId('documents-save-as')).toHaveCount(0);
    });
  });
});
