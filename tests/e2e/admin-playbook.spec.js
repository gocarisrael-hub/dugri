import { test, expect } from '@playwright/test';

// The internal playbook/notebook is behind the admin key. The e2e server runs
// with ADMIN_KEY=dugri-admin and DATA_DIR=.e2e-data (throwaway), so notes here
// never touch real data.
const KEY = 'dugri-admin';

test.describe('admin playbook / notebook', () => {
  test('without a key the page reveals nothing and asks for ?key=', async ({ page }) => {
    await page.goto('/admin-playbook.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
  });

  test('with the key it loads the seeded recipes', async ({ page }) => {
    await page.goto(`/admin-playbook.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();
    // seeded starter notes are present
    await expect(page.locator('.note-title', { hasText: 'פרומפט ChatGPT' })).toBeVisible();
    await expect(page.locator('.section-title', { hasText: 'הדפסה' })).toBeVisible();
  });

  test('the owner can add a note and it persists in the list', async ({ page }) => {
    await page.goto(`/admin-playbook.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    const title = 'בדיקה ' + Date.now();
    await page.fill('#fSection', 'בדיקות');
    await page.fill('#fTitle', title);
    await page.fill('#fBody', 'תוכן בדיקה');
    await page.click('#saveBtn');

    // it appears in the rendered notes, under its section
    await expect(page.locator('.note-title', { hasText: title })).toBeVisible();
    await expect(page.locator('.section-title', { hasText: 'בדיקות' })).toBeVisible();

    // and survives a reload (persisted server-side)
    await page.reload();
    await expect(page.locator('.note-title', { hasText: title })).toBeVisible();
  });

  test('a wrong key is rejected by the API', async ({ request }) => {
    const r = await request.get('/api/admin/playbook?key=nope');
    expect(r.status()).toBe(403);
  });

  // THIS USED TO OPEN FROM THE MENU. The owner took פלייבוק off the admin menu
  // and chose for this page to stop carrying a menu of its own, so the route is
  // the only way in now — by an address she keeps, not by a link she clicks.
  //
  // What the old test was really protecting is kept: the key travels with the
  // address and the page comes up authenticated. What is gone is the menu entry
  // it used to click, and asserting that again would only re-state the removal.
  test('opens by address with the key, and no longer carries a menu', async ({ page }) => {
    await page.goto(`/admin-playbook.html?key=${KEY}`);
    await expect(page).toHaveURL(/admin-playbook\.html\?key=/);
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#nav')).toHaveCount(0);
  });

  // …and the menu it left really is without it, checked from a page that HAS a
  // menu. Together with the case above this is the whole change: off the menu,
  // still served.
  test('the orders-management menu no longer lists it', async ({ page }) => {
    await page.goto(`/admin.html?key=${KEY}`);
    await expect(page.locator('#nav')).toBeVisible();
    await expect(page.locator('#nav a[data-page="admin-playbook.html"]')).toHaveCount(0);
  });
});
