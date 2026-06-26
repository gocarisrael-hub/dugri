import { test, expect } from '@playwright/test';

// Configurator e2e: live preview, design + color selection, recolor propagation,
// and the resulting WhatsApp order intent. Runs on every configured project
// (desktop + mobile) via playwright.config.js.

test.describe('configurator', () => {
  test('preview, recolor, tab swap and order intent', async ({ page }) => {
    await page.goto('/options.html?plan=base');

    // Preview card visible and plan price reflects the base plan.
    await expect(page.getByTestId('preview')).toBeVisible();
    await expect(page.getByTestId('plan-price')).toHaveText('79');
    await expect(page.getByTestId('continue-btn')).toContainText('79');

    // Wait for the modules to populate the design + color pickers.
    const designs = page.getByTestId('design-list').locator('.design');
    const colors = page.getByTestId('color-list').locator('.swatch');
    await expect(designs.nth(1)).toBeVisible();
    await expect(colors.first()).toBeVisible();

    // Front preview should contain an inlined SVG.
    const frontPanel = page.getByTestId('preview-front');
    await expect(frontPanel.locator('svg')).toBeVisible();

    // Helper: read --c0 of the front preview's svg (or its computed fill).
    const readC0 = async () =>
      frontPanel
        .locator('svg')
        .first()
        .evaluate((svg) => {
          const v = getComputedStyle(svg).getPropertyValue('--c0').trim();
          return v || getComputedStyle(svg).fill;
        });

    const before = await readC0();

    // Pick the second design.
    await page.getByTestId('design-1').click();
    await expect(page.getByTestId('design-1')).toHaveAttribute('aria-pressed', 'true');

    // Pick a non-default color (second swatch if present, else first).
    const swatchCount = await colors.count();
    const colorIdx = swatchCount > 1 ? 1 : 0;
    await page.getByTestId('color-' + colorIdx).click();
    await expect(page.getByTestId('color-' + colorIdx)).toHaveAttribute('aria-pressed', 'true');

    // The front preview's --c0 (or fill) should have changed from its initial value.
    await expect.poll(async () => readC0()).not.toBe(before);

    // Switch to the board tab; the board preview should be shown and recolored.
    await page.getByTestId('tab-board').click();
    await expect(page.getByTestId('tab-board')).toHaveAttribute('aria-selected', 'true');
    const boardPanel = page.getByTestId('preview-board');
    await expect(boardPanel).toHaveAttribute('data-active', 'true');
    const boardC0 = await boardPanel
      .locator('svg')
      .first()
      .evaluate((svg) => getComputedStyle(svg).getPropertyValue('--c0').trim());
    expect(boardC0.length).toBeGreaterThan(0);

    // The continue button holds the resulting wa.me intent in data-wa-url.
    const waUrl = await page.getByTestId('continue-btn').getAttribute('data-wa-url');
    expect(waUrl, 'continue button should carry a wa.me url').toBeTruthy();
    expect(waUrl).toContain('wa.me');

    // The intent must encode plan + chosen design + chosen color.
    const decoded = decodeURIComponent(waUrl);
    const chosenDesign = await page.getByTestId('design-1').getAttribute('data-design-id');
    const chosenColorName = await page.getByTestId('color-' + colorIdx).getAttribute('aria-label');

    // plan is persisted to the URL; design + color identity appear in the order text.
    expect(page.url()).toContain('plan=base');
    expect(decoded).toContain(chosenColorName);
    // design identity: either id or human name should be present in the intent.
    const designName = await page.getByTestId('design-1').locator('.dname').innerText();
    expect(decoded.includes(designName) || decoded.includes(chosenDesign)).toBeTruthy();
  });

  test('continue goes to thankyou (payment now lives on the collect page)', async ({ page }) => {
    await page.goto('/options.html?plan=base');
    await expect(page.getByTestId('plan-price')).toHaveText('79');
    await expect(page.locator('#continuePrice')).toHaveText('79');

    await page.getByTestId('continue-btn').click();
    await page.waitForURL(/thankyou\.html/);
    await expect(page.locator('#createBtn')).toBeVisible();
  });

  test('typed honoree name shows live on the front preview only', async ({ page }) => {
    await page.goto('/options.html?plan=base');

    const overlay = page.getByTestId('name-overlay');
    const input = page.getByTestId('honoree-name');

    // Empty input -> overlay hidden.
    await expect(overlay).toBeHidden();

    // Typing a name shows it over the front preview.
    await input.fill('נועה');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('נועה');

    // Switching to back/board hides the name overlay (front-only).
    await page.getByTestId('tab-back').click();
    await expect(overlay).toBeHidden();
    await page.getByTestId('tab-board').click();
    await expect(overlay).toBeHidden();

    // Back to front -> visible again with the same name.
    await page.getByTestId('tab-front').click();
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('נועה');

    // Clearing the name hides the overlay again.
    await input.fill('');
    await expect(overlay).toBeHidden();
  });

  test('the typed name is carried to thankyou and prefills the honoree input', async ({ page }) => {
    await page.goto('/options.html?plan=base');
    await page.getByTestId('honoree-name').fill('נועה');

    await page.getByTestId('continue-btn').click();
    await page.waitForURL(/thankyou\.html/);

    await expect(page.locator('#honoreeInput')).toHaveValue('נועה');
  });

  test('raster-background note shows only for the kids design', async ({ page }) => {
    await page.goto('/options.html');

    const note = page.getByTestId('raster-note');

    // Find the design tile whose id is "kids" and the one whose id is "birthday".
    const kidsTile = page.locator('.design[data-design-id="kids"]');
    const birthdayTile = page.locator('.design[data-design-id="birthday"]');
    await expect(kidsTile).toBeVisible();

    // Selecting kids reveals the fixed-background caption.
    await kidsTile.click();
    await expect(note).toBeVisible();
    await expect(note).toContainText('הרקע בעיצוב זה קבוע');

    // Selecting a vector-only design hides it again.
    await birthdayTile.click();
    await expect(note).toBeHidden();
  });
});
