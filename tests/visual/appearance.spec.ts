import { expect, test, type Page } from '@playwright/test';

/**
 * Node appearance: shape and colour.
 *
 * The model has carried `shape` and `color` since M0 and nothing read them, which is the
 * worst kind of half-built feature: the data is there, a future version might write to it,
 * and the renderer quietly ignores it. These tests pin that the two are now connected.
 *
 * The persistence check matters more than the rendering check. Appearance that draws but
 * does not survive a reload is a trick, and the document is the thing that is supposed to
 * be the truth.
 */

async function openHarness(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('scene')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function selectNode(page: Page, text: string) {
  const node = page.locator('g[data-node-id]').filter({ hasText: text }).first();
  await node.click();
  return node;
}

test.describe('node appearance', () => {
  test('the controls are disabled until a node is selected', async ({ page }) => {
    await openHarness(page);

    // Nothing is selected on load, so the controls exist but cannot act. They are present
    // rather than hidden, so their position does not move when a node is picked.
    await expect(page.getByTestId('style-color-green')).toBeDisabled();
    await expect(page.getByTestId('style-shape-pill')).toBeDisabled();
  });

  test('becomes usable once a node is selected', async ({ page }) => {
    await openHarness(page);
    await selectNode(page, 'Definite');

    await expect(page.getByTestId('style-color-green')).toBeEnabled();
  });

  test('applies a colour to the selected node and no other', async ({ page }) => {
    await openHarness(page);
    await selectNode(page, 'Definite');

    await page.getByTestId('style-color-green').click();

    const node = page.locator('g[data-node-id]').filter({ hasText: 'Definite' }).first();
    await expect(node).toHaveAttribute('data-color', 'green');

    // A sibling must be untouched. Styling the whole document is the failure this catches.
    const other = page.locator('g[data-node-id]').filter({ hasText: 'Improper' }).first();
    await expect(other).toHaveAttribute('data-color', 'neutral');
  });

  test('changes the fill that is actually painted', async ({ page }) => {
    await openHarness(page);
    await selectNode(page, 'Definite');
    await page.getByTestId('style-color-red').click();

    const fill = await page
      .locator('g[data-node-id]')
      .filter({ hasText: 'Definite' })
      .first()
      .locator('rect')
      .first()
      .getAttribute('fill');

    // The attribute rather than a class, because the colour is written as a presentation
    // attribute so that the SVG export carries it.
    expect(fill).toBe('#fdecec');
  });

  test('applies a shape', async ({ page }) => {
    await openHarness(page);
    await selectNode(page, 'Definite');
    await page.getByTestId('style-shape-pill').click();

    const node = page.locator('g[data-node-id]').filter({ hasText: 'Definite' }).first();
    await expect(node).toHaveAttribute('data-shape', 'pill');
  });

  test('pill rounds to half the height, box to a fixed corner', async ({ page }) => {
    await openHarness(page);
    await selectNode(page, 'Definite');

    const node = page.locator('g[data-node-id]').filter({ hasText: 'Definite' }).first();

    await page.getByTestId('style-shape-pill').click();
    const pill = Number(await node.locator('rect').first().getAttribute('rx'));
    const height = Number(await node.locator('rect').first().getAttribute('height'));
    expect(pill).toBeCloseTo(height / 2, 5);

    await page.getByTestId('style-shape-box').click();
    expect(Number(await node.locator('rect').first().getAttribute('rx'))).toBe(8);
  });

  test('the underline shape draws a rule and no box', async ({ page }) => {
    await openHarness(page);
    await selectNode(page, 'Definite');
    await page.getByTestId('style-shape-underline').click();

    const node = page.locator('g[data-node-id]').filter({ hasText: 'Definite' }).first();
    await expect(node.locator('rect')).toHaveCount(0);
    await expect(node.locator('line')).toHaveCount(1);
  });

  test('none draws neither a box nor a rule, and the label survives', async ({ page }) => {
    await openHarness(page);
    await selectNode(page, 'Definite');
    await page.getByTestId('style-shape-none').click();

    const node = page.locator('g[data-node-id]').filter({ hasText: 'Definite' }).first();
    await expect(node.locator('rect')).toHaveCount(0);
    await expect(node.locator('line')).toHaveCount(0);
    await expect(node).toContainText('Definite');
  });

  test('survives switching documents, because the document is the truth', async ({ page }) => {
    await openHarness(page);
    await selectNode(page, 'Definite');
    await page.getByTestId('style-color-violet').click();
    await page.getByTestId('style-shape-round').click();

    // Away and back again. The harness library is in memory, so a reload proves nothing;
    // switching documents proves the appearance lives in the document rather than in view
    // state, which is the distinction that matters.
    //
    // The row is found by its title, not its position: creating a document reorders the
    // list, so `first()` here would be the document we just made.
    //
    // Each toggle waits for the panel to reach the state it is toggling *from*. Clicking
    // a toggle blind against a panel that has not finished closing closes it a second
    // time instead of opening it, which is a race WebKit lost under parallel load while
    // Chromium and Gecko happened to win it.
    await page.getByTestId('open-documents').click();
    await expect(page.getByTestId('documents-panel')).toBeVisible();
    await page.getByTestId('documents-new').click();
    await expect(page.getByTestId('documents-panel')).toHaveCount(0);

    await page.getByTestId('open-documents').click();
    await expect(page.getByTestId('documents-panel')).toBeVisible();
    await page.getByTestId('documents-row').filter({ hasText: 'Integration' }).click();

    const def = page.locator('g[data-node-id]').filter({ hasText: 'Definite' }).first();
    await expect(def).toBeVisible();
    await expect(def).toHaveAttribute('data-color', 'violet');
  });

  test('the top node starts with ordinary appearance', async ({ page }) => {
    await openHarness(page);

    const top = page.locator('g[data-depth="0"]').first();

    // The sample builds its visible top node with `createNode`, so it is an ordinary box.
    // The synthetic root it hangs from is marked accent-and-pill in `createDoc` but is not
    // rendered, so what the student sees is deliberately plain.
    await expect(top).toHaveAttribute('data-color', 'neutral');
    await expect(top).toHaveAttribute('data-shape', 'box');
  });

  test('reaches the exported SVG', async ({ page }) => {
    await openHarness(page);
    await selectNode(page, 'Definite');
    await page.getByTestId('style-color-green').click();

    const download = page.waitForEvent('download');
    await page.getByTestId('export-svg').click();
    const stream = await (await download).createReadStream();

    const chunks: Buffer[] = [];
    for await (const chunk of stream ?? []) chunks.push(Buffer.from(chunk));
    const svg = Buffer.concat(chunks).toString('utf8');

    // The point of resolving palette slots to concrete hex: an exported file has to carry
    // the colour, not a name this build happens to know.
    expect(svg).toContain('#ecf7ee');
  });
});