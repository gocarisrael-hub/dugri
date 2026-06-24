import { test, expect } from '@playwright/test';

test('options → demo checkout → thankyou (bit notice + owner WhatsApp)', async ({ page }) => {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('continue-btn')).toBeVisible();

  // Order button now goes to the demo checkout, not WhatsApp.
  await page.getByTestId('continue-btn').click();
  await page.waitForURL(/checkout\.html/);
  await expect(page.locator('#total')).toContainText('79');

  // Task 6: bit-payment notice is shown over the card fields.
  await expect(page.locator('#payNotice')).toBeVisible();
  await expect(page.locator('#payNotice')).toContainText('ביט');

  // Task 5: continue opens a WhatsApp popup to the owner AND moves this tab
  // to the thank-you / word-collection step.
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#payBtn')]);
  // wa.me redirects to api.whatsapp.com; the owner phone number is the invariant.
  expect(popup.url()).toContain('972546577715');
  // Close the external popup immediately — left open it keeps loading wa.me over
  // the network and starves the other CI workers (causing unrelated page.goto timeouts).
  await popup.close();
  await page.waitForURL(/thankyou\.html/);
  await expect(page.locator('#createBtn')).toBeVisible();
});
