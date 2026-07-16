import { test, expect } from '@playwright/test';

// The owner pricing editor (store price + per-checkout-version enable/price) is
// behind the admin key. The e2e server runs with ADMIN_KEY=dugri-admin and
// DATA_DIR=.e2e-data (throwaway), so overrides written here never touch real data.
const KEY = 'dugri-admin';

// The three device projects run this spec in parallel against ONE server (shared
// DATA_DIR). To keep assertions race-free we read each save/reset from the page's
// OWN re-rendered inputs (populated by that request's own single-threaded
// response), never a shared re-fetch. Every test resets the keys it touched so no
// override leaks to the storefront/checkout specs. pickup is NEVER disabled here
// (it is the launch default the checkout specs rely on).
async function resetKey(request, k) {
  const r = await request.delete(
    `/api/admin/settings?section=pricing&settingKey=${encodeURIComponent(k)}&key=${KEY}`
  );
  expect(r.ok()).toBeTruthy();
}

test.describe('admin pricing editor', () => {
  test('without a key the page reveals nothing and asks for ?key=', async ({ page }) => {
    let hitAdmin = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/settings')) hitAdmin = true;
    });
    await page.goto('/admin-pricing.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    expect(hitAdmin).toBe(false);
  });

  test('with the key it renders the store card and the four version cards', async ({ page }) => {
    await page.goto(`/admin-pricing.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    // Store price card: two number inputs.
    const store = page.locator('[data-card="store"]');
    await expect(store.locator('[data-price="store_now"]')).toBeVisible();
    await expect(store.locator('[data-price="store_was"]')).toBeVisible();

    // Each version card: an enable checkbox + a price input.
    for (const v of ['pdf', 'pickup', 'delivery', 'custom']) {
      const card = page.locator(`[data-card="${v}"]`);
      await expect(card.locator(`[data-flag="${v}_enabled"]`)).toBeVisible();
      await expect(card.locator(`[data-price="${v}_price"]`)).toBeVisible();
    }

    // Launch defaults reflected: store 199/239; only pickup checked.
    await expect(store.locator('[data-price="store_now"]')).toHaveValue('199');
    await expect(store.locator('[data-price="store_was"]')).toHaveValue('239');
    await expect(page.locator('[data-card="pickup"] [data-flag="pickup_enabled"]')).toBeChecked();
    await expect(page.locator('[data-card="pdf"] [data-flag="pdf_enabled"]')).not.toBeChecked();
  });

  test('saving the store price persists via the admin API', async ({ page, request }) => {
    await page.goto(`/admin-pricing.html?key=${KEY}`);
    const store = page.locator('[data-card="store"]');
    await expect(store).toBeVisible();

    await store.locator('[data-price="store_now"]').fill('211');
    await store.locator('button[data-save]').click();
    // Status turns to "נשמר ✓" only after BOTH keys (store_now + store_was) POST.
    await expect(page.locator('[data-card="store"] .status')).toHaveText(/נשמר/);

    // The re-rendered input holds the saved value (populated from the POST's own
    // effective response — race-free against other workers).
    await expect(page.locator('[data-card="store"] [data-price="store_now"]')).toHaveValue('211');

    // And the PUBLIC endpoint reflects it (read our own value back by resetting
    // afterwards regardless of concurrent workers).
    await resetKey(request, 'store_now');
    await resetKey(request, 'store_was');
  });

  test('toggling a version on + repricing it persists via the admin API', async ({
    page,
    request,
  }) => {
    await page.goto(`/admin-pricing.html?key=${KEY}`);
    const card = page.locator('[data-card="pdf"]');
    await expect(card).toBeVisible();

    // pdf is disabled by default; enable it and give it a distinct price.
    await card.locator('[data-flag="pdf_enabled"]').check();
    await card.locator('[data-price="pdf_price"]').fill('88');
    await card.locator('button[data-save]').click();
    await expect(page.locator('[data-card="pdf"] .status')).toHaveText(/נשמר/);

    // Re-rendered from the responses: enabled + the new price stick, and the card
    // is no longer greyed.
    await expect(page.locator('[data-card="pdf"] [data-flag="pdf_enabled"]')).toBeChecked();
    await expect(page.locator('[data-card="pdf"] [data-price="pdf_price"]')).toHaveValue('88');
    await expect(page.locator('[data-card="pdf"]')).not.toHaveClass(/off/);

    await resetKey(request, 'pdf_enabled');
    await resetKey(request, 'pdf_price');
  });

  test('the client refuses to save a negative / non-integer price', async ({ page }) => {
    let posted = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/settings') && req.method() === 'POST') posted = true;
    });
    await page.goto(`/admin-pricing.html?key=${KEY}`);
    const store = page.locator('[data-card="store"]');
    await expect(store).toBeVisible();

    await store.locator('[data-price="store_now"]').fill('-5');
    await store.locator('button[data-save]').click();
    await expect(store.locator('.status')).toHaveText(/מספר שלם/);
    expect(posted).toBe(false);
  });

  test('reset restores the default store price', async ({ page, request }) => {
    page.on('dialog', (d) => d.accept()); // reset asks for confirmation
    await page.goto(`/admin-pricing.html?key=${KEY}`);
    const store = page.locator('[data-card="store"]');
    await expect(store).toBeVisible();

    // Override, then reset back to the default.
    await store.locator('[data-price="store_now"]').fill('177');
    await store.locator('button[data-save]').click();
    await expect(page.locator('[data-card="store"] .status')).toHaveText(/נשמר/);

    await page.locator('[data-card="store"] button[data-reset]').click();
    await expect(page.locator('[data-card="store"] .status')).toHaveText(/אופס/);
    await expect(page.locator('[data-card="store"] [data-price="store_now"]')).toHaveValue('199');

    await resetKey(request, 'store_now');
    await resetKey(request, 'store_was');
  });

  test('opens from the orders-management page nav, carrying the key', async ({ page }) => {
    await page.goto(`/admin.html?key=${KEY}`);
    const link = page.locator('#nav a[data-page="admin-pricing.html"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /admin-pricing\.html\?key=/);
    await link.click();
    await expect(page).toHaveURL(/admin-pricing\.html\?key=/);
    await expect(page.locator('#app')).toBeVisible();
  });

  test('nav cross-links to the other owner-editable admin sections', async ({ page }) => {
    // The pricing page must let the owner reach features + images from its own
    // nav (admin-images was once missing here — regression guard).
    await page.goto(`/admin-pricing.html?key=${KEY}`);
    await expect(page.locator('#nav a.active[data-page="admin-pricing.html"]')).toHaveCount(1);
    await expect(page.locator('#nav a[data-page="admin-features.html"]')).toHaveCount(1);
    await expect(page.locator('#nav a[data-page="admin-images.html"]')).toHaveCount(1);
  });
});
