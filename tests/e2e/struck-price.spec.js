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
  ['how-it-works', '/how.html', '.hero-cta a.btn'],
  ['the order wizard', '/options.html?plan=base', '[data-testid="plan-pill"]'],
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

// WHERE THE ₪ ACTUALLY LANDS ON SCREEN.
//
// The rule above ("no ₪ in the struck price") is about the DOM; this one is
// about pixels, and only pixels can catch the bug the owner reported. The sign
// was in the right element the whole time — bidi moved it, so the page read
// "₪ 239 199" with the shekel torn off its number and parked past the struck
// price. No assertion on text content can see that.
//
// So: walk the price row's text nodes, ask the browser for each digit's and each
// ₪'s x-position, and sort by it. That yields what a reader's eye meets, left to
// right, with struck characters in brackets. The row must end in `<digits>₪` —
// the amount whole, its sign at the right-hand (reading) end.
const GLYPH_ORDER = `(() => {
  const row = document.querySelector(SEL);
  if (!row) return 'NO ROW';
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3 && n.textContent.trim()) {
      const r = document.createRange();
      for (let i = 0; i < n.textContent.length; i++) {
        const ch = n.textContent[i];
        if (!/[0-9₪]/.test(ch)) continue;
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        out.push({
          ch,
          x: Math.round(r.getBoundingClientRect().left),
          struck: !!n.parentElement.closest('.was'),
        });
      }
    }
    n.childNodes.forEach(walk);
  };
  walk(row);
  out.sort((a, b) => a.x - b.x);
  return out.map((o) => (o.struck ? '[' + o.ch + ']' : o.ch)).join('');
})()`;
const glyphOrder = (page, sel) => page.evaluate(GLYPH_ORDER.replace('SEL', JSON.stringify(sel)));

for (const [where, url, sel] of [
  ['the home page rail', '/index.html', '.home-prod-price'],
  ['the product grid', '/products.html', '.product-price'],
  ['the product page', '/product.html?design=bachelorette', '.pdp-price'],
  ['how-it-works', '/how.html', '.hero-cta a.btn'],
  ['the order wizard', '/options.html?plan=base', '[data-testid="plan-pill"]'],
]) {
  test(`the ₪ sits at the right-hand end of the price on ${where}`, async ({ page }) => {
    await page.goto(url);
    await expect.poll(async () => page.locator(sel).count()).toBeGreaterThan(0);
    // Polled: the row is re-stamped once /api/pricing resolves, and reading a
    // frame early measures the seeded default rather than the live price.
    await expect
      .poll(async () => glyphOrder(page, sel), {
        message: `on ${where} the ₪ must end the live price, after its own digits`,
      })
      // struck digits first (each bracketed), then the live amount, sign last.
      .toMatch(/^(\[\d\])+\d+₪$/);
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
  // …and the same pixel rule as the storefront: struck price, then the live
  // amount, then its ₪. This row is where the reordering was worst, because the
  // struck price sits between the total and the Hebrew "לתשלום:" before it.
  await expect
    .poll(async () => glyphOrder(page, '.pay-total'), {
      message: 'the ₪ must end the checkout total, after its own digits',
    })
    .toMatch(/^(\[\d\])+\d+₪$/);
});
