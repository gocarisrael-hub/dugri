import { test, expect } from '@playwright/test';

// The fullscreen zoom overlay lets a customer read the 8-card sheet up close.
// It clones the ALREADY-RENDERED active panel, so it always shows the current
// tab in the current colours; +/- buttons and double-tap drive the zoom (never
// pinch alone — the Instagram in-app browser is the primary audience), and
// ×/ESC/back all close it and restore body scroll + focus.

test.describe('fullscreen zoom overlay', () => {
  test('the ⤢ button opens it and it reflects the picked colour', async ({ page }) => {
    await page.goto('/options.html?step=2');
    // pick a non-original colour so we can prove the overlay reflects the live palette
    await page.getByTestId('color-3').click();
    const frontC0 = await page
      .getByTestId('preview-front')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--c0').trim());
    expect(frontC0).toMatch(/^#[0-9a-f]{6}$/i);

    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    await expect(page.locator('#zoomContent svg')).toBeVisible();

    // the overlay carries the SAME live --c0 as the preview it was cloned from
    const zoomC0 = await page
      .getByTestId('zoom-content')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--c0').trim());
    expect(zoomC0).toBe(frontC0);
  });

  test('tapping the sheet opens it; ＋ enlarges the rendered sheet', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();

    // tap the live sheet itself (top-start corner, clear of the ⤢ button)
    await page.getByTestId('preview-stage').click({ position: { x: 12, y: 12 } });
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();

    const widthOf = () =>
      page.locator('#zoomContent svg').evaluate((el) => el.getBoundingClientRect().width);
    const before = await widthOf();
    await page.getByTestId('zoom-in').click();
    await page.waitForTimeout(250); // width transition
    const after = await widthOf();
    expect(after).toBeGreaterThan(before + 5);
  });

  test('double-tap toggles the zoom scale', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();

    const zoomVar = () =>
      page
        .getByTestId('zoom-content')
        .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--zoom') || '1'));
    expect(await zoomVar()).toBe(1);

    // two quick taps (pointerup) on the viewport toggles zoom in
    const vp = page.getByTestId('zoom-viewport');
    await vp.dispatchEvent('pointerup');
    await page.waitForTimeout(80);
    await vp.dispatchEvent('pointerup');
    await expect.poll(async () => await zoomVar()).toBeGreaterThan(1);
  });

  test('× closes it, restoring body scroll and focus', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();

    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

    await page.getByTestId('zoom-close').click();
    await expect(page.getByTestId('zoom-overlay')).toBeHidden();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
    // focus returns to the opener
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
      'zoom-open'
    );
  });

  test('ESC closes it and restores body scroll', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('zoom-overlay')).toBeHidden();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  });

  test('the overlay shows the currently selected board tab', async ({ page }) => {
    await page.goto('/options.html');
    await page.getByTestId('tab-board').click();
    await expect(page.getByTestId('preview-board')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('preview-board').locator('svg')).toBeVisible();

    await page.getByTestId('zoom-open').click();
    await expect(page.getByTestId('zoom-overlay')).toBeVisible();
    // the cloned artwork is present (from the board panel, the active tab)
    await expect(page.locator('#zoomContent svg')).toBeVisible();
  });
});
