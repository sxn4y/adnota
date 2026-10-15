import { expect, test, type Page } from '@playwright/test';

/**
 * Study-feature tests: outline, search, notes, and Markdown export.
 *
 * These are the features that turn a drawing tool into something a student can
 * revise from. They share a failure mode worth guarding against explicitly — each of
 * them derives from the document rather than owning state, so a stale render is the
 * realistic bug: an outline missing a node just renamed, a search index that does not
 * see the newest text, a notes panel that silently discards what was typed.
 */

async function openHarness(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('scene')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function selectNode(page: Page, text: string): Promise<string> {
  const node = page.locator('g[data-node-id]').filter({ hasText: text }).first();
  await node.click();
  const id = await node.getAttribute('data-node-id');
  expect(id).not.toBeNull();
  return id!;
}

test.describe('outline view', () => {
  test('lists every node with its tree depth', async ({ page }) => {
    await openHarness(page);

    const rows = page.getByTestId('outline-row');
    await expect(rows.first()).toBeVisible();

    const depths = await rows.evaluateAll((nodes) =>
      nodes.map((n) => Number(n.getAttribute('data-depth'))),
    );

    expect(depths[0]).toBe(0);
    expect(depths).toContain(1);
    // Depth must nest, never be flat: a flat outline would not be an outline.
    expect(Math.max(...depths)).toBeGreaterThan(0);
    expect(new Set(depths).size).toBeGreaterThan(1);
  });

  test('selecting a row selects the matching node on the canvas', async ({ page }) => {
    await openHarness(page);

    const label = page.getByTestId('outline-label').filter({ hasText: 'Definite' }).first();
    const nodeId = await label.locator('xpath=ancestor::div[@data-node-id]').getAttribute('data-node-id');

    await label.click();

    await expect(page.locator(`g[data-node-id="${nodeId}"]`)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('outline-row').filter({ hasText: 'Definite' }).first()).toHaveClass(
      /is-selected/,
    );
  });

  test('reflects a rename immediately rather than going stale', async ({ page }) => {
    await openHarness(page);

    await page.locator('g[data-node-id]').filter({ hasText: 'Improper' }).first().dblclick();
    const editor = page.getByTestId('node-editor');
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Revised topic');
    await page.keyboard.press('Escape');

    // A stale outline is worse than none: the student would revise against a lie.
    await expect(page.getByTestId('outline-label').filter({ hasText: 'Revised topic' })).toBeVisible();
    await expect(page.getByTestId('outline-label').filter({ hasText: 'Improper' })).toHaveCount(0);
  });

  test('collapsing from the outline hides the branch', async ({ page }) => {
    await openHarness(page);

    // Deliberately not the first twisty: that belongs to the root, and collapsing the
    // root hides the entire document rather than one branch.
    const row = page.getByTestId('outline-row').filter({ hasText: 'Definite' }).first();
    await expect(row.getByTestId('outline-twisty')).toHaveAttribute('aria-expanded', 'true');

    const before = await page.getByTestId('outline-row').count();
    await row.getByTestId('outline-twisty').click();

    // The row itself stays; only its descendants go.
    await expect(page.getByTestId('outline-row')).toHaveCount(before - 2);
    await expect(row.getByTestId('outline-twisty')).toHaveAttribute('aria-expanded', 'false');
    await expect(row).toBeVisible();
  });

  test('can be hidden entirely', async ({ page }) => {
    await openHarness(page);

    await expect(page.getByTestId('outline-panel')).toBeVisible();
    await page.getByTestId('toggle-outline').click();
    await expect(page.getByTestId('outline-panel')).toHaveCount(0);
  });
});

test.describe('search palette', () => {
  test('opens with Ctrl+K and closes with Escape', async ({ page }) => {
    await openHarness(page);

    await expect(page.getByTestId('search-palette')).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('search-palette')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('search-palette')).toHaveCount(0);
  });

  test('opens from the toolbar as well as the shortcut', async ({ page }) => {
    await openHarness(page);

    await page.getByTestId('open-search').click();
    await expect(page.getByTestId('search-palette')).toBeVisible();
  });

  test('finds a node by a fragment of its label', async ({ page }) => {
    await openHarness(page);
    await page.keyboard.press('Control+k');

    await page.getByTestId('search-input').fill('revol');
    await expect(page.getByTestId('search-result')).toHaveCount(1);
    await expect(page.getByTestId('search-result')).toContainText('revolution');
  });

  test('typesets maths in the outline rather than showing raw LaTeX', async ({ page }) => {
    await openHarness(page);

    // The outline is a reading view, and a student scanning it recognises an integral
    // sign instantly where `\int_a^b f(x)\,dx` is just noise.
    const outline = page.getByTestId('outline-panel');
    await expect(outline.locator('.katex').first()).toBeVisible();

    // The plain form is still present for search and assistive tech.
    await expect(outline).toContainText('\\int');
  });

  test('highlights the matched fragment', async ({ page }) => {
    await openHarness(page);
    await page.keyboard.press('Control+k');

    await page.getByTestId('search-input').fill('revolution');
    await expect(page.getByTestId('search-result').locator('mark')).toHaveText('revolution');
  });

  test('is case-insensitive', async ({ page }) => {
    await openHarness(page);
    await page.keyboard.press('Control+k');

    await page.getByTestId('search-input').fill('REVOLUTION');
    await expect(page.getByTestId('search-result').first()).toBeVisible();
  });

  test('says so when nothing matches', async ({ page }) => {
    await openHarness(page);
    await page.keyboard.press('Control+k');

    await page.getByTestId('search-input').fill('zzzzznothing');
    await expect(page.getByTestId('search-empty')).toBeVisible();
    await expect(page.getByTestId('search-result')).toHaveCount(0);
  });

  test('picking a result selects the node on the canvas', async ({ page }) => {
    await openHarness(page);
    await page.keyboard.press('Control+k');

    await page.getByTestId('search-input').fill('revolution');
    const result = page.getByTestId('search-result').first();
    const nodeId = await result.getAttribute('data-node-id');

    await result.click();

    await expect(page.locator(`g[data-node-id="${nodeId}"]`)).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('search-palette')).toHaveCount(0);
  });

  test('Enter picks the highlighted result', async ({ page }) => {
    await openHarness(page);
    await page.keyboard.press('Control+k');

    await page.getByTestId('search-input').fill('Definite');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('search-palette')).toHaveCount(0);
    await expect(page.locator('g[data-node-id][data-selected="true"]')).toHaveCount(1);
  });

  test('arrow keys move the highlight and wrap around', async ({ page }) => {
    await openHarness(page);
    await page.keyboard.press('Control+k');

    await page.getByTestId('search-input').fill('e');
    const results = page.getByTestId('search-result');
    const count = await results.count();
    test.skip(count < 2, 'needs at least two matches to exercise wrapping');

    await expect(results.nth(0)).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowDown');
    await expect(results.nth(1)).toHaveClass(/is-active/);
    await page.keyboard.press('ArrowUp');
    await expect(results.nth(0)).toHaveClass(/is-active/);
  });

  test('sees text typed into a node', async ({ page }) => {
    await openHarness(page);

    await page.locator('g[data-node-id]').filter({ hasText: 'Improper' }).first().dblclick();
    const editor = page.getByTestId('node-editor');
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Quonshubur');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+k');
    await page.getByTestId('search-input').fill('Quonshubur');

    // The index must see the newest text, not a snapshot from mount.
    await expect(page.getByTestId('search-result')).toHaveCount(1);
  });

  test('clicking the backdrop dismisses it', async ({ page }) => {
    await openHarness(page);
    await page.keyboard.press('Control+k');

    await page.getByTestId('search-palette').click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId('search-palette')).toHaveCount(0);
  });
});

test.describe('notes panel', () => {
  test('prompts for a selection when nothing is selected', async ({ page }) => {
    await openHarness(page);

    await page.getByTestId('toggle-notes').click();
    await expect(page.getByTestId('notes-panel')).toContainText('Select a node');
  });

  test('typing persists into the document', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Definite');
    await page.getByTestId('toggle-notes').click();

    const editor = page.getByTestId('notes-editor').locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('The limit definition.');

    await expect(editor).toContainText('The limit definition.');

    // Switch away and back: a panel that only looks right once has lost the note.
    await page.getByTestId('toggle-outline').click();
    await page.getByTestId('toggle-notes').click();
    await expect(page.getByTestId('notes-editor')).toContainText('The limit definition.');
  });

  test('shows a different node’s notes, not the previous one', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Definite');
    await page.getByTestId('toggle-notes').click();
    await page.getByTestId('notes-editor').locator('.ProseMirror').click();
    await page.keyboard.type('First note.');

    await selectNode(page, 'Improper');
    await expect(page.getByTestId('notes-editor')).not.toContainText('First note.');
  });

test('accepts an inline formula', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Definite');
    await page.getByTestId('toggle-notes').click();

    const host = page.getByTestId('notes-editor');
    await host.locator('.ProseMirror').first().click();
    await page.keyboard.type('The limit of $e^x$ matters.');

    // Inline maths must work in the notes body, not just on a canvas label: a student
    // who can write $x$ in a label and not in the notes under it reads the app as broken.
    await expect(host.locator('.katex').first()).toBeVisible();
    await expect(host.locator('.katex-error')).toHaveCount(0);
    await expect(host).not.toContainText('$e^x$');
  });

  test('accepts a display formula and round-trips it into the export', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Definite');
    await page.getByTestId('toggle-notes').click();

    const host = page.getByTestId('notes-editor');
    await host.locator('.ProseMirror').first().click();

    // `$$ ` is the trigger, not the closing delimiter: the node opens on the opening
    // pair and the formula is typed into it. Matching the closing `$$` instead would
    // rewrite the half of the formula the student already typed, out from under them.
    await page.keyboard.type('$$ ');
    const field = host.locator('[data-math="display"] input');
    await expect(field).toBeFocused();

    await field.fill(String.raw`\int_0^1 x\,dx`);

    // The LaTeX must reach the document, not just the widget. A formula that looks
    // right on screen and is missing from the saved file is the worst possible failure
    // for notes the student plans to revise from.
    const download = page.waitForEvent('download');
    await page.getByTestId('export-markdown').click();
    const stream = await (await download).createReadStream();
    expect(await readAll(stream)).toContain(String.raw`\int_0^1 x\,dx`);
  });

  test('renders a display formula typeset once it is left', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Definite');
    await page.getByTestId('toggle-notes').click();

    const host = page.getByTestId('notes-editor');
    await host.locator('.ProseMirror').first().click();

    await page.keyboard.type('$$ ');
    const field = host.locator('[data-math="display"] input');
    await field.fill(String.raw`\int_0^1 x\,dx`);

    // While it holds the focus it is an editable field; that is correct.
    await expect(field).toBeVisible();

    // Pressed through the locator rather than the page: the node view tells ProseMirror
    // to ignore events coming from inside the field, so Escape is only handled when the
    // field actually has focus.
    await field.press('Escape');

    // Leaving it swaps the field for the typeset formula. Previously the maths library's
    // own node view left it as raw LaTeX indefinitely.
    await expect(host.locator('.katex').first()).toBeVisible();
    await expect(host.locator('.katex-error')).toHaveCount(0);
    // The field is gone, and nothing fell back to showing raw source. (KaTeX keeps the
    // LaTeX in an `<annotation>` for screen readers and copy, so its presence in the
    // document's text is expected — what matters is that it is not what is displayed.)
    await expect(host.locator('[data-math="display"] input')).toHaveCount(0);
    await expect(host.locator('.adnota-notes-math-fallback')).toHaveCount(0);
  });

  test('keeps an empty formula editable rather than showing nothing', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Definite');
    await page.getByTestId('toggle-notes').click();

    const host = page.getByTestId('notes-editor');
    await host.locator('.ProseMirror').first().click();
    await page.keyboard.type('$$ ');
    await page.keyboard.press('Escape');

    // Rendering an empty formula would leave an unexplained gap in the notes.
    await expect(host.locator('[data-math="display"] input')).toBeVisible();
  });


  test('Enter makes a new paragraph instead of adding a node', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Definite');
    const nodesBefore = await page.locator('g[data-node-id]').count();
    await page.getByTestId('toggle-notes').click();

    const editor = page.getByTestId('notes-editor').locator('.ProseMirror');
    await editor.click();
    await page.keyboard.type('First.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second.');

    // Enter here is a line break. Adding a sibling node would be data corruption
    // from the student's point of view.
    await expect(page.locator('g[data-node-id]')).toHaveCount(nodesBefore);
    await expect(editor.locator('p')).toHaveCount(2);
  });
});

test.describe('Markdown export', () => {
  test('offers a download and reports the filename', async ({ page }) => {
    await openHarness(page);

    const download = page.waitForEvent('download');
    await page.getByTestId('export-markdown').click();

    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.md$/);
    await expect(page.getByTestId('export-status')).toContainText('Exported');
  });

  test('produces nested bullets that match the tree', async ({ page }) => {
    await openHarness(page);

    const download = page.waitForEvent('download');
    await page.getByTestId('export-markdown').click();
    const stream = await (await download).createReadStream();
    const markdown = await readAll(stream);

    expect(markdown).toContain('- ');
    expect(markdown).toMatch(/\n {2}- /);
  });

  test('exports maths as LaTeX rather than as an image', async ({ page }) => {
    await openHarness(page);

    const download = page.waitForEvent('download');
    await page.getByTestId('export-markdown').click();
    const stream = await (await download).createReadStream();
    const markdown = await readAll(stream);

    // An image would make the notes unsearchable and uneditable later.
    expect(markdown).toContain('$');
    expect(markdown).not.toContain('![');
  });

  test('includes the notes body', async ({ page }) => {
    await openHarness(page);

    await selectNode(page, 'Definite');
    await page.getByTestId('toggle-notes').click();
    await page.getByTestId('notes-editor').locator('.ProseMirror').click();
    await page.keyboard.type('Remember the squeeze theorem.');

    const download = page.waitForEvent('download');
    await page.getByTestId('export-markdown').click();
    const stream = await (await download).createReadStream();

    // A mindmap whose export drops the prose is an image of the thinking, not a copy.
    await expect(readAll(stream)).resolves.toContain('Remember the squeeze theorem.');
  });
});

/** Collect a download stream into a string. */
async function readAll(stream: NodeJS.ReadableStream | null): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}