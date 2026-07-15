import { test, expect } from '@playwright/test';

// An admin "rename template" edits generator/themes.json display_he; GET
// /api/design-names maps that onto orderable design ids so the storefront shows
// the new name. These specs STUB /api/design-names (rather than actually renaming
// the shared fixture themes.json, which the admin-templates spec mutates in
// parallel) to assert the storefront applies the returned name — and, critically,
// falls back to the built-in catalog name when the endpoint fails, never blanking
// or blocking a page.

const CUSTOM = 'עיצוב מותאם בדיקה';

function stubNames(page, names) {
  return page.route('**/api/design-names', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ names }),
    })
  );
}

test.describe('design-name propagation to the storefront', () => {
  test('products.html shows the renamed name on the matching card, built-in on the rest', async ({
    page,
  }) => {
    await stubNames(page, { bachelorette: CUSTOM });
    await page.goto('/products.html');

    const bach = page.locator('.product-card[data-design-id="bachelorette"] .product-name');
    await expect(bach).toHaveText(CUSTOM);
    // aria-label + image alt are upgraded too.
    await expect(
      page.locator('.product-card[data-design-id="bachelorette"] [data-testid="product-link"]')
    ).toHaveAttribute('aria-label', CUSTOM);

    // A design the map omits keeps its non-empty built-in name.
    const marriage = page.locator('.product-card[data-design-id="marriage"] .product-name');
    await expect(marriage).not.toHaveText('');
    await expect(marriage).not.toHaveText(CUSTOM);
  });

  test('the product page title + tab reflect the renamed name', async ({ page }) => {
    await stubNames(page, { bachelorette: CUSTOM });
    await page.goto('/product.html?design=bachelorette');

    await expect(page.locator('#pdpTitle')).toHaveText(CUSTOM);
    await expect(page).toHaveTitle(new RegExp(CUSTOM));
    // Related-rail card for the same design is upgraded as well.
    await expect(
      page.locator('.pdp-rel-card[data-design-id="bachelorette"] .pdp-rel-name')
    ).toHaveText(CUSTOM);
  });

  test('a failed /api/design-names falls back to the built-in name and still renders', async ({
    page,
  }) => {
    // Simulate a dropped request; fetchDesignNames must resolve to {} and the page
    // must keep its built-in names without blanking or hanging.
    await page.route('**/api/design-names', (route) => route.abort());

    await page.goto('/products.html');
    await expect(page.getByTestId('product-card')).toHaveCount(7);
    const bach = page.locator('.product-card[data-design-id="bachelorette"] .product-name');
    await expect(bach).not.toHaveText('');
    await expect(bach).not.toHaveText(CUSTOM);

    await page.goto('/product.html?design=bachelorette');
    await expect(page.locator('#pdpTitle')).not.toHaveText('');
    await expect(page.locator('#pdpTitle')).not.toHaveText(CUSTOM);
  });

  test('the live endpoint returns a names object and leaks no other theme field', async ({
    request,
  }) => {
    const res = await request.get('/api/design-names');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body && typeof body.names).toBe('object');
    // Names are non-empty strings; no theme internals (slug/fonts/wordlist) leak.
    for (const v of Object.values(body.names)) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('slug');
    expect(raw).not.toContain('title_font');
    expect(raw).not.toContain('wordlist');
  });
});
