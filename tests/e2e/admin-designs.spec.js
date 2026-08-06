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
    expect(designs.length).toBeGreaterThanOrEqual(6);

    const byId = Object.fromEntries(designs.map((d) => [d.id, d]));
    // Expected designs are present with a non-empty name + their theme. The name
    // ITSELF is asserted against the storefront's in the test below: it is
    // owner-renamable, so hardcoding it here would just be one more place to
    // update on a rename — which is the drift this endpoint is supposed to end.
    expect(byId.bachelorette).toBeTruthy();
    expect(byId.bachelorette.name).toBeTruthy();
    expect(byId.bachelorette.theme).toBe('bachelorette');
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

  // The owner's report: "different names for the same template". Every design had
  // been renamed through the admin (the rename lands in generator/themes.json
  // display_he), the storefront picked the new name up from /api/design-names, and
  // the admin screens kept showing the name hardcoded in site/js/designs.js —
  // because the merge used `d.name` for a built-in and `display_he` for a
  // template. Both now resolve through templates.displayNameForDesign, so this
  // parity holds for every design the storefront can name.
  test('the admin catalog names every design exactly as the storefront does', async ({
    request,
  }) => {
    const [adminRes, publicRes] = await Promise.all([
      request.get(`/api/admin/designs?key=${KEY}`),
      request.get('/api/design-names'),
    ]);
    const { designs } = await adminRes.json();
    const { names } = await publicRes.json();
    // The storefront must actually name something, or this test proves nothing.
    expect(Object.keys(names).length).toBeGreaterThan(0);

    const byId = Object.fromEntries(designs.map((d) => [d.id, d]));
    for (const [id, name] of Object.entries(names)) {
      expect(byId[id]).toBeTruthy();
      // id=name pairs so a mismatch names the offending design in the output.
      expect(`${id}=${byId[id].name}`).toBe(`${id}=${name}`);
    }
    // ...and specifically for a BUILT-IN design, which is the branch that drifted.
    expect(byId.bachelorette.custom).toBe(false);
    expect(byId.bachelorette.name).toBe(names.bachelorette);
  });

  // An uploaded template is a design like any other here. It used to be absent —
  // sellable on the storefront, invisible in every admin design screen.
  test('the API lists uploaded templates too, each measured against its OWN files', async ({
    request,
  }) => {
    const r = await request.get(`/api/admin/designs?key=${KEY}`);
    const { designs } = await r.json();
    const byId = Object.fromEntries(designs.map((d) => [d.id, d]));

    const tpl = byId.grapefruit; // a real, in-store uploaded template
    expect(tpl).toBeTruthy();
    expect(tpl.custom).toBe(true);
    expect(tpl.theme).toBe('grapefruit'); // a template IS its own theme
    // Its checklist names the TEMPLATE's files and says where it looked — it is
    // never reported as missing a built-in design's site/assets/designs/* files.
    expect(tpl.source.kind).toBe('template');
    expect(tpl.source.dir).toContain('templates/grapefruit');
    expect(tpl.assets.every((a) => a.file.startsWith('filled/'))).toBe(true);
    expect(tpl.missing.some((f) => f.endsWith('.webp'))).toBe(false);
    // Same group ids as a built-in design, so ONE UI renders both.
    expect(tpl.assets.map((a) => a.group)).toEqual(['front', 'back', 'board']);

    // The built-ins keep their own layout, and nothing is listed twice.
    expect(byId.bachelorette.custom).toBe(false);
    expect(byId.bachelorette.source.kind).toBe('builtin');
    expect(new Set(designs.map((d) => d.id)).size).toBe(designs.length);
  });

  test('the dashboard renders a card per design and flags kids as incomplete', async ({ page }) => {
    await page.goto(`/admin-designs.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    // one card per design (>= 6 built-in designs in the catalog).
    const cards = page.locator('.card');
    await expect(async () => {
      expect(await cards.count()).toBeGreaterThanOrEqual(6);
    }).toPass();

    // bachelorette card shows a green "מלא" state.
    const bach = page.locator('.card[data-id="bachelorette"]');
    await expect(bach).toHaveClass(/complete/);
    await expect(bach.locator('.state.full')).toContainText('מלא');
    await expect(bach.locator('.source')).toContainText('site/assets/designs/bachelorette');

    // kids card is flagged incomplete with a board-missing badge.
    const kids = page.locator('.card[data-id="kids"]');
    await expect(kids).toHaveClass(/incomplete/);
    await expect(kids.locator('.state.gap')).toBeVisible();
    await expect(kids.locator('.badge', { hasText: 'לוח' })).toBeVisible();
    await expect(kids.locator('.badge', { hasText: 'board.svg' })).toBeVisible();
  });

  test('the dashboard shows an uploaded template as its own card, with its own checklist', async ({
    page,
  }) => {
    await page.goto(`/admin-designs.html?key=${KEY}`);
    const tpl = page.locator('.card[data-id="grapefruit"]');
    await expect(tpl).toHaveCount(1);
    // The card names the folder its checklist was measured against, so the report
    // is honest instead of grading a template against the built-in file layout.
    await expect(tpl.locator('.source')).toContainText('templates/grapefruit');
    await expect(tpl.locator('.asset', { hasText: 'filled/' }).first()).toBeVisible();
    // No built-in file name is ever listed for it.
    await expect(tpl.locator('.asset', { hasText: 'gallery-front.webp' })).toHaveCount(0);
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
