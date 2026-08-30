import { test, expect } from '@playwright/test';

// The owner pastes a Meta pixel id in the admin and the storefront starts
// carrying it — no deploy, no restart. The e2e server runs with
// ADMIN_KEY=dugri-admin and a throwaway DATA_DIR, so the override written here
// never touches real data.
const KEY = 'dugri-admin';
const ID = '1234567890123456';

// This spec WRITES the shared live settings store, which both device projects
// share through one server. It asserts wiring, not layout, so run it on ONE
// project. The guard is a describe-level skip rather than a beforeEach one:
// afterEach hooks still run for a test skipped from beforeEach, so a beforeEach
// guard would have let the iPhone worker fire DELETEs at the shared store while
// the Desktop worker was mid-test — clearing the pixel between a save and the
// assertion that reads it back.
// The one project allowed to touch the shared store.
const OWNS_STORE = 'Desktop Chrome';

async function clearPixel(request) {
  const r = await request.delete(
    `/api/admin/settings?section=analytics&settingKey=meta_pixel_id&key=${KEY}`
  );
  expect(r.ok()).toBeTruthy();
}

test.describe('meta pixel, end to end', () => {
  // Cleared BEFORE as well as after. .e2e-data survives between local runs, so a
  // run that died mid-test would otherwise leave the id set and fail the
  // "nothing is served before she sets one" assertions on every run after it,
  // for a reason that has nothing to do with the code.
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(
      testInfo.project.name !== OWNS_STORE,
      'writes the shared settings store; run once to avoid cross-worker races'
    );
    await clearPixel(request);
  });
  // afterEach STILL RUNS for a test skipped from beforeEach, so it has to make
  // the same check itself. Without it the other project's worker fires DELETEs
  // at the shared store while this one is mid-test — clearing the pixel between
  // a save and the assertion that reads it back, which reads as a load-flake.
  test.afterEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== OWNS_STORE) return;
    await clearPixel(request);
  });

  test('without a key the page reveals nothing and calls no admin API', async ({ page }) => {
    let hitAdmin = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/settings')) hitAdmin = true;
    });
    await page.goto('/admin-analytics.html');
    await expect(page.locator('#noKey')).toBeVisible();
    expect(hitAdmin).toBe(false);
  });

  test('saving an id in the admin puts the pixel on the storefront', async ({ page, request }) => {
    // Nothing is served before she sets one — the state the site ships in.
    const before = await (await request.get('/products.html')).text();
    expect(before).not.toContain('fbq(');

    await page.goto(`/admin-analytics.html?key=${KEY}`);
    const field = page.getByTestId('meta-pixel-id');
    await expect(field).toBeVisible();
    await field.fill(ID);
    await page.getByTestId('save-pixel').click();
    await expect(page.locator('.status')).toHaveText(/הפיקסל פעיל/);

    // The shop page — which carried no measurement at all — now serves it,
    // and it queues a PageView in the browser without contacting Meta
    // (the loader is skipped on localhost).
    const shop = await (await request.get('/products.html')).text();
    expect(shop).toContain(`fbq('init', '${ID}')`);

    await page.goto('/products.html');
    const queued = await page.evaluate(() =>
      (window.fbq && window.fbq.queue ? window.fbq.queue : []).map((a) => Array.from(a))
    );
    expect(queued.some((e) => e[0] === 'track' && e[1] === 'PageView')).toBe(true);
    const loaded = await page.evaluate(() =>
      [...document.scripts].some((s) => s.src.includes('connect.facebook.net'))
    );
    expect(loaded).toBe(false);
  });

  test('a campaign landing path that is not a file still carries the pixel', async ({
    page,
    request,
  }) => {
    await page.goto(`/admin-analytics.html?key=${KEY}`);
    await page.getByTestId('meta-pixel-id').fill(ID);
    await page.getByTestId('save-pixel').click();
    await expect(page.locator('.status')).toHaveText(/הפיקסל פעיל/);

    // An extension-less path with no page behind it falls through to the
    // navigation fallback, which serves the home page. That is exactly the shape
    // of a vanity link in a bio or a mistyped ad destination — the traffic this
    // feature exists to measure — so the fallback must be pixelled too.
    const r = await request.get('/sale');
    expect(r.status()).toBe(200);
    expect(await r.text()).toContain(`fbq('init', '${ID}')`);
  });

  test('the admin pages themselves are never pixelled', async ({ page, request }) => {
    await page.goto(`/admin-analytics.html?key=${KEY}`);
    await page.getByTestId('meta-pixel-id').fill(ID);
    await page.getByTestId('save-pixel').click();
    await expect(page.locator('.status')).toHaveText(/הפיקסל פעיל/);

    for (const p of ['/admin.html', '/dashboard.html', '/admin-analytics.html']) {
      expect(await (await request.get(p)).text()).not.toContain('fbq(');
    }
  });

  test('a bad paste is refused with the reason, and nothing is served', async ({
    page,
    request,
  }) => {
    await page.goto(`/admin-analytics.html?key=${KEY}`);
    await page.getByTestId('meta-pixel-id').fill('my-pixel');
    await page.getByTestId('save-pixel').click();
    await expect(page.locator('.status')).toHaveClass(/err/);
    expect(await (await request.get('/products.html')).text()).not.toContain('fbq(');
  });

  test('a completed order reports a Purchase to Meta with its value', async ({ page, request }) => {
    await page.goto(`/admin-analytics.html?key=${KEY}`);
    await page.getByTestId('meta-pixel-id').fill(ID);
    await page.getByTestId('save-pixel').click();
    await expect(page.locator('.status')).toHaveText(/הפיקסל פעיל/);

    await page.route('**/api/collections/**/summary**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          order_no: 'DG-2001',
          honoree_name: 'שירה',
          design: 'bachelorette',
          product_image: null,
          preview: null,
          order: {
            version_label: 'החבילה המלאה',
            total: 238,
            quantity: 1,
            unit_price: 199,
            delivery_fee: 39,
            charged: 238,
            coupon: null,
            paid: true,
          },
        }),
      })
    );
    await page.goto('/pay-success.html?c=abc&k=tok');
    await expect(page.locator('#orderNoVal')).toHaveText('DG-2001');

    const queued = await page.evaluate(() =>
      (window.fbq && window.fbq.queue ? window.fbq.queue : []).map((a) => Array.from(a))
    );
    const purchase = queued.find((e) => e[0] === 'track' && e[1] === 'Purchase');
    expect(purchase).toBeTruthy();
    expect(purchase[2]).toEqual({ value: 238, currency: 'ILS' });

    // Left for the request that follows — the storefront must not keep it after
    // afterEach clears the setting.
    expect(await (await request.get('/index.html')).text()).toContain('fbq(');
  });
});
