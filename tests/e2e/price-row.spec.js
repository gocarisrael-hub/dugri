import { test, expect } from '@playwright/test';

// THE STRUCK PRICE MUST NEVER TOUCH THE LIVE ONE.
//
// Every storefront surface prints "199 ₪" with a struck "239" beside it. The
// owner reported the pair reading as one number — "239199" — on the home rail,
// where the struck price carried its air on the OUTSIDE (margin-inline-end in
// an RTL row) so nothing separated the two. Six pages each styled `.was`
// themselves, so the same class collided on one surface and looked fine on the
// next; css/tokens.css now owns the treatment, and these specs pin the two
// things that made it wrong: the gap, and the second ₪.
//
// Geometry, not CSS text: a spec that asserted `margin-inline-start: 9px` would
// have passed on the broken page too, because the broken page set the margin —
// on the wrong side.

const GAP = 9; // --price-gap in css/tokens.css
const TOLERANCE = 1.5; // sub-pixel layout rounding

// Pin /api/pricing so the assertions are hermetic regardless of the shared e2e
// server's launch defaults. Sale mode ON — css/tokens.css hides every struck
// price unless /api/pricing reports a live sale.
async function stubPricing(page, now = 199, was = 239) {
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        store: { now, was },
        sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
        versions: {
          pdf: { enabled: true, price: 79 },
          pickup: { enabled: true, price: 199 },
          delivery: { enabled: false, price: 199 },
          custom: { enabled: false, price: 599 },
        },
      }),
    })
  );
}

// The struck price sits to the LEFT of the live one in RTL, with real air
// between them: the live price's left edge minus the struck price's right edge.
async function gapBetween(now, was) {
  const nb = await now.boundingBox();
  const wb = await was.boundingBox();
  expect(nb, 'the live price must be laid out').toBeTruthy();
  expect(wb, 'the struck price must be laid out').toBeTruthy();
  // Struck price fully to the left of the live one.
  expect(wb.x + wb.width).toBeLessThanOrEqual(nb.x + TOLERANCE);
  return nb.x - (wb.x + wb.width);
}

test('the home rail: struck price a full gap away from the live price, digits only', async ({
  page,
}) => {
  await stubPricing(page);
  await page.goto('/');

  const price = page.locator('.home-prod-price').first();
  await expect(price.locator('.was')).toBeVisible();
  const now = price.locator('.amt');
  const was = price.locator('.was');

  await expect(now).toHaveText('199 ₪');
  // Digits only: the ₪ belongs to the price being charged.
  await expect(was).toHaveText('239');

  const gap = await gapBetween(now, was);
  expect(gap).toBeGreaterThanOrEqual(GAP - TOLERANCE);
});

test('the store grid: struck price a full gap away from the live price, digits only', async ({
  page,
}) => {
  await stubPricing(page);
  await page.goto('/products.html');

  const price = page.locator('.product-card .product-price').first();
  await expect(price.locator('.was')).toBeVisible();
  const now = price.locator('.amt');
  const was = price.locator('.was');

  await expect(now).toHaveText('199 ₪');
  await expect(was).toHaveText('239');

  // The row supplies the gap itself (--was-gap: 0), so this also proves the
  // container-gap branch of the rule.
  const gap = await gapBetween(now, was);
  expect(gap).toBeGreaterThanOrEqual(GAP - TOLERANCE);
});

test('the product page: the struck price is smaller and lighter than the price being charged', async ({
  page,
}) => {
  await stubPricing(page);
  await page.goto('/product.html?design=bachelorette');

  const was = page.locator('#pdpPriceWas');
  await expect(was).toBeVisible();
  await expect(was).toHaveText('239');

  const gap = await gapBetween(page.locator('#pdpPriceNow .amt'), was);
  expect(gap).toBeGreaterThanOrEqual(GAP - TOLERANCE);

  // Hierarchy: the struck price must never compete with the live one. The PDP
  // keeps its own 18px override against a 34px live price, so assert the
  // relationship rather than the number.
  const [nowSize, wasSize, wasWeight] = await page.evaluate(() => {
    const px = (el) => parseFloat(getComputedStyle(el).fontSize);
    const wasEl = document.getElementById('pdpPriceWas');
    return [
      px(document.querySelector('#pdpPriceNow .amt')),
      px(wasEl),
      Number(getComputedStyle(wasEl).fontWeight),
    ];
  });
  expect(wasSize).toBeLessThan(nowSize);
  expect(wasWeight).toBeLessThanOrEqual(500);
});

test('no surface repeats the ₪ on the struck price', async ({ page }) => {
  await stubPricing(page);
  for (const url of ['/', '/products.html', '/how.html', '/options.html?plan=base']) {
    await page.goto(url);
    // Wait for sale mode to resolve: until /api/pricing answers, css/tokens.css
    // keeps every struck price `visibility: hidden` (holding its space), so
    // reading straight after goto finds nothing and proves nothing.
    await expect(page.locator('.was:visible').first()).toBeVisible();
    // Every struck price that has resolved on the page is bare digits.
    const texts = await page.locator('.was:visible').allTextContents();
    expect(texts.length, `${url} shows at least one struck price`).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t.trim(), `struck price on ${url}`).toMatch(/^\d+$/);
    }
  }
});
