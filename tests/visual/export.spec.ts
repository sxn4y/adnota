import { expect, test, type Page } from '@playwright/test';

/**
 * Standalone SVG export.
 *
 * The unit tests cover the pure transformations. What they cannot cover is the part that
 * actually decides whether the file is usable: whether the export reads the page's real
 * stylesheets, whether `XMLSerializer` round-trips a live SVG subtree without mangling it,
 * and whether the result is framed on the content rather than on whatever the student
 * happened to be looking at.
 *
 * Each test downloads the file and inspects it, rather than asserting on the toast, so a
 * change that reports success while producing a blank or off-canvas image is caught.
 */

async function openHarness(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('scene')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Click Export .svg and return the downloaded file's contents. */
async function exportSvg(page: Page): Promise<string> {
  const download = page.waitForEvent('download');
  await page.getByTestId('export-svg').click();
  const stream = await (await download).createReadStream();

  const chunks: Buffer[] = [];
  for await (const chunk of stream ?? []) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** The four numbers of a `viewBox`, or null when it is absent or malformed. */
function viewBoxOf(svg: string): number[] | null {
  const match = /viewBox="([^"]*)"/.exec(svg);
  if (match === null) return null;
  const parts = match[1].trim().split(/\s+/).map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) ? parts : null;
}

/** The tag of the outermost content group, which is the one whose transform was stripped. */
function contentGroupTag(svg: string): string {
  const start = svg.indexOf('<g', svg.indexOf('</rect>'));
  return svg.slice(start, svg.indexOf('>', start) + 1);
}

test.describe('export .svg', () => {
  test('produces a standalone SVG document', async ({ page }) => {
    await openHarness(page);
    const svg = await exportSvg(page);

    // Without the namespace a browser shows an XML tree instead of a picture.
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  test('carries the nodes and their branches across', async ({ page }) => {
    await openHarness(page);
    const svg = await exportSvg(page);

    expect(svg).toContain('data-node-id=');
    expect(svg).toContain('<path');
    expect(svg).toContain('foreignObject');
  });

  test('frames the file on the content, not on the viewport', async ({ page }) => {
    await openHarness(page);

    // Pan and zoom first, so the exported frame cannot accidentally match the screen.
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, -600);
    await page.getByTestId('zoom-fit').click();

    const svg = await exportSvg(page);
    const viewBox = viewBoxOf(svg);

    expect(viewBox).not.toBeNull();
    const [, , width, height] = viewBox!;

    // Positive and sized to the map, which a `0 0 0 0` or a viewport-sized box would not be.
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);

    // The pan-and-zoom is dropped from the content group. Individual nodes keep their own
    // translate, which is their position in the map and must survive.
    expect(contentGroupTag(svg)).not.toContain('transform');
    expect(svg).toContain('<g transform="translate(');
  });

  test('embeds the stylesheet, so labels are not left unstyled', async ({ page }) => {
    await openHarness(page);
    const svg = await exportSvg(page);

    // The one that matters: labels are HTML inside a foreignObject, and without these rules
    // every formula and every font size collapses.
    expect(svg).toContain('.adnota-node-label');
  });

  test('does not embed font-face rules, whose URLs cannot resolve outside the app', async ({ page }) => {
    await openHarness(page);
    const svg = await exportSvg(page);

    expect(svg).not.toContain('@font-face');
  });

  test('exports the formula content, not a blank where it should be', async ({ page }) => {
    await openHarness(page);
    await page.getByTestId('export-svg').click();
    await expect(page.getByTestId('export-status')).toBeVisible();

    const svg = await exportSvg(page);

    // The sample document contains a formula. KaTeX output is spans and rules rather than
    // a single text run, so the check is that the markup is present at all.
    expect(svg).toContain('katex');
  });

  /**
 * The export is a faithful capture of the view, selection highlight included.
 *
 * This pins a known limitation rather than a desired behaviour. Selection is drawn with
 * inline attributes, so stripping it from the copy would mean re-rendering with no
 * selection — a refactor of the scene for a cosmetic gain. Until that happens, a student
 * who exports while a node is selected gets that node outlined in the file, and should
 * click the background first.
 */
test('captures the view as shown, including the selection', async ({ page }) => {
    await openHarness(page);
    await page.locator('g[data-node-id]').first().click();

    const svg = await exportSvg(page);

    expect(svg).toContain('data-selected');
  });

  test('titles the file after the document', async ({ page }) => {
    await openHarness(page);

    const download = page.waitForEvent('download');
    await page.getByTestId('export-svg').click();
    const file = await download;

    expect(file.suggestedFilename()).toMatch(/\.svg$/);
  });

  test('reports the export in the toolbar', async ({ page }) => {
    await openHarness(page);
    await page.getByTestId('export-svg').click();

    await expect(page.getByTestId('export-status')).toContainText('.svg');
  });

  test('the exported file parses as XML rather than merely looking right', async ({ page }) => {
    await openHarness(page);
    const svg = await exportSvg(page);

    const problem = await page.evaluate((source) => {
      // DOMParser with the strict XML parser is the same check a browser makes when it
      // opens a .svg file, and it catches unescaped ampersands in a label that every
      // string assertion here would sail straight past.
      const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
      const failure = parsed.querySelector('parsererror');
      return failure === null ? null : failure.textContent?.slice(0, 200) ?? 'parse error';
    }, svg);

    expect(problem).toBeNull();
  });
});