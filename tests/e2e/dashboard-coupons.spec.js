import { test, expect } from '@playwright/test';

const KEY = 'dugri-admin';

// Unique per call so parallel device projects (which share one server + JSON
// store) never collide on a coupon code.
const uniqCode = () => 'E2E' + Math.random().toString(36).slice(2, 8).toUpperCase();

test('dashboard shows stat cards and nav links carry the key', async ({ page }) => {
  await page.goto(`/dashboard.html?key=${KEY}`);

  // Six stat cards render (all/open/paid/paid-today/revenue/active-coupons).
  await expect(page.locator('#cards .card')).toHaveCount(6);
  await expect(page.locator('#cards')).toContainText('כל ההזמנות');
  await expect(page.locator('#cards')).toContainText('הכנסות ששולמו');
  await expect(page.locator('#cards')).toContainText('קופונים פעילים');

  // Nav links (and the CTA links) carry the admin key across pages.
  await expect(page.locator('#nav a', { hasText: 'ניהול הזמנות' })).toHaveAttribute(
    'href',
    `admin.html?key=${KEY}`
  );
  await expect(page.locator('#nav a', { hasText: 'ניהול קופונים' })).toHaveAttribute(
    'href',
    `coupons.html?key=${KEY}`
  );
  await expect(page.locator('#links a', { hasText: 'ניהול קופונים' })).toHaveAttribute(
    'href',
    `coupons.html?key=${KEY}`
  );
});

test('dashboard without a key shows the missing-key message', async ({ page }) => {
  await page.goto('/dashboard.html');
  await expect(page.locator('body')).toContainText('חסר מפתח גישה');
});

test('coupons: create, list with 0 uses, toggle inactive, delete', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  const code = uniqCode();

  await page.goto(`/coupons.html?key=${KEY}`);
  await expect(page.locator('#createPanel')).toBeVisible();

  // Create a coupon: code + percent + a future expiry date.
  await page.locator('#code').fill(code);
  await page.locator('#pct').fill('15');
  await page.locator('#until').fill('2030-12-31');
  await page.getByRole('button', { name: 'צור קופון' }).click();

  // It appears in the table with 15%, an expiry, active, and 0 uses.
  const row = page.locator('tbody tr').filter({ hasText: code });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('15%');
  await expect(row.locator('.pill.on')).toBeVisible();
  await expect(row.locator('td').nth(4)).toHaveText('0');

  // Toggle inactive.
  await row.getByRole('button', { name: 'כבה' }).click();
  await expect(row.locator('.pill.off')).toBeVisible();

  // Delete (confirm auto-accepted) -> the row disappears.
  await row.getByRole('button', { name: 'מחק' }).click();
  await expect(page.locator('tbody tr').filter({ hasText: code })).toHaveCount(0);
});

test('coupons: server 400 (duplicate code) is shown inline', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());
  const code = uniqCode();
  await page.goto(`/coupons.html?key=${KEY}`);
  await expect(page.locator('#createPanel')).toBeVisible();

  // First create succeeds and lists the coupon.
  await page.locator('#code').fill(code);
  await page.locator('#pct').fill('10');
  await page.getByRole('button', { name: 'צור קופון' }).click();
  const row = page.locator('tbody tr').filter({ hasText: code });
  await expect(row).toHaveCount(1);

  // Second create with the same code is rejected 400 -> inline Hebrew error.
  await page.locator('#code').fill(code);
  await page.locator('#pct').fill('10');
  await page.getByRole('button', { name: 'צור קופון' }).click();
  await expect(page.locator('#err')).toContainText('כבר קיים');

  // Clean up.
  await row.getByRole('button', { name: 'מחק' }).click();
});

test('coupons without a key shows the missing-key message', async ({ page }) => {
  await page.goto('/coupons.html');
  await expect(page.locator('body')).toContainText('חסר מפתח גישה');
  await expect(page.locator('#createPanel')).toBeHidden();
});
