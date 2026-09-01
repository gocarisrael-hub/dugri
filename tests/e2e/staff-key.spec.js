import { test, expect } from '@playwright/test';

// THE WORKER'S VIEW OF THE ADMIN.
//
// The server already refuses her the money (tests/unit/staff-key.test.js); this
// is about what she SEES. A worker who is shown fifteen nav links and gets a
// 403 on twelve of them will conclude the site is broken, or that her key is —
// and ask for a better one. So the nav is trimmed to what she can use, and a
// page she cannot open says so in Hebrew instead of half-loading.

const OWNER = 'dugri-admin';
const STAFF = 'dugri-staff'; // webServer.env in playwright.config.js

test('the owner still sees the whole admin', async ({ page }) => {
  await page.goto(`/admin.html?key=${OWNER}`);
  const nav = page.locator('#nav a');
  await expect(nav.filter({ hasText: 'ניהול קופונים' })).toHaveCount(1);
  await expect(nav.filter({ hasText: 'מחירים' })).toHaveCount(1);
  await expect(nav.filter({ hasText: 'לוח בקרה' })).toHaveCount(1);
});

test('the worker sees only the pages she can use', async ({ page }) => {
  await page.goto(`/admin.html?key=${STAFF}`);

  // The orders page itself loads for her — this is her job.
  await expect(page.locator('h1')).toContainText('ניהול הזמנות');

  const nav = page.locator('#nav a');
  // Kept: the orders, and the two pages behind the typography editor.
  await expect(nav.filter({ hasText: 'ניהול הזמנות' })).toHaveCount(1);
  await expect(nav.filter({ hasText: 'תבנית חדשה' })).toHaveCount(1);
  // Gone: every money page, and everything else that is not hers.
  for (const gone of ['ניהול קופונים', 'מחירים', 'לוח בקרה', 'פלייבוק', 'אנליטיקס']) {
    await expect(nav.filter({ hasText: gone }), gone).toHaveCount(0);
  }
});

test('the worker never sees the revenue total on her own orders page', async ({ page }) => {
  await page.goto(`/admin.html?key=${STAFF}`);
  const stats = page.locator('#stats');
  await expect(stats).toBeVisible();

  // The counts she works from are all there…
  await expect(stats).toContainText('הזמנות');
  await expect(stats).toContainText('בדפוס');
  // …and the shop's takings are not, in the DOM or on the screen.
  await expect(stats).not.toContainText('הכנסות');
  await expect(page.locator('#stats [data-money]')).toHaveCount(0);
});

test('the revenue never flashes up before the role is known', async ({ page }) => {
  // The failure this guards: the tile paints, then js/admin-role.js hears back
  // and removes it. Hiding late is the same as not hiding — she has read it.
  // Holding whoami open freezes the page in exactly that window.
  let release;
  const held = new Promise((r) => (release = r));
  await page.route('**/api/admin/whoami**', async (route) => {
    await held;
    return route.continue();
  });

  await page.goto(`/admin.html?key=${STAFF}`, { waitUntil: 'domcontentloaded' });
  // The orders have rendered while the role is still in flight…
  await expect(page.locator('#stats .stat').first()).toBeVisible();
  // …and the money is already invisible.
  await expect(page.locator('#stats [data-money]')).toBeHidden();

  release();
  await expect(page.locator('#stats [data-money]')).toHaveCount(0);
});

test('the owner still sees her revenue', async ({ page }) => {
  await page.goto(`/admin.html?key=${OWNER}`);
  await expect(page.locator('#stats')).toContainText('הכנסות');
  await expect(page.locator('#stats [data-money]')).toBeVisible();
});

test('a money page tells the worker it is not hers — not that her key is wrong', async ({
  page,
}) => {
  for (const money of ['coupons.html', 'admin-pricing.html', 'dashboard.html']) {
    await page.goto(`/${money}?key=${STAFF}`);
    const panel = page.getByTestId('staff-no-access');
    await expect(panel, money).toBeVisible();
    await expect(panel).toContainText('אין הרשאה');
    // The distinction that matters: her key is fine, the page is not hers.
    await expect(panel).toContainText('המפתח שלך תקין');
    // …and a way back to the work, rather than a dead end.
    await expect(panel.getByRole('link', { name: /ניהול ההזמנות/ })).toBeVisible();
  }
});

test('the refusal carries her key onward, so the way back actually works', async ({ page }) => {
  await page.goto(`/coupons.html?key=${STAFF}`);
  await page.getByTestId('staff-no-access').getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`admin\\.html\\?key=${STAFF}`));
  await expect(page.locator('h1')).toContainText('ניהול הזמנות');
});

test('the money is refused at the SERVER, not just hidden from the nav', async ({ request }) => {
  // The whole point: typing the URL, or calling the API directly, gains nothing.
  const coupons = await request.get(`/api/admin/coupons?key=${STAFF}`);
  expect(coupons.status()).toBe(403);
  expect((await coupons.json()).reason).toBe('staff');

  const settings = await request.get(`/api/admin/settings?key=${STAFF}`);
  expect(settings.status()).toBe(403);

  // …while the work she is meant to do is open to her.
  expect((await request.get(`/api/admin/collections?key=${STAFF}`)).status()).toBe(200);
  expect((await request.get(`/api/admin/templates?key=${STAFF}`)).status()).toBe(200);
});

test('the owner is never trimmed or refused', async ({ page }) => {
  await page.goto(`/coupons.html?key=${OWNER}`);
  await expect(page.getByTestId('staff-no-access')).toHaveCount(0);
  await expect(page.locator('#createPanel')).toBeVisible();
});
