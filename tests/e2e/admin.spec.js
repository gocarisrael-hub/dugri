import { test, expect } from '@playwright/test';

test('admin orders page lists created collections (with key) and rejects wrong key', async ({
  page,
}) => {
  // create an order (via the wizard) so the admin list has at least one row
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click(); // design -> color
  await page.getByTestId('next-btn').click(); // color -> add-ons
  await page.getByTestId('next-btn').click(); // add-ons -> name
  await page.fill('#honoreeInput', 'אדמין-בדיקה');
  await page.getByTestId('next-btn').click(); // name -> contact
  await page.fill('#ownerEmail', 'admin-test@example.com');
  await page.fill('#ownerPhone', '0521234567'); // phone required
  await page.getByTestId('next-btn').click(); // "צרו את המשחק"
  await page.waitForURL(/collect\.html/);

  // correct key (e2e server uses the default ADMIN_KEY)
  await page.goto('/admin.html?key=dugri-admin');
  await expect(page.locator('table')).toBeVisible();
  await expect(page.locator('table')).toContainText('admin-test@example.com');

  // wrong key is rejected
  await page.goto('/admin.html?key=wrong');
  await expect(page.locator('body')).toContainText('מפתח גישה שגוי');
});
