import { test, expect } from '@playwright/test';

// Sale mode across the storefront: ONE owner switch (/api/pricing `sale`) that
// every surface reads, so ending a sale is one click rather than a hunt through
// six pages for the piece each one carries.
//
// What must hold, and why each half matters:
//   ON  — the struck was-price, the corner flag over each product picture, and
//         the home strip all appear, carrying the owner's own text.
//   OFF — all three are GONE. Not faded, not still in the layout: a struck price
//         left behind after a sale ends advertises a discount the buyer will not
//         get, which is the failure this feature exists to prevent.
//
// The pre-resolve state is asserted too (a page loaded while /api/pricing is
// still in flight): the struck price must not flash up and then be taken away.

const VERSIONS = {
  pdf: { enabled: false, price: 79 },
  pickup: { enabled: true, price: 199 },
  delivery: { enabled: false, price: 199 },
  custom: { enabled: false, price: 599 },
};

async function stubPricing(page, sale) {
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ store: { now: 199, was: 239 }, versions: VERSIONS, sale }),
    })
  );
}
const ON = { on: true, label: 'מחיר השקה', banner: 'מחיר השקה · 199 ₪ במקום 239 ₪' };
const OFF = { on: false, label: 'מחיר השקה', banner: '' };

// The grid ships 6 built-in cards; a custom design would add more. Stub it out
// so counts stay deterministic (same posture as products.spec).
test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

test.describe('sale ON', () => {
  test('the home page shows the strip, and the rail cards carry the flag + struck price', async ({
    page,
  }) => {
    await stubPricing(page, ON);
    await page.goto('/index.html');

    const banner = page.getByTestId('sale-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText('מחיר השקה · 199 ₪ במקום 239 ₪');

    // The rail is built from the catalog, then re-stamped when pricing resolves.
    const card = page.locator('.home-prod-card').first();
    await expect(card.locator('.sale-flag')).toBeVisible();
    await expect(card.locator('.sale-flag')).toHaveText('מחיר השקה');
    await expect(card.locator('.home-prod-price s.was')).toBeVisible();
    await expect(card.locator('.home-prod-price s.was')).toHaveText('239 ₪');
  });

  test('the store grid shows a flag on each card and the struck price under it', async ({
    page,
  }) => {
    await stubPricing(page, ON);
    await page.goto('/products.html');

    const card = page.getByTestId('product-card').first();
    await expect(card.locator('.sale-flag')).toBeVisible();
    await expect(card.locator('.product-price s.was')).toBeVisible();
    await expect(card.locator('.product-price s.was')).toHaveText('239 ₪');
  });

  test('the product page shows the flag over the gallery and the struck price', async ({
    page,
  }) => {
    await stubPricing(page, ON);
    await page.goto('/product.html?design=bachelorette');

    await expect(page.getByTestId('sale-flag')).toBeVisible();
    await expect(page.locator('#pdpPriceWas')).toBeVisible();
    await expect(page.locator('#pdpPriceWas')).toHaveText('239 ₪');
  });

  test("the owner's own label text reaches every flag", async ({ page }) => {
    await stubPricing(page, { on: true, label: 'מבצע קיץ', banner: '' });
    await page.goto('/products.html');

    await expect(page.locator('.sale-flag').first()).toHaveText('מבצע קיץ');
    // An empty banner is the owner dropping the strip while keeping the sale —
    // the flags stay, the strip does not appear (the home page owns the strip;
    // here we simply confirm the sale is live without one).
    await expect(page.getByTestId('product-card').first().locator('s.was')).toBeVisible();
  });
});

test.describe('sale OFF', () => {
  test('the home page has no strip, no flags and no struck price', async ({ page }) => {
    await stubPricing(page, OFF);
    await page.goto('/index.html');

    await expect(page.getByTestId('sale-banner')).toBeHidden();
    const card = page.locator('.home-prod-card').first();
    await expect(card.locator('.sale-flag')).toBeHidden();
    await expect(card.locator('.home-prod-price s.was')).toBeHidden();
    // The live price is still there — only the offer went away.
    await expect(card.locator('.home-prod-price')).toContainText('199 ₪');
  });

  test('the store grid keeps the price and drops the offer', async ({ page }) => {
    await stubPricing(page, OFF);
    await page.goto('/products.html');

    const card = page.getByTestId('product-card').first();
    await expect(card.locator('.sale-flag')).toBeHidden();
    await expect(card.locator('.product-price s.was')).toBeHidden();
    await expect(card.locator('.product-price .now')).toHaveText('מ-199 ₪');
  });

  test('the product page keeps the price and drops the offer', async ({ page }) => {
    await stubPricing(page, OFF);
    await page.goto('/product.html?design=bachelorette');

    await expect(page.getByTestId('sale-flag')).toBeHidden();
    await expect(page.locator('#pdpPriceWas')).toBeHidden();
    await expect(page.locator('#pdpPriceNow')).toHaveText('מ-199 ₪');
  });

  test('the struck price is REMOVED from the layout, not just made invisible', async ({ page }) => {
    // display:none, not visibility:hidden — the price row has to close up around
    // the single live price, or the sale leaves a gap where it used to be.
    await stubPricing(page, OFF);
    await page.goto('/product.html?design=bachelorette');

    await expect(page.locator('#pdpPriceNow')).toBeVisible();
    expect(await page.locator('#pdpPriceWas').boundingBox()).toBeNull();
  });
});

test('while /api/pricing is still in flight, no struck price is shown', async ({ page }) => {
  // A shopper must never see a discount flash up and then be taken away — and,
  // worse, never see one that has already ended. The struck price ships hidden
  // and only appears once the server confirms a live sale.
  let release;
  const held = new Promise((r) => (release = r));
  await page.route('**/api/pricing', async (route) => {
    await held;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ store: { now: 199, was: 239 }, versions: VERSIONS, sale: ON }),
    });
  });

  await page.goto('/product.html?design=bachelorette');
  // The page is up and priced from its seeded default…
  await expect(page.locator('#pdpPriceNow')).toBeVisible();
  // …but nothing claims a discount yet.
  await expect(page.locator('#pdpPriceWas')).toBeHidden();
  await expect(page.getByTestId('sale-flag')).toBeHidden();

  release();
  await expect(page.locator('#pdpPriceWas')).toBeVisible();
  await expect(page.getByTestId('sale-flag')).toBeVisible();
});

test('a failing /api/pricing shows no sale (never claim a discount we could not read)', async ({
  page,
}) => {
  await page.route('**/api/pricing', (route) => route.fulfill({ status: 500, body: '' }));
  await page.goto('/product.html?design=bachelorette');

  await expect(page.locator('#pdpPriceNow')).toBeVisible();
  await expect(page.locator('#pdpPriceWas')).toBeHidden();
  await expect(page.getByTestId('sale-flag')).toBeHidden();
});
