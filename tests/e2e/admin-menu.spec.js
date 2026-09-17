import { test, expect } from '@playwright/test';

// THE MENU CHANGE, TESTED AT THE ROUTE RATHER THAN AT THE MENU.
//
// The owner asked for two things: three entries off the admin menu — קודי עיצוב,
// עיצובים and פלייבוק — and אנליטיקס folded into פרסום ומקורות as one entry
// opening one page. The pages behind the three entries STAY LIVE and reachable by
// typing their address; only the menu loses them. She also chose for those three
// to stop carrying a menu of their own, so they are now pages you leave by typing
// another address.
//
// Every case here asks the SERVER, because a spec that only read the menu would
// pass identically if the three pages had been deleted outright — which is the
// one outcome she ruled out. That is a restatement of the edit, not a test of it.
const KEY = 'dugri-admin';

// Title text is the marker: it proves the route served THAT page rather than the
// SPA fallback, which answers 200 with the landing page for anything it does not
// recognise.
const OFF_THE_MENU = [
  { path: '/design-codes.html', title: 'דוגרי · קודי עיצוב' },
  { path: '/admin-designs.html', title: 'עיצובים — דוגרי (ניהול)' },
  { path: '/admin-playbook.html', title: 'פלייבוק — דוגרי (ניהול)' },
];

test.describe('the admin menu, after the trim and the merge', () => {
  for (const { path, title } of OFF_THE_MENU) {
    test(`${path} is off the menu and still served`, async ({ page, request }) => {
      const r = await request.get(`${path}?key=${KEY}`);
      expect(r.status()).toBe(200);
      expect(await r.text()).toContain(title);

      // …and carries no menu of its own any more. Her decision, asserted rather
      // than left for a reviewer to infer from a diff.
      await page.goto(`${path}?key=${KEY}`);
      await expect(page.locator('nav#nav')).toHaveCount(0);
    });
  }

  test('the menu lists neither the three removed pages nor the old analytics page', async ({
    page,
  }) => {
    await page.goto(`/admin.html?key=${KEY}`);
    await expect(page.locator('nav#nav')).toBeVisible();
    for (const gone of [
      'design-codes.html',
      'admin-designs.html',
      'admin-playbook.html',
      'admin-analytics.html',
    ]) {
      await expect(page.locator(`nav#nav a[data-page="${gone}"]`)).toHaveCount(0);
    }
    // One entry for the merged page, in her words.
    const merged = page.locator('nav#nav a[data-page="admin-ads.html"]');
    await expect(merged).toHaveCount(1);
    await expect(merged).toHaveText('פרסום ואנליטיקס');
  });

  test('the merged page carries the ad report AND the pixel settings', async ({ page }) => {
    await page.goto(`/admin-ads.html?key=${KEY}`);
    // The report half.
    await expect(page.locator('#main')).toBeVisible();
    await expect(page.locator('#rows')).toHaveCount(1);
    // The settings half, which used to be its own page. Outside #main on purpose:
    // these are the settings she would come here to fix when the report is the
    // broken thing, so they must not be hidden with it.
    await expect(page.locator('#card-meta-pixel')).toBeVisible();
    await expect(page.getByTestId('meta-pixel-id')).toBeVisible();
    await expect(page.getByTestId('capi-state')).toBeVisible();
  });

  test('the old analytics address still works, and keeps the key', async ({ page, request }) => {
    // The redirect itself, unfollowed: 301 to the merged page with the query
    // intact. The key matters — dropping it would land her on a page that says
    // "no access key" and reads as broken.
    const r = await request.get(`/admin-analytics.html?key=${KEY}`, { maxRedirects: 0 });
    expect(r.status()).toBe(301);
    expect(r.headers()['location']).toBe(`/admin-ads.html?key=${KEY}`);

    // …and the same thing as a browser experiences it: her old bookmark opens the
    // merged page, authenticated.
    await page.goto(`/admin-analytics.html?key=${KEY}`);
    await expect(page).toHaveURL(/\/admin-ads\.html/);
    await expect(page.getByTestId('meta-pixel-id')).toBeVisible();
  });
});
