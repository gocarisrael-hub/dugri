import { test, expect } from '@playwright/test';

// The design asset-inventory dashboard is behind the admin key. The e2e server
// runs with ADMIN_KEY=dugri-admin. This is READ-ONLY visibility, so no data is
// mutated here — the dashboard just reports which per-design files exist on disk.
const KEY = 'dugri-admin';

test.describe('admin designs — asset inventory', () => {
  test('without a key the page reveals nothing and asks for ?key=', async ({ page }) => {
    await page.goto('/admin-designs.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
  });

  test('a wrong key is rejected by the API', async ({ request }) => {
    const r = await request.get('/api/admin/designs?key=nope');
    expect(r.status()).toBe(403);
  });

  test('an absent key is rejected by the API', async ({ request }) => {
    const r = await request.get('/api/admin/designs');
    expect(r.status()).toBe(403);
  });

  test('the API lists every design and flags the kids board gap', async ({ request }) => {
    const r = await request.get(`/api/admin/designs?key=${KEY}`);
    expect(r.ok()).toBeTruthy();
    const { designs } = await r.json();
    expect(Array.isArray(designs)).toBeTruthy();
    expect(designs.length).toBeGreaterThanOrEqual(7);

    const byId = Object.fromEntries(designs.map((d) => [d.id, d]));
    // Expected designs are present with Hebrew names + theme.
    expect(byId.bachelorette).toBeTruthy();
    expect(byId.bachelorette.name).toBe('מסיבת רווקות');
    expect(byId.kids).toBeTruthy();

    // kids ships without a board: board.svg / thumb-board / gallery-board missing.
    const kids = byId.kids;
    expect(kids.complete).toBe(false);
    expect(kids.missing).toContain('board.svg');
    expect(kids.missing).toContain('thumb-board.webp');
    expect(kids.missing).toContain('gallery-board.webp');
    // The gap is grouped under the "לוח" (board) label.
    const boardGroup = kids.missingGroups.find((g) => g.group === 'board');
    expect(boardGroup).toBeTruthy();
    expect(boardGroup.files).toEqual(
      expect.arrayContaining(['board.svg', 'thumb-board.webp', 'gallery-board.webp'])
    );
    // kids DOES have its front/back assets, so only the board group is missing.
    expect(kids.present).toContain('front.svg');
    expect(kids.missingGroups.map((g) => g.group)).toEqual(['board']);

    // A fully-provisioned design reports complete with no missing files.
    const bach = byId.bachelorette;
    expect(bach.complete).toBe(true);
    expect(bach.missing).toEqual([]);
  });

  test('the dashboard renders a card per design and flags kids as incomplete', async ({ page }) => {
    await page.goto(`/admin-designs.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    // one card per design (>= 7 designs in the catalog).
    const cards = page.locator('.card');
    await expect(async () => {
      expect(await cards.count()).toBeGreaterThanOrEqual(7);
    }).toPass();

    // bachelorette card shows a green "מלא" state.
    const bach = page.locator('.card[data-id="bachelorette"]');
    await expect(bach).toHaveClass(/complete/);
    await expect(bach.locator('.state.full')).toContainText('מלא');

    // kids card is flagged incomplete with a board-missing badge.
    const kids = page.locator('.card[data-id="kids"]');
    await expect(kids).toHaveClass(/incomplete/);
    await expect(kids.locator('.state.gap')).toBeVisible();
    await expect(kids.locator('.badge', { hasText: 'לוח' })).toBeVisible();
    await expect(kids.locator('.badge', { hasText: 'board.svg' })).toBeVisible();
  });

  test('opens from the orders-management page nav, carrying the key', async ({ page }) => {
    await page.goto(`/admin.html?key=${KEY}`);
    const link = page.locator('#nav a[data-page="admin-designs.html"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /admin-designs\.html\?key=/);
    await link.click();
    await expect(page).toHaveURL(/admin-designs\.html\?key=/);
    await expect(page.locator('#app')).toBeVisible();
  });
});
