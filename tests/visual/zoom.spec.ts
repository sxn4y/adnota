import { expect, test, type Page } from '@playwright/test';

/**
 * Zoom and fit.
 *
 * Zoom is the easiest thing in a canvas app to get subtly wrong, because the failure is
 * not a crash — it is a control that does nothing, or does the wrong thing only in one
 * direction. Both of those happened: pinch-zoom ignored the direction of the gesture, so
 * a trackpad could magnify but never shrink, and the scale compounded with itself on
 * each step. Neither throws; both read as "zooming is broken".
 */

async function openHarness(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('scene')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** The scale currently applied to the scene's root transform. */
async function scaleOf(page: Page): Promise<number> {
  const transform = await page.locator('[data-testid="scene"] > g').first().getAttribute('transform');
  const match = /scale\(([-\d.e]+)\)/.exec(transform ?? '');
  return match ? Number(match[1]) : Number.NaN;
}

/**
 * Dispatch a wheel event on the scene with an exact delta.
 *
 * `mouse.wheel` is not usable here: Chromium swallows a large negative delta as a
 * scroll-bounce, and WebKit and Firefox deliver it differently again, so a test written
 * against it would be asserting on browser scroll physics rather than on the app. The
 * event still goes through React's real handler — only the input is synthesised.
 */
async function wheelOnScene(page: Page, deltaY: number, ctrlKey = false): Promise<void> {
  await page.getByTestId('scene').evaluate((scene, detail) => {
    scene.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: detail.deltaY,
        ctrlKey: detail.ctrlKey,
        bubbles: true,
        cancelable: true,
        clientX: window.innerWidth / 2,
        clientY: window.innerHeight / 2,
      }),
    );
  }, { deltaY, ctrlKey });
}

test.describe('zoom buttons', () => {
  test('zoom in and zoom out are both present', async ({ page }) => {
    await openHarness(page);

    await expect(page.getByTestId('zoom-in')).toBeVisible();
    await expect(page.getByTestId('zoom-out')).toBeVisible();
    await expect(page.getByTestId('zoom-fit')).toBeVisible();
  });

  test('zoom out shrinks the scene', async ({ page }) => {
    await openHarness(page);

    const before = await scaleOf(page);
    await page.getByTestId('zoom-out').click();
    const after = await scaleOf(page);

    expect(after).toBeLessThan(before);
  });

  test('zoom in grows the scene', async ({ page }) => {
    await openHarness(page);

    const before = await scaleOf(page);
    await page.getByTestId('zoom-in').click();
    const after = await scaleOf(page);

    expect(after).toBeGreaterThan(before);
  });

  test('repeated zooming out keeps shrinking rather than stalling', async ({ page }) => {
    await openHarness(page);

    // The reported bug was that zooming out did nothing after a point, because the
    // scale was being multiplied by itself on each step.
    // Each press is a fixed reciprocal step, so three of them must land at
    // start / ZOOM_STEP^3. Asserted as a monotonic shrink with the exact ratio, which
    // catches both a stall and a compounding step.
    const start = await scaleOf(page);

    const seen: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await page.getByTestId('zoom-out').click();
      seen.push(await scaleOf(page));
    }

    expect(seen[1]).toBeLessThan(seen[0]);
    expect(seen[2]).toBeLessThan(seen[1]);
    expect(seen[2]).toBeCloseTo(start / 1.2 ** 3, 4);
  });

  test('zooming in and out returns to where it started', async ({ page }) => {
    await openHarness(page);

    const before = await scaleOf(page);
    await page.getByTestId('zoom-in').click();
    await page.getByTestId('zoom-out').click();

    // Each step is the reciprocal of the other, so a round trip must be a no-op. It was
    // not, because the step was applied against the already-scaled value.
    expect(await scaleOf(page)).toBeCloseTo(before, 5);
  });

  test('fit restores the scene after zooming away from it', async ({ page }) => {
    await openHarness(page);

    const fitted = await scaleOf(page);
    await page.getByTestId('zoom-in').click();
    await page.getByTestId('zoom-in').click();
    expect(await scaleOf(page)).not.toBeCloseTo(fitted, 5);

    await page.getByTestId('zoom-fit').click();
    expect(await scaleOf(page)).toBeCloseTo(fitted, 4);
  });

  test('zooming never runs away to an unusable scale', async ({ page }) => {
    await openHarness(page);

    for (let i = 0; i < 40; i += 1) await page.getByTestId('zoom-out').click();
    const smallest = await scaleOf(page);
    expect(smallest).toBeGreaterThanOrEqual(0.2);

    for (let i = 0; i < 80; i += 1) await page.getByTestId('zoom-in').click();
    const largest = await scaleOf(page);
    expect(largest).toBeLessThanOrEqual(3);
  });
});

test.describe('wheel zoom', () => {
  test('scrolling down zooms out', async ({ page }) => {
    await openHarness(page);

    const before = await scaleOf(page);
    await wheelOnScene(page, 300);
    expect(await scaleOf(page)).toBeLessThan(before);
  });

  test('scrolling up zooms in', async ({ page }) => {
    await openHarness(page);

    const before = await scaleOf(page);
    await wheelOnScene(page, -300);
    expect(await scaleOf(page)).toBeGreaterThan(before);
  });

  test('pinch zoom responds in both directions', async ({ page }) => {
    await openHarness(page);

    // The reported bug: ctrl+wheel used a fixed factor that ignored the gesture's
    // direction, so a trackpad could only ever magnify.
    const start = await scaleOf(page);

    await wheelOnScene(page, -300, true);
    const pinchedIn = await scaleOf(page);
    expect(pinchedIn).toBeGreaterThan(start);

    await wheelOnScene(page, 300, true);
    const pinchedOut = await scaleOf(page);
    expect(pinchedOut).toBeLessThan(pinchedIn);
  });
});

test.describe('keyboard zoom', () => {
  test('+ and - zoom in and out', async ({ page }) => {
    await openHarness(page);
    await page.getByTestId('canvas').focus();

    const before = await scaleOf(page);

    await page.keyboard.press('+');
    expect(await scaleOf(page)).toBeGreaterThan(before);

    await page.keyboard.press('-');
    expect(await scaleOf(page)).toBeCloseTo(before, 5);
  });

  test('0 refits', async ({ page }) => {
    await openHarness(page);
    await page.getByTestId('canvas').focus();

    const fitted = await scaleOf(page);
    await page.getByTestId('zoom-in').click();
    await page.getByTestId('zoom-in').click();

    // Focus returns to the canvas first: clicking a toolbar button leaves focus on that
    // button, and the canvas keyboard handler only sees keys aimed at the canvas.
    await page.getByTestId('canvas').focus();
    await page.keyboard.press('0');
    expect(await scaleOf(page)).toBeCloseTo(fitted, 4);
  });

  test('zoom works with nothing selected', async ({ page }) => {
    await openHarness(page);
    await page.getByTestId('canvas').focus();

    // The structural keys require a selected node; zooming acts on the whole canvas and
    // must not be gated on that.
    await expect(page.locator('g[data-node-id][data-selected]')).toHaveCount(0);
    const before = await scaleOf(page);
    await page.keyboard.press('-');

    expect(await scaleOf(page)).toBeLessThan(before);
  });
});