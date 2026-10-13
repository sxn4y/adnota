import { expect, test, type Page } from '@playwright/test';

/**
 * These tests are the reason the math rendering path was validated before anything
 * was built on top of it. Each asserts that formulas produce actual geometry, not
 * merely that the markup is present — an empty `foreignObject` still contains correct
 * KaTeX markup while showing nothing at all.
 */

async function openHarness(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('scene')).toBeVisible();
  // Web fonts and the KaTeX stylesheet settle asynchronously; without this the first
  // screenshot can catch a half-styled frame.
  await page.evaluate(() => document.fonts.ready);
}

/** Every rendered formula must have non-zero dimensions. */
async function measureMath(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.katex')];
    return nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return Math.round(rect.width * 100) / 100;
    });
  });
}

test.describe('math rendering', () => {
  test('renders every formula with real geometry', async ({ page }) => {
    await openHarness(page);

    const widths = await measureMath(page);

    expect(widths.length).toBeGreaterThan(5);
    // A zero width means the formula parsed but never laid out: the classic
    // foreignObject failure mode.
    for (const width of widths) {
      expect(width).toBeGreaterThan(0);
    }
  });

  test('renders the integral and fraction the sample document contains', async ({ page }) => {
    await openHarness(page);

    const integral = page.locator('.katex').first();
    await expect(integral).toBeVisible();

    const box = await integral.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(4);
    expect(box!.height).toBeGreaterThan(4);
  });

  test('keeps the canvas legible when LaTeX does not parse', async ({ page }) => {
    await openHarness(page);

    // The sample document deliberately includes `\frac{1}{`, which is incomplete.
    // A student typing produces this constantly, so the scene must stay readable
    // rather than collapsing or throwing.
    const errors = page.locator('.katex-error');
    expect(await errors.count()).toBeGreaterThan(0);

    // And the scene as a whole still renders.
    await expect(page.getByTestId('scene')).toBeVisible();
    const boxes = await page.getByTestId('nodes').locator('rect').count();
    expect(boxes).toBeGreaterThan(5);
  });

  test('does not show the MathML source alongside the typeset math', async ({ page }) => {
    await openHarness(page);

    // Regression: KaTeX emits a `.katex-mathml` span alongside the rendered HTML so
    // assistive technology can read the equation. KaTeX's stylesheet hides it by
    // clipping it to a 1x1 box via `clip-path`, *not* by `display: none`. If that
    // stylesheet is ever not loaded, the MathML source renders as a visible duplicate
    // of every formula on the canvas, while every geometry test still passes because
    // the markup itself is correct and well-formed.
    const leaking = await page.evaluate(() =>
      [...document.querySelectorAll('.katex-mathml')]
        .filter((node) => {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (Number(style.opacity) === 0) return false;
          if (style.clipPath && style.clipPath !== 'none') return false;
          const rect = node.getBoundingClientRect();
          // KaTeX clips this to sub-pixel dimensions; anything larger would paint.
          return rect.width > 1 || rect.height > 1;
        })
        .map((node) => node.textContent?.slice(0, 60) ?? ''),
    );

    expect(leaking).toEqual([]);
  });

  test('loads the KaTeX web fonts rather than falling back to system serif', async ({ page }) => {
    await openHarness(page);

    const families = await page.evaluate(() =>
      [...document.querySelectorAll('.katex .mord, .katex .mop')].slice(0, 8).map(
        (node) => getComputedStyle(node).fontFamily,
      ),
    );

    expect(families.length).toBeGreaterThan(0);
    for (const family of families) {
      expect(family.toLowerCase()).toContain('katex');
    }
  });

  test('exposes every formula to assistive technology', async ({ page }) => {
    await openHarness(page);

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('[role="math"]')].map(
        (node) => node.getAttribute('aria-label') ?? '',
      ),
    );

    expect(labels.length).toBeGreaterThan(5);
    // The formula is drawn as glyphs, so without an aria-label it would be invisible
    // to a screen reader. Every one must carry readable text.
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }

    // Readable text means TeX markup has been expanded to prose. The sample document
    // includes a deliberately broken expression, whose source is echoed verbatim and
    // therefore still contains backslashes, so the conversion is asserted rather than
    // the absence of markup.
    expect(labels.some((label) => label.includes('over'))).toBe(true);
    expect(labels.some((label) => label.includes('integral'))).toBe(true);
  });
});

test.describe('scene', () => {
  test('draws a node for every visible entry', async ({ page }) => {
    await openHarness(page);

    const nodes = page.getByTestId('nodes').locator('g[data-node-id]');
    // The sample has ten authored nodes plus the document root that anchors them.
    await expect(nodes).toHaveCount(11);
  });

  test('draws exactly one branch per parent-child pair', async ({ page }) => {
    await openHarness(page);

    // The structural invariant of a tree: one fewer edge than vertices. Asserted as a
    // relation rather than a fixed number so the sample can grow without the test
    // needing to be updated in lockstep.
    const nodes = await page.getByTestId('nodes').locator('g[data-node-id]').count();
    const branches = await page.getByTestId('branches').locator('path').count();

    expect(branches).toBe(nodes - 1);
  });

  test('renders no zero-sized foreignObject', async ({ page }) => {
    await openHarness(page);

    const degenerate = await page.evaluate(() =>
      [...document.querySelectorAll('foreignObject')]
        .filter((node) => {
          const width = Number(node.getAttribute('width') ?? '0');
          const height = Number(node.getAttribute('height') ?? '0');
          return width <= 0 || height <= 0;
        })
        .map((node) => ({
          width: node.getAttribute('width'),
          height: node.getAttribute('height'),
        })),
    );

    // A zero-sized foreignObject is invisible, which would make a node unclickable.
    expect(degenerate).toEqual([]);
  });
});

test.describe('layouts', () => {
  for (const layout of ['two-sided', 'radial', 'left'] as const) {
    test(`lays out the ${layout} view without overlapping nodes`, async ({ page }) => {
      await openHarness(page);
      await page.getByTestId(`layout-${layout}`).click();
      await page.waitForTimeout(120);

      const nodes = await page.evaluate(() => {
        return [...document.querySelectorAll('g[data-node-id]')].map((node) => {
          const rect = node.getBoundingClientRect();
          return { id: node.getAttribute('data-node-id'), x: rect.x, y: rect.y, w: rect.width, h: rect.height };
        });
      });

      expect(nodes).toHaveLength(11);

      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i]!;
          const b = nodes[j]!;
          const overlaps =
            a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlaps, `${a.id} overlaps ${b.id} in ${layout} layout`).toBe(false);
        }
      }
    });
  }

  test('reports the active math renderer', async ({ page }) => {
    await openHarness(page);
    await page.getByTestId('toggle-support').click();

    await expect(page.getByTestId('support-renderer')).toHaveText('katex-foreignObject');
    await expect(page.getByTestId('support-svg')).not.toBeEmpty();
  });
});

test.describe('visual regression', () => {
  test('matches the stored snapshot', async ({ page }, testInfo) => {
    await openHarness(page);
    await page.waitForTimeout(150);

    await expect(page).toHaveScreenshot(`scene-${testInfo.project.name}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.02,
    });
  });
});
