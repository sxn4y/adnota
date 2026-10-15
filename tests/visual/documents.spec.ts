import { expect, test, type Page } from '@playwright/test';

/**
 * Document management.
 *
 * Without this the app can only ever reopen the last document it had open, which means
 * a second piece of work has nowhere to go. These tests drive the panel through the
 * real browser against the real in-memory library, because the failure modes worth
 * catching are the ones that only appear once the panel is on screen: a button that
 * never renders, a rename that silently does nothing, a delete that removes the wrong
 * row.
 *
 * The harness starts with one document, because that is what a first launch produces.
 * Creating one also *opens* it, which closes the panel — so anything that needs to look
 * at the list again reopens it, the same as a student would.
 */

/** The harness begins with exactly one document. */
const STARTING_ROWS = 1;

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId('open-documents').click();
  await expect(page.getByTestId('documents-panel')).toBeVisible();
}

async function openHarness(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('scene')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId('save-status')).toBeVisible();
}

/** Create a document, then reopen the panel so the list is visible again. */
async function createDocument(page: Page): Promise<void> {
  await page.getByTestId('documents-new').click();
  await expect(page.getByTestId('documents-panel')).toHaveCount(0);
  await openPanel(page);
}

test.describe('documents panel', () => {
  test('lists the document the app opened with', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);

    await expect(page.getByTestId('documents-row')).toHaveCount(STARTING_ROWS);
    await expect(page.getByTestId('documents-panel')).toContainText('Integration');
  });

  test('shows the open document as current', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);

    await expect(page.getByTestId('documents-row').first()).toHaveClass(/is-current/);
  });

  test('closes on Escape and on the backdrop', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('documents-panel')).toHaveCount(0);

    await openPanel(page);
    await page.getByTestId('documents-panel').click({ position: { x: 4, y: 4 } });
    await expect(page.getByTestId('documents-panel')).toHaveCount(0);
  });

  test('creates a second document rather than replacing the first', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);
    await createDocument(page);

    // Clobbering the first would lose a student's earlier work silently.
    await expect(page.getByTestId('documents-row')).toHaveCount(STARTING_ROWS + 1);
  });

  test('opens a new document and makes it current', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);
    await createDocument(page);

    // Targeted by name rather than position: the list sorts by modification time, and an
    // in-memory document has none, so its order is alphabetical and not predictable by
    // index. What matters is that the document just created is the open one.
    const current = page.locator('[data-testid="documents-row"].is-current');
    await expect(current).toHaveCount(1);
    await expect(current).not.toHaveAttribute('data-name', /Integration/);
  });

  test('renames a document', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);

    await page.getByTestId('documents-rename').first().click();
    await page.getByTestId('documents-rename-input').fill('Week 3 revision');
    await page.getByTestId('documents-rename-save').click();

    // Renaming the open document re-opens it under its new name, which remounts the
    // app and closes the panel. Waiting for the new filename first means the click below
    // lands on the remounted toolbar rather than one about to be replaced.
    await expect(page.getByTestId('save-status')).toContainText('Week 3 revision');

    await openPanel(page);
    await expect(page.getByTestId('documents-row')).toHaveCount(STARTING_ROWS);
    await expect(page.getByTestId('documents-panel')).toContainText('Week 3 revision');
  });

  test('keeps the extension on a renamed document', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);

    await page.getByTestId('documents-rename').first().click();
    await page.getByTestId('documents-rename-input').fill('Integration, part two');
    await page.getByTestId('documents-rename-save').click();

    // Dropping the extension would turn the document into a file the library no longer
    // lists: it would look renamed and have actually vanished.
    await expect(page.getByTestId('save-status')).toContainText('Integration, part two.adnota');
  });

  test('does not double the extension when one is typed', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);

    await page.getByTestId('documents-rename').first().click();
    await page.getByTestId('documents-rename-input').fill('Typed.adnota');
    await page.getByTestId('documents-rename-save').click();

    await expect(page.getByTestId('save-status')).toContainText('Typed.adnota');
    await expect(page.getByTestId('save-status')).not.toContainText('Typed.adnota.adnota');
  });

  test('keeps the renamed document open', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);

    await page.getByTestId('documents-rename').first().click();
    await page.getByTestId('documents-rename-input').fill('Integration, part two');
    await page.getByTestId('documents-rename-save').click();

    // Renaming must not silently switch the student to something else.
    await expect(page.getByTestId('scene')).toBeVisible();
    await expect(page.getByTestId('save-status')).toContainText('Integration, part two');
  });

  test('refuses a rename that would overwrite another document', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);
    await createDocument(page);

    // Take the second document's name and give it to the first.
    const second = page.getByTestId('documents-row').nth(1);
    const name = await second.getAttribute('data-name');
    await page.getByTestId('documents-rename').first().click();
    await page.getByTestId('documents-rename-input').fill(name!.replace(/\.adnota$/, ''));
    await page.getByTestId('documents-rename-save').click();

    await expect(page.getByTestId('documents-error')).toBeVisible();
    // Nothing was lost: both documents are still there.
    await expect(page.getByTestId('documents-row')).toHaveCount(STARTING_ROWS + 1);
  });

  test('refuses an empty name', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);

    await page.getByTestId('documents-rename').first().click();
    await page.getByTestId('documents-rename-input').fill('   ');
    await page.getByTestId('documents-rename-save').click();

    await expect(page.getByTestId('documents-error')).toBeVisible();
  });

  test('cancels a rename without changing anything', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);
    const before = await page.getByTestId('documents-row').first().getAttribute('data-name');

    await page.getByTestId('documents-rename').first().click();
    await page.getByTestId('documents-rename-input').fill('Something else');
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('documents-row').first()).toHaveAttribute('data-name', before!);
  });

  test('deletes a document', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);
    await createDocument(page);

    // The original document specifically, not "the first row": the document just
    // created is also the open one, and its Delete is disabled by design, so clicking
    // the first row would be a no-op rather than a deletion.
    const original = page.locator('[data-testid="documents-row"][data-name="Integration.adnota"]');
    await expect(original).toHaveCount(1);
    await original.getByTestId('documents-delete').click();

    await expect(page.getByTestId('documents-row')).toHaveCount(STARTING_ROWS);
    await expect(original).toHaveCount(0);
  });

  test('refuses to delete the document currently open', async ({ page }) => {
    await openHarness(page);
    await openPanel(page);

    // Waited for before asserting: the panel takes its first snapshot on mount, so the
    // row may not be there yet, and the delete button's disabled state depends on which
    // row is current.
    await expect(page.getByTestId('documents-row')).toHaveCount(STARTING_ROWS);

    // Deleting the open document from under the app would leave it editing something
    // that no longer exists.
    await expect(page.getByTestId('documents-delete').first()).toBeDisabled();
  });

  test('the Documents button is present whenever there is a library', async ({ page }) => {
    await openHarness(page);

    await expect(page.getByTestId('open-documents')).toBeVisible();
  });

  test('the save indicator shows the open document', async ({ page }) => {
    await openHarness(page);

    // The filename is the one thing that tells a student where their work is going.
    await expect(page.getByTestId('save-status')).toContainText('.adnota');
  });
});
