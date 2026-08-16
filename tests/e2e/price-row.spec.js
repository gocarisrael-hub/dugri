import { test, expect } from '@playwright/test';

// THE STRUCK PRICE MUST NEVER TOUCH THE LIVE ONE.
//
// Every storefront surface prints "199 ₪" with a struck "239 ₪" beside it. The
// owner reported the pair reading as one number — "239199" — on the home rail,
// where the struck price carried its air on the OUTSIDE (margin-inline-end in
// an RTL row) so nothing separated the two. Six pages each styled `.was`
// themselves, so the same class collided on one surface and looked fine on the
// next; css/tokens.css now owns the treatment.
//
// BOTH prices carry a ₪ (the owner's call), which is exactly the arrangement
// bidi gets wrong: two signs, two numbers, one RTL row. That half of the rule —
// every price signed, every sign welded to its own digits, on all six surfaces —
// is pinned in tests/e2e/struck-price.spec.js. THIS file owns the spacing and
// the hierarchy: the gap between the two prices, and the struck one staying
// quieter than the price being charged.
//
// Geometry, not CSS text: a spec that asserted `margin-inline-start: 9px` would
// have passed on the broken page too, because the broken page set the margin —
// on the wrong side.

const GAP = 14; // --price-gap in css/tokens.css
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
// Returns -Infinity while the pair is mis-ordered, so the polled assertion below
// covers both facts with one number.
async function gapBetween(now, was) {
  const nb = await now.boundingBox();
  const wb = await was.boundingBox();
  if (!nb || !wb) return null; // not laid out yet
  // Struck price must be fully to the left of the live one.
  if (wb.x + wb.width > nb.x + TOLERANCE) return -Infinity;
  return nb.x - (wb.x + wb.width);
}

// POLLED, not read once: these rows are re-stamped when /api/pricing resolves,
// and the home rail is inside a carousel that can still be settling. A one-shot
// boundingBox measured a frame too early is the classic way a real assertion
// turns into an intermittent red.
async function expectGap(now, was, where) {
  await expect
    .poll(async () => await gapBetween(now, was), {
      message: `${where}: the struck price must sit left of the live one, ${GAP}px clear`,
    })
    .toBeGreaterThanOrEqual(GAP - TOLERANCE);
}

test('the home rail: struck price a full gap away from the live price, both signed', async ({
  page,
}) => {
  await stubPricing(page);
  await page.goto('/');

  const price = page.locator('.home-prod-price').first();
  await expect(price.locator('.was')).toBeVisible();
  // `> .amt` — the struck price now holds an .amt of its own.
  const now = price.locator('> .amt');
  const was = price.locator('.was');

  await expect(now).toHaveText('199 ₪');
  // Signed, like the price beside it — and no "מ-" opener on either.
  await expect(was).toHaveText('239 ₪');

  await expectGap(now, was, 'the home rail');
});

test('the store grid: struck price a full gap away from the live price, no "from" opener', async ({
  page,
}) => {
  await stubPricing(page);
  await page.goto('/products.html');

  const price = page.locator('.product-card .product-price').first();
  await expect(price.locator('.was')).toBeVisible();
  const now = price.locator('.now');
  const was = price.locator('.was');

  // The live price stands alone: no "מ-" ("from") in front of the number.
  await expect(now).toHaveText('199 ₪');
  await expect(was).toHaveText('239 ₪');

  // The row supplies the gap itself (--was-gap: 0), so this also proves the
  // container-gap branch of the rule.
  await expectGap(now, was, 'the store grid');
});

test('the product page: the struck price is smaller and lighter than the price being charged', async ({
  page,
}) => {
  await stubPricing(page);
  await page.goto('/product.html?design=bachelorette');

  const was = page.locator('#pdpPriceWas');
  await expect(was).toBeVisible();
  await expect(was).toHaveText('239 ₪');
  await expect(page.locator('#pdpPriceNow')).toHaveText('199 ₪');

  await expectGap(page.locator('#pdpPriceNow .amt'), was, 'the product page');

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
