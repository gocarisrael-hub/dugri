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
});
