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

// Count admin-collections requests so we can assert whether the 15s poll fires.
// Playwright's virtual clock lets us fast-forward past the interval instantly.
function collectionsCounter(page) {
  const state = { n: 0 };
  page.on('request', (req) => {
    if (req.url().includes('/api/admin/collections')) state.n += 1;
  });
  return state;
}

test('dashboard keeps polling with a valid key (baseline for the stop test)', async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const count = collectionsCounter(page);

  await page.goto(`/dashboard.html?key=${KEY}`);
  await expect(page.locator('#cards .card').first()).toBeVisible();
  const initial = count.n;

  // Fast-forward past the 15s interval: a fresh poll must fire.
  await page.clock.fastForward(16_000);
  await expect.poll(() => count.n).toBeGreaterThan(initial);
});

test('dashboard with a wrong key hides cards and stops polling', async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const count = collectionsCounter(page);

  await page.goto('/dashboard.html?key=wrong');
  await expect(page.locator('body')).toContainText('מפתח גישה שגוי');
  // Stale cards + CTA links are cleared on 403.
  await expect(page.locator('#cards')).toBeHidden();
  await expect(page.locator('#links')).toBeHidden();

  const after403 = count.n;
  // Fast-forward well past the interval: no further polls once the key is rejected.
  await page.clock.fastForward(45_000);
  await expect(page.locator('body')).toContainText('מפתח גישה שגוי');
  expect(count.n).toBe(after403);
});

test('dashboard hides stale cards when a later poll errors', async ({ page }) => {
  await page.clock.install({ time: new Date() });

  await page.goto(`/dashboard.html?key=${KEY}`);
  await expect(page.locator('#cards .card').first()).toBeVisible();

  // Make the next collections poll fail, then advance past the interval.
  await page.route('**/api/admin/collections**', (r) => r.abort());
  await page.clock.fastForward(16_000);

  await expect(page.locator('#cards')).toBeHidden();
  await expect(page.locator('#content')).toContainText('שגיאה בטעינה');
});

test('coupons: toggling a coupon deleted elsewhere (404) refreshes the list', async ({
  page,
  request,
}) => {
  const code = uniqCode();
  await page.goto(`/coupons.html?key=${KEY}`);
  await expect(page.locator('#createPanel')).toBeVisible();

  await page.locator('#code').fill(code);
  await page.locator('#pct').fill('20');
  await page.getByRole('button', { name: 'צור קופון' }).click();
  const row = page.locator('tbody tr').filter({ hasText: code });
  await expect(row).toHaveCount(1);

  // Simulate another tab deleting this coupon: find its id, delete via the API.
  const list = await (await request.get(`/api/admin/coupons?key=${KEY}`)).json();
  const target = list.coupons.find((c) => c.code === code);
  expect(target).toBeTruthy();
  await request.delete(`/api/admin/coupons/${target.id}?key=${KEY}`);

  // The page still shows the ghost row; toggling it 404s and reloads the list,
  // so the row reconciles away instead of lingering.
  await row.getByRole('button', { name: 'כבה' }).click();
  await expect(page.locator('tbody tr').filter({ hasText: code })).toHaveCount(0);
});
