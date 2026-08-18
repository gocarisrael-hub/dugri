import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// EVERY PRICE CARRIES ITS OWN ₪.
//
// Every sale price on this site renders as a pair: the live price and, beside
// it, the old one struck through. This spec used to pin the opposite rule —
// struck prices were digits only, on the reasoning that one sign per row reads
// cleaner. The owner overruled it: a bare number beside a signed one doesn't
// read as a price at all, so BOTH carry the ₪.
//
// That is the arrangement bidi handles worst — two signs, two numbers, one RTL
// row — which is why the pixel checks below matter more than the text ones. It
// is a per-page rule in practice: the six surfaces each build their own price
// row, and four of them stamp it from /api/pricing, so it is worth asserting on
// all of them at once rather than trusting one page's fix to describe the rest.

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
  await page.fill('#customTitleInput', name);
  await page.getByTestId('next-btn').click(); // name -> pawn photos
  await page.getByTestId('next-btn').click(); // pawn photos -> contact
  await page.fill('#ownerEmail', 'test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  // The orderer's name is required on this step now ("make it must to write") —
  // without it the create button never enables. The rule itself is tested in
  // order-buyer-details.spec.js; here it is just part of getting to an order.
  await page.fill('#buyerNameInput', 'דנה כהן');
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
  test(`every struck price on ${where} carries its own ₪`, async ({ page }) => {
    await page.goto(url);
    // At least one struck price must actually be on the page — otherwise this
    // test passes by finding nothing, which is exactly how a price-row rewrite
    // would slip past it.
    const struck = page.locator('.was');
    await expect.poll(async () => struck.count()).toBeGreaterThan(0);

    // Polled: four of these surfaces re-stamp the row once /api/pricing lands.
    await expect
      .poll(async () => await struck.allTextContents(), {
        message: `every struck price on ${where} must read "<digits> ₪"`,
      })
      // Digits, a space, one sign — and nothing rendered blank.
      .toEqual(expect.arrayContaining([expect.stringMatching(/^\s*\d+ ₪\s*$/)]));
    for (const t of await struck.allTextContents()) {
      expect(t.trim(), `a struck price on ${where} is malformed`).toMatch(/^\d+ ₪$/);
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
// right, with struck characters in brackets. Each amount must come out whole,
// its own sign at its right-hand (reading) end — `[239₪]199₪` — rather than the
// two signs pooling between or past the numbers.
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
      // The struck amount first, sign included and bracketed with it, then the
      // live amount with its own sign last.
      .toMatch(/^(\[\d\])+\[₪\]\d+₪$/);
  });
}

// The checkout's own struck price is written by a different code path: it is the
// coupon discount, computed in collect.html rather than stamped from
// /api/pricing, so the storefront loop above says nothing about it.
test('the checkout total signs both prices, each with its own ₪', async ({ page }) => {
  const res = await page.request.post('/api/admin/coupons?key=dugri-admin', {
    data: { code: 'STRUCK50', discount_pct: 50, valid_until: null },
  });
  expect([201, 400]).toContain(res.status());

  await createCollection(page, 'Shira');

  // The checkout is on the תשלום tab; WAIT for the strip rather than assuming it
  // has rendered — it appears when the owner's state lands.
  await page.getByTestId('tab-pay').waitFor({ state: 'visible' });
  await page.getByTestId('tab-pay').click();
  await page.locator('#payPanel > summary').click();
  await page.fill('#couponInput', 'STRUCK50');
  await page.click('#couponApplyBtn');

  const was = page.locator('#payWas');
  await expect(was).toBeVisible();
  await expect(was).toHaveText(/^\d+ ₪$/);
  await expect(page.locator('.pay-total .pay-now')).toContainText('₪');
  // …and the same pixel rule as the storefront: struck price, then the live
  // amount, then its ₪. This row is where the reordering was worst, because the
  // struck price sits between the total and the Hebrew "לתשלום:" before it.
  await expect
    .poll(async () => glyphOrder(page, '.pay-total'), {
      message: 'each price in the checkout total must end in its own ₪',
    })
    .toMatch(/^(\[\d\])+\[₪\]\d+₪$/);
});
