import { test, expect } from '@playwright/test';

// Full flow for the optional "צ'ייסרים" drinking-game add-on:
// toggle it in the configurator -> continue -> create the collection on
// thankyou -> the owner sees the 🥃 badge in the admin orders table.
test('chasers add-on flows from the configurator into the order and admin', async ({ page }) => {
  await page.goto('/options.html?plan=base');

  // turn the add-on on, then continue to thankyou (carries ?chasers=1).
  await page.getByTestId('chasers-toggle').check();
  await expect(page.getByTestId('chasers-toggle')).toBeChecked();
  await page.getByTestId('continue-btn').click();
  await page.waitForURL(/thankyou\.html/);
  expect(page.url()).toContain('chasers=1');

  // create the shared collection (email + IL mobile both required).
  const honoree = 'צ׳ייסר-בדיקה-' + Date.now();
  await page.fill('#honoreeInput', honoree);
  await page.fill('#ownerEmail', 'chasers-test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.click('#createBtn');
  await page.waitForURL(/collect\.html/);

  // the owner's admin view shows the 🥃 badge for this order.
  await page.goto('/admin.html?key=dugri-admin');
  const row = page.locator('tr', { hasText: honoree });
  await expect(row).toBeVisible();
  await expect(row).toContainText('🥃');
  await expect(row).toContainText('צ׳ייסרים');
});
