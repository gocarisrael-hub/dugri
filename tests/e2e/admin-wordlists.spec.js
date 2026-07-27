import { test, expect } from '@playwright/test';

// The seed word-pool ("wordlists") admin screen, behind the admin key. The e2e
// server runs with ADMIN_KEY=dugri-admin and DATA_DIR=.e2e-data (throwaway), so
// anything created here lands in the throwaway volume store — never in the
// shipped content/wordlists baseline.
const KEY = 'dugri-admin';

test.describe('admin wordlists', () => {
  test('without a key the page reveals nothing and asks for ?key=', async ({ page }) => {
    await page.goto('/admin-wordlists.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
  });

  test('with the key it lists the shipped pools and the theme linkage', async ({ page }) => {
    await page.goto(`/admin-wordlists.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();
    const generic = page.locator('.list-item[data-item="generic-350.txt"]');
    await expect(generic).toBeVisible();
    await expect(generic.locator('.li-meta')).toContainText('350 מילים');
    // the read-only theme -> pool table is populated
    await expect(page.locator('#links tr')).not.toHaveCount(0);
  });

  test('the owner can create a list, edit it, and it persists across a reload', async ({
    page,
  }) => {
    // Random, not Date.now(): the projects run in parallel against ONE server
    // and would otherwise collide on the same millisecond (a 409 "already exists").
    const name = 'e2e-' + Math.random().toString(36).slice(2, 10);
    await page.goto(`/admin-wordlists.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    await page.fill('#newName', name);
    await page.fill('#newWords', 'אחת, שתיים\nשלוש');
    await page.click('#createBtn');

    const item = page.locator(`.list-item[data-item="${name}.txt"]`);
    await expect(item).toBeVisible();
    await expect(item.locator('.li-meta')).toContainText('3 מילים');

    // open the editor and append one more word
    await item.locator('button[data-open]').click();
    await expect(page.locator('#editWords')).toBeVisible();
    await page.fill('#addWord', 'ארבע');
    await page.click('#addBtn');
    await expect(item.locator('.li-meta')).toContainText('4 מילים');

    // survives a reload (it is on the server's volume, not in the page)
    await page.reload();
    await expect(page.locator(`.list-item[data-item="${name}.txt"] .li-meta`)).toContainText(
      '4 מילים'
    );

    // clean up so repeated e2e runs don't accumulate lists
    page.on('dialog', (d) => d.accept());
    await page.locator(`.list-item[data-item="${name}.txt"] button[data-del]`).click();
    await expect(page.locator(`.list-item[data-item="${name}.txt"]`)).toHaveCount(0);
  });

  test('a shipped pool in use cannot be deleted and the message names the design', async ({
    page,
  }) => {
    await page.goto(`/admin-wordlists.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();
    page.on('dialog', (d) => d.accept());
    const item = page.locator('.list-item[data-item="generic-350.txt"]');
    await item.locator('button[data-del]').click();
    await expect(item.locator('.status.err')).toContainText('בשימוש');
    await expect(item).toBeVisible();
  });

  test('a wrong key is rejected by the API', async ({ request }) => {
    const r = await request.get('/api/admin/wordlists?key=nope');
    expect(r.status()).toBe(403);
  });

  test('opens from the orders-management page nav, carrying the key', async ({ page }) => {
    await page.goto(`/admin.html?key=${KEY}`);
    const link = page.locator('#nav a[data-page="admin-wordlists.html"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /admin-wordlists\.html\?key=/);
    await link.click();
    await expect(page).toHaveURL(/admin-wordlists\.html\?key=/);
    await expect(page.locator('#app')).toBeVisible();
  });
});
