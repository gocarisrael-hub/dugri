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
});
