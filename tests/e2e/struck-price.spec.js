import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// ONE ₪ PER PRICE.
//
// Every sale price on this site renders as a pair: the live price and, beside
// it, the old one struck through. Both used to carry the shekel sign, so the
// buyer met "199 ₪ 239 ₪" — two signs in one glance, with the strike-through
// running straight through the second one, which reads as a broken glyph rather
// than as a discount.
//
// The rule this pins: the ₪ belongs to the price being CHARGED. A struck price
// is digits only. It is a per-page rule in practice — the six surfaces below
// each build their own price row, and four of them stamp it from
// /api/pricing — so it is worth asserting on all of them at once rather than
// trusting one page's fix to describe the others.

const VERSIONS = {
  pdf: { enabled: true, price: 79 },
  pickup: { enabled: true, price: 199 },
  delivery: { enabled: false, price: 199 },
  custom: { enabled: false, price: 599 },
};
const SALE = { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' };

async function stubPricing(page) {
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ store: { now: 199, was: 239 }, versions: VERSIONS, sale: SALE }),
    })
  );
}

// A 1x1 transparent PNG standing in for the rendered preview.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
  await stubPricing(page);
});

// The order wizard, run to the point where a collection (and its checkout)
// exists. Mirrors collect.spec's own helper — the preview render is stubbed so
// the create button's gate opens without the Python renderer.
async function createCollection(page, name) {
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      json: {
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      },
    })
  );
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click(); // design -> colour + add-ons
  await page.getByTestId('next-btn').click(); // colour + add-ons -> name
  await page.fill('#honoreeInput', name);
  await page.getByTestId('gender-female').check();
  await page.getByTestId('next-btn').click(); // name -> pawn photos
  await page.getByTestId('next-btn').click(); // pawn photos -> contact
  await page.fill('#ownerEmail', 'test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.getByTestId('next-btn').click(); // create
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
}

// The storefront pages, each named by where the buyer meets the price.
for (const [where, url] of [
  ['the home page rail', '/index.html'],
  ['the product grid', '/products.html'],
  ['the product page', '/product.html?design=bachelorette'],
  ['how-it-works', '/how.html'],
  ['the order wizard', '/options.html?plan=base'],
]) {
  test(`no struck price on ${where} carries a ₪`, async ({ page }) => {
    await page.goto(url);
    // At least one struck price must actually be on the page — otherwise this
    // test passes by finding nothing, which is exactly how a price-row rewrite
    // would slip past it.
    const struck = page.locator('.was');
    await expect.poll(async () => struck.count()).toBeGreaterThan(0);

    const texts = await struck.allTextContents();
    for (const t of texts) {
      expect(t, `a struck price on ${where} still carries a ₪`).not.toContain('₪');
      // …and it is still a price, not an emptied element.
      expect(t.trim(), `a struck price on ${where} rendered blank`).toMatch(/\d/);
    }
  });
}

// The checkout's own struck price is written by a different code path: it is the
// coupon discount, computed in collect.html rather than stamped from
// /api/pricing, so the storefront loop above says nothing about it.
test('no struck price in the checkout total carries a ₪', async ({ page }) => {
  const res = await page.request.post('/api/admin/coupons?key=dugri-admin', {
    data: { code: 'STRUCK50', discount_pct: 50, valid_until: null },
  });
  expect([201, 400]).toContain(res.status());

  await createCollection(page, 'Shira');

  await page.locator('#payPanel summary').click();
  await page.fill('#couponInput', 'STRUCK50');
  await page.click('#couponApplyBtn');

  const was = page.locator('#payWas');
  await expect(was).toBeVisible();
  await expect(was).not.toContainText('₪');
  await expect(was).toHaveText(/\d/);
  // The live total keeps its sign — this is about the struck price only.
  await expect(page.locator('.pay-total .pay-now')).toContainText('₪');
});
