import { test, expect } from '@playwright/test';

test('admin orders page lists created collections (with key) and rejects wrong key', async ({
  page,
}) => {
  // create an order so the admin list has at least one row
  await page.goto('/thankyou.html');
  await page.fill('#honoreeInput', 'אדמין-בדיקה');
  await page.fill('#ownerEmail', 'admin-test@example.com');
  await page.click('#createBtn');
  await page.waitForURL(/collect\.html/);

  // correct key (e2e server uses the default ADMIN_KEY)
  await page.goto('/admin.html?key=dugri-admin');
  await expect(page.locator('table')).toBeVisible();
  await expect(page.locator('table')).toContainText('admin-test@example.com');

  // wrong key is rejected
  await page.goto('/admin.html?key=wrong');
  await expect(page.locator('body')).toContainText('מפתח גישה שגוי');
});
