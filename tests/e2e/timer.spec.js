import { test, expect } from '@playwright/test';

// Timer e2e: starting the 60s countdown decreases the displayed seconds,
// and reset returns it to 60. Runs on desktop + mobile projects.

test.describe('timer', () => {
  test('start decreases countdown, reset returns to 60', async ({ page }) => {
    await page.goto('/timer.html');

    const count = page.getByTestId('timer-count');
    await expect(count).toHaveText('60');

    // Start the countdown.
    await page.getByTestId('timer-toggle').click();

    // After a moment, the displayed seconds should have dropped below 60.
    await expect
      .poll(async () => Number(await count.innerText()), { timeout: 5000 })
      .toBeLessThan(60);

    // Reset returns to the full 60 seconds.
    await page.getByTestId('timer-reset').click();
    await expect(count).toHaveText('60');
  });

  test('the numeric countdown is the display — no visible hourglass', async ({ page }) => {
    await page.goto('/timer.html');

    // The numeric count is the primary, visible display.
    await expect(page.getByTestId('timer-count')).toBeVisible();
    await expect(page.getByTestId('timer-count')).toHaveText('60');

    // The old sand-clock SVG is gone (not merely hidden).
    await expect(page.locator('svg.hourglass')).toHaveCount(0);
    await expect(page.locator('#stage')).toHaveCount(0);
  });

  test('reset is hidden until start, shows while running, hides again on reset', async ({
    page,
  }) => {
    await page.goto('/timer.html');

    const reset = page.getByTestId('timer-reset');
    const toggle = page.getByTestId('timer-toggle');

    // Hidden before the timer starts.
    await expect(reset).toBeHidden();

    // Visible after start.
    await toggle.click();
    await expect(reset).toBeVisible();

    // Hidden again after reset.
    await reset.click();
    await expect(reset).toBeHidden();
  });
});
