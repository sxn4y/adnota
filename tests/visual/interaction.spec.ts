import { expect, test, type Page } from '@playwright/test';

/**
 * Interaction tests for the mindmap keyboard model.
 *
 * The keyboard model is the defining interaction of a mindmap and the easiest thing
 * to get subtly wrong. The failure modes that matter are not crashes but behaviours
 * that feel broken: Tab trapping focus so the app becomes keyboard-inaccessible,
 * Backspace destroying a label the student was about to finish, or Enter adding a
 * sibling when a line break was meant.
 *
 * These tests run against the real DOM in a real browser, because the behaviour under
 * test is a product of ProseMirror, React, and the SVG scene together. None of the
 * three is trustworthy in isolation.
 */

async function openHarness(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('scene')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Focus the canvas, which is what receives the structural keystrokes.
 *
 * Selecting a node already focuses it, so this is only needed when a test presses a
 * key without selecting first. It deliberately does not click: clicking the background
 * clears the selection, and clicking a node would select it, so either would change
 * what the test is actually asserting.
 */
async function focusCanvas(page: Page): Promise<void> {
  await page.getByTestId('canvas').focus();
}

/** Select a node by its visible text. */
async function selectNode(page: Page, text: string): Promise<string> {
  const node = page.locator('g[data-node-id]').filter({ hasText: text }).first();
  await node.click();
  const id = await node.getAttribute('data-node-id');
  expect(id).not.toBeNull();
  return id!;
}

async function nodeCount(page: Page): Promise<number> {
  return page.locator('g[data-node-id]').count();
}

async function branchCount(page: Page): Promise<number> {
  return page.locator('[data-testid="branches"] path').count();
}

test.describe('selection', () => {
  test('clicking a node selects it and marks it visually', async ({ page }) => {
    await openHarness(page);

    const id = await selectNode(page, 'Definite');

    await expect(page.locator(`g[data-node-id="${id}"]`)).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('g[data-node-id][data-selected]')).toHaveCount(1);
  });

  test('clicking the background clears the selection', async ({ page }) => {
    await openHarness(page);
    await selectNode(page, 'Definite');
    await expect(page.locator('g[data-node-id][data-selected]')).toHaveCount(1);

    await page.getByTestId('canvas').click({ position: { x: 6, y: 6 } });

    await expect(page.locator('g[data-node-id][data-selected]')).toHaveCount(0);
  });
});

test.describe('editing', () => {
  test('double-click opens the editor over the node', async ({ page }) => {
    await openHarness(page);

    await page.locator('g[data-node-id]').filter({ hasText: 'Definite' }).first().dblclick();

    const overlay = page.getByTestId('editor-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('[data-testid="node-editor"]')).toBeVisible();
  });

  test('hides the canvas copy of the node being edited', async ({ page }) => {
    // Two overlapping copies of the same text read as a rendering fault, and the
    // student cannot tell which one is live.
    await openHarness(page);
    await page.locator('g[data-node-id]').filter({ hasText: 'Definite' }).first().dblclick();

    const editing = page.locator('g[data-node-id].is-editing');
    await expect(editing).toHaveCount(1);
  });

  test('typing updates the node label', async ({ page }) => {
    await openHarness(page);
    await page.locator('g[data-node-id]').filter({ hasText: 'Definite' }).first().dblclick();

    const editor = page.getByTestId('node-editor');
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' integrals');

    // Commit by leaving the editor, then confirm the canvas carries the new text.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('editor-overlay')).toHaveCount(0);
    await expect(
      page.locator('g[data-node-id]').filter({ hasText: 'Definite integrals' }),
    ).toHaveCount(1);
  });

  test('types inline LaTeX into the editor', async ({ page }) => {
    await openHarness(page);
    await page.locator('g[data-node-id]').filter({ hasText: 'Improper' }).first().dblclick();

    const editor = page.getByTestId('node-editor');
    await editor.click();
    await page.keyboard.press('End');

    // Counted as a delta rather than an absolute: several sample labels already
    // contain a formula, so asserting "exactly one" would only pass for the nodes
    // that happen to start without maths.
    const before = await editor.locator('.katex').count();
    await page.keyboard.type(String.raw` $x^2$`);

    // The editor must show a rendered formula rather than the raw source.
    await expect(editor.locator('.katex')).toHaveCount(before + 1);
    await expect(editor.locator('.katex-error')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('editor-overlay')).toHaveCount(0);
  });

  test('Escape leaves the editor without changing the selection', async ({ page }) => {
    await openHarness(page);
    const id = await selectNode(page, 'Definite');
    await page.locator(`g[data-node-id="${id}"]`).dblclick();
    await expect(page.getByTestId('editor-overlay')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('editor-overlay')).toHaveCount(0);
    await expect(page.locator(`g[data-node-id="${id}"]`)).toHaveAttribute('data-selected', 'true');
  });
});

test.describe('keyboard model', () => {
  test('Tab adds a child and opens the editor', async ({ page }) => {
    await openHarness(page);
    const before = await nodeCount(page);

    await selectNode(page, 'Definite');
    await page.keyboard.press('Tab');

    await expect(page.getByTestId('editor-overlay')).toBeVisible();
    expect(await nodeCount(page)).toBe(before + 1);
  });

  test('Enter adds a sibling', async ({ page }) => {
    await openHarness(page);
    const before = await nodeCount(page);

    await selectNode(page, 'By parts');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('editor-overlay')).toBeVisible();
    expect(await nodeCount(page)).toBe(before + 1);
  });

  test('every new node carries a branch', async ({ page }) => {
    // A node with no branch is the classic half-finished mindmap, and it is the
    // invariant most likely to break when layout is refactored.
    await openHarness(page);
    await selectNode(page, 'Definite');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');

    expect(await branchCount(page)).toBe((await nodeCount(page)) - 1);
  });

  test('Shift+Tab outdents a node', async ({ page }) => {
    await openHarness(page);

    const child = await selectNode(page, 'By parts');
    const before = await page.locator(`g[data-node-id="${child}"]`).getAttribute('data-depth');

    await selectNode(page, 'By parts');
    await page.keyboard.press('Shift+Tab');

    const after = await page.locator(`g[data-node-id="${child}"]`).getAttribute('data-depth');
    expect(Number(after)).toBe(Number(before) - 1);
  });

  test('arrow keys walk the tree without moving focus', async ({ page }) => {
    await openHarness(page);

    await focusCanvas(page);
    const first = await selectNode(page, 'Improper');
    const beforeFocus = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));

    await page.keyboard.press('ArrowDown');
    const second = await page.locator('g[data-node-id][data-selected]').first().getAttribute('data-node-id');

    expect(second).not.toBe(first);
    // Focus must stay on the canvas, or the student cannot keep pressing arrows.
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(beforeFocus);
  });

  test('Space collapses and expands a branch', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Improper');
    const withChildren = await nodeCount(page);

    await page.keyboard.press(' ');

    expect(await nodeCount(page)).toBeLessThan(withChildren);
    await page.keyboard.press(' ');
    expect(await nodeCount(page)).toBe(withChildren);
  });

  test('Backspace removes an empty node but spares a node with text', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Definite');
    const before = await nodeCount(page);

    // Definite has a label, so the keystroke must do nothing rather than delete work.
    await page.keyboard.press('Backspace');
    expect(await nodeCount(page)).toBe(before);

    // An empty node is safe to delete.
    await selectNode(page, 'Definite');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    const afterAdd = await nodeCount(page);
    expect(afterAdd).toBe(before + 1);

    await page.keyboard.press('Backspace');
    expect(await nodeCount(page)).toBe(before);
  });

  test('Escape clears the selection', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Definite');
    await page.keyboard.press('Escape');

    await expect(page.locator('g[data-node-id][data-selected]')).toHaveCount(0);
  });
});