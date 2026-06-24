import { test, expect } from '@playwright/test';

test('options → demo checkout → thankyou (no WhatsApp order step)', async ({ page }) => {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('continue-btn')).toBeVisible();

  // Order button now goes to the demo checkout, not WhatsApp.
  await page.getByTestId('continue-btn').click();
  await page.waitForURL(/checkout\.html/);
  await expect(page.locator('#total')).toContainText('79');

  // Fake "pay" continues to the thank-you / word-collection step.
  await page.click('#payBtn');
  await page.waitForURL(/thankyou\.html/);
  await expect(page.locator('#createBtn')).toBeVisible();
  await expect(page.locator('#waSend')).toHaveCount(0);
});
