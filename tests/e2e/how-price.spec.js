import { test, expect } from '@playwright/test';

// how.html renders the store price inside its hero + sticky order CTAs as a
// struck was-price beside the current price. In this RTL layout the struck price
// must land to the LEFT of the current price.

// Pin /api/pricing so the price assertions are hermetic regardless of the shared
// e2e server's launch defaults.
async function stubPricing(page, now = 199, was = 239) {
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        store: { now, was },
        versions: {
          pdf: { enabled: false, price: 79 },
          pickup: { enabled: true, price: 199 },
          delivery: { enabled: false, price: 199 },
          custom: { enabled: false, price: 599 },
        },
      }),
    })
  );
}

test('the hero CTA struck was-price sits to the LEFT of the current price (RTL)', async ({
  page,
}) => {
  await stubPricing(page);
  await page.goto('/how.html');

  const cta = page.locator('.hero-cta a.btn').first();
  const now = cta.locator('[data-price-now]');
  const was = cta.locator('[data-price-was]');
  await expect(now).toHaveText('199 ₪');
  await expect(was).toHaveText('239 ₪');

  const nb = await now.boundingBox();
  const wb = await was.boundingBox();
  // The struck price is fully to the LEFT of the current price.
  expect(wb.x + wb.width).toBeLessThanOrEqual(nb.x + 1);
});

test('the sticky order CTA keeps the current price before the struck price in the DOM (RTL → struck left)', async ({
  page,
}) => {
  await stubPricing(page);
  await page.goto('/how.html');

  // The sticky bar is hidden on desktop viewports, so assert DOM order instead of
  // geometry: the current price must precede the struck price, so RTL lays the
  // struck price out to its LEFT.
  const order = await page.locator('#stickyOrder').evaluate((a) => {
    const now = a.querySelector('[data-price-now]');
    const was = a.querySelector('[data-price-was]');
    // DOCUMENT_POSITION_PRECEDING (0x02) is set when `now` precedes `was`.
    return was.compareDocumentPosition(now) & 0x02 ? 'now-first' : 'was-first';
  });
  expect(order).toBe('now-first');
});
