import { test, expect } from '@playwright/test';

test('options → checkout (bit payment details, no popup) → thankyou', async ({ page }) => {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('continue-btn')).toBeVisible();

  // Order button goes to the checkout.
  await page.getByTestId('continue-btn').click();
  await page.waitForURL(/checkout\.html/);
  await expect(page.locator('#total')).toContainText('79');

  // Bit payment: branded pay button links to the owner's real Bit "pay me" page.
  await expect(page.locator('#payNotice')).toContainText('ביט');
  await expect(page.locator('#bitAmount')).toHaveText('79');
  await expect(page.locator('#bitPayLink')).toHaveAttribute(
    'href',
    /bitpay\.co\.il\/app\/me\/4BE8AF50-DD1F-8868-1FF0-2DE96FEB9B6A4F38/
  );

  // Continue goes straight to the word-collection step — NO WhatsApp popup.
  let popped = false;
  page.on('popup', () => (popped = true));
  await page.click('#payBtn');
  await page.waitForURL(/thankyou\.html/);
  await expect(page.locator('#createBtn')).toBeVisible();
  expect(popped).toBe(false);
});
