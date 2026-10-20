// Commerce's pages in redesign mode (site/css/rd/{pickup,pay-success,pay-done,partner,coupons}.css, and A's sections of
// the shared files: product.css (the buy box) and collect.css (the checkout)): each one gets
// its restyle, nothing scrolls sideways at a phone or desktop width, what a page hides stays hidden (a shell class sets
// display, which would otherwise outrank the hidden attribute), and the money steps on them still work in the mode.
// Outside the mode none of these files is linked; that half is the gate's own test (redesign-gate).
import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';
import { openCheckout } from './helpers/checkout.js';

const KEY = 'dugri-admin';
// The time alone can repeat: two projects run the same test in parallel, and a code made twice is a 409.
const uniq = (p) =>
  p +
  Date.now().toString(36).toUpperCase().slice(-6) +
  Math.random().toString(36).slice(2, 5).toUpperCase();

// Writes coupons, which other specs read: one project only, like partner-coupons.spec.js.
const ONLY = 'Desktop Chrome';

const SUMMARY = {
  order_no: 'DG-1042',
  honoree_name: 'שירה',
  design: 'bachelorette',
  color: null,
  product_image: null,
  order: {
    version: 'base',
    version_label: 'החבילה המלאה',
    description: null,
    total: 437,
    quantity: 2,
    unit_price: 199,
    delivery_fee: 39,
    charged: 437,
    coupon: null,
    paid: true,
  },
  preview: null,
};
const mockSummary = (page) =>
  page.route('**/api/collections/**/summary**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUMMARY) })
  );

async function makePartner(request, code) {
  const r = await request.post(`/api/admin/coupons?key=${KEY}`, {
    data: {
      code,
      discount_pct: 15,
      partner_name: 'נועה',
      commission_type: 'fixed',
      commission_value: 30,
    },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).coupon;
}

async function noSidewaysScroll(page, label) {
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(m.sw, label + ': the page scrolls sideways').toBeLessThanOrEqual(m.cw);
}

test.beforeEach(({ page }) => previewRedesign(page));

test('each page is in the mode with its own restyle, and nothing scrolls sideways at 360, 390 or 1440', async ({
  page,
  request,
}) => {
  await mockSummary(page);
  const partner = await makePartner(request, uniq('RDW'));
  const pages = [
    ['product', '/product.html?design=bachelorette'],
    ['pickup', '/pickup.html'],
    ['pay-success', '/pay-success.html?c=abc&k=tok'],
    ['pay-done', '/pay-done.html?error=1'],
    ['partner', `/partner.html?t=${partner.report_token}`],
    ['coupons', `/coupons.html?key=${KEY}`],
  ];
  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, url] of pages) {
      await page.goto(url);
      await expect(page.locator('html')).toHaveClass(/(^|\s)rd(\s|$)/);
      await expect(page.locator(`link[rel="stylesheet"][href*="/css/rd/${name}."]`)).toHaveCount(1);
      await page.waitForLoadState('networkidle');
      await noSidewaysScroll(page, `${name} at ${width}`);
    }
  }
});

test('pickup keeps its own footer with the help lines, and its map links are the shell pills', async ({
  page,
}) => {
  await page.goto('/pickup.html');
  const footer = page.locator('body > footer');
  // One footer, the page's own: not replaced by the shell's, and not hidden.
  await expect(footer).toHaveCount(1);
  await expect(footer).not.toHaveAttribute('data-rd-replaced', '');
  await expect(footer).toBeVisible();
  await expect(footer).toContainText('0552441334');
  await expect(page.getByTestId('pickup-waze')).toHaveClass(/rd-btn/);
  await expect(page.getByRole('heading', { name: 'איסוף עצמי', level: 1 })).toHaveClass(/rd-title/);
});

test('pay-success still shows the order and reports the purchase in the mode', async ({ page }) => {
  await mockSummary(page);
  await page.goto('/pay-success.html?c=abc&k=tok');
  await expect(page.locator('#orderNoVal')).toHaveText('DG-1042');
  await expect(page.locator('#summary')).toBeVisible();
  await expect(page.locator('.done .back')).toHaveClass(/rd-btn/);
  await expect(page.locator('.done .back')).toBeVisible();
  // The copied mark is hidden until a tap, whatever the shell does to its parent.
  await expect(page.locator('#orderNoCopied')).toBeHidden();
  const purchases = await page.evaluate(
    () => window.dataLayer.filter((e) => e[0] === 'event' && e[1] === 'purchase').length
  );
  expect(purchases).toBe(1);
});

test('pay-done at the top level after a failure: no way back unless one was stored, then one', async ({
  page,
}) => {
  await page.goto('/pay-done.html?error=1');
  await expect(page.locator('#msg')).toHaveText('התשלום לא הושלם');
  await expect(page.locator('#back')).toBeHidden();

  await page.evaluate(() => sessionStorage.setItem('dugri:payReturn', '/collect.html?c=x'));
  await page.reload();
  await expect(page.locator('#back')).toBeVisible();
  await expect(page.locator('#back')).toHaveAttribute('href', '/collect.html?c=x');
});

test('partner: a working report shows no empty message box, and its numbers are not in the heading face', async ({
  page,
  request,
}) => {
  const coupon = await makePartner(request, uniq('RDP'));
  await page.goto(`/partner.html?t=${coupon.report_token}`);
  await expect(page.locator('#app')).toBeVisible();
  // The error box starts hidden and stays so on a working report (a new partner's "no sales yet" note is a .msg too, and
  // that one is meant to show).
  await expect(page.locator('#err')).toBeHidden();
  const face = await page.locator('#tOwed').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(face).not.toMatch(/Gveret/);

  await page.goto('/partner.html?t=' + 'a'.repeat(48));
  await expect(page.locator('#err')).toBeVisible();
});

test('coupons: the owner creates a coupon from the form in the mode', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== ONLY, 'writes shared coupon state — one project only');
  const code = uniq('RDC');
  await page.goto(`/coupons.html?key=${KEY}`);
  await expect(page.locator('#createPanel')).toBeVisible();
  await page.fill('#code', code);
  await page.fill('#pct', '10');
  await page.click('#submitBtn');
  await expect(page.locator('tbody tr').filter({ hasText: code })).toHaveCount(1);
});

test("product.html's buy box: the ink pill without the old glow, the price in the body face, and buying still starts", async ({
  page,
}) => {
  await page.goto('/product.html?design=bachelorette');
  const buy = page.getByTestId('pdp-buy');
  await expect.poll(() => buy.getAttribute('href')).toBe('options.html?design=bachelorette&step=2');
  await expect(buy).toHaveClass(/rd-btn/);
  await expect(page.locator('.pdp-head h1')).toHaveClass(/rd-title/);
  // The old .btn sheen and press wipe are off the pill.
  for (const pseudo of ['::before', '::after']) {
    const display = await buy.evaluate((el, p) => getComputedStyle(el, p).display, pseudo);
    expect(display, pseudo).toBe('none');
  }
  const face = await page.locator('#pdpPriceNow').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(face).not.toMatch(/Gveret/);

  // The money path: in the mode there is no start explainer (#692), the pill goes straight to the wizard with the design.
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.isNavigationRequest() && r.url().includes('options.html')),
    buy.click(),
  ]);
  expect(new URL(req.url()).search).toBe('?design=bachelorette&step=2');
});

// The owner's prices, pinned so the totals are known (a body without versions fails isValidPricing and is ignored).
const PRICING = {
  store: { now: 79, was: 129 },
  sale: { on: false },
  versions: {
    pdf: { enabled: true, price: 79 },
    pickup: { enabled: true, price: 149 },
    delivery: { enabled: true, price: 199 },
    custom: { enabled: true, price: 599 },
  },
  // Without a fee the delivery tick is not offered.
  delivery_fee: 39,
};

// A's section of collect.css: the checkout. The top pay card, the pay panel, the bar and the payment window.
async function makeCollection(request) {
  const res = await request.post('/api/collections', {
    data: {
      honoree_name: 'ליאת',
      email: 'rd@example.com',
      phone: '0521234567',
      design: 'פריז',
      theme: 'bachelorette',
      extra_fields: {},
      custom_title: 'ליאת חוגגת 40',
      buyer_name: 'דנה כהן',
    },
  });
  expect(res.ok()).toBe(true);
  const { id, owner_token: k } = await res.json();
  return { id, k };
}

// The e2e server has no card credentials, so every pay control is hidden; the checkout's look is about the owner who
// can pay. Same switch as collect.spec.js's enableCardButton.
async function checkoutReady(page) {
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const body = await (await route.fetch()).json();
    body.card_enabled = true;
    return route.fulfill({ json: body });
  });
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PRICING),
    })
  );
}

test('collect.html checkout in the mode: the pay pill sits inside its card, nothing scrolls sideways, and paying still opens the payment window', async ({
  page,
  request,
}) => {
  await checkoutReady(page);
  const { id, k } = await makeCollection(request);
  await page.goto(`/collect.html?c=${id}&k=${k}`);
  await openCheckout(page);

  const top = page.getByTestId('pay-top');
  await expect(top).toBeVisible();
  const topRadius = await top.evaluate((el) =>
    parseFloat(getComputedStyle(el).borderTopLeftRadius)
  );
  expect(topRadius).toBeGreaterThan(0);

  const btn = page.locator('#cardPayBtn');
  await expect(btn).toBeVisible();
  // The old gradient, glow pulse and light sweep are off; the button is the ink pill.
  const look = await btn.evaluate((el) => ({
    image: getComputedStyle(el).backgroundImage,
    anim: getComputedStyle(el).animationName,
    sweep: getComputedStyle(el, '::after').display,
  }));
  expect(look).toEqual({ image: 'none', anim: 'none', sweep: 'none' });

  for (const width of [360, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    // The old button was width:100% on top of the card's inset and ran past the card's edge, clipped.
    const [b, card] = await Promise.all([
      btn.boundingBox(),
      page.locator('#payPanel').boundingBox(),
    ]);
    expect(b.x, `pay pill's left at ${width}`).toBeGreaterThanOrEqual(card.x + 8);
    expect(b.x + b.width, `pay pill's right at ${width}`).toBeLessThanOrEqual(
      card.x + card.width - 8
    );
    expect(b.width, `pay pill fills its card at ${width}`).toBeGreaterThan(card.width - 48);
    await noSidewaysScroll(page, `collect checkout at ${width}`);
  }

  // The copies row is a quiet row of the card: no tinted box (the page's accent frame, pink in the mode), and a small,
  // light stepper whose tap target still reaches past the visible round.
  await page.locator('#qtyRow').scrollIntoViewIfNeeded();
  const copies = await page.locator('#qtyRow').evaluate((row) => {
    const cs = (el) => getComputedStyle(el);
    const plus = row.querySelector('#qtyPlus');
    const r = plus.getBoundingClientRect();
    // 4px outside the round's edge, still on the button's hit area (the row is in view: off-screen this is null)
    const reach = document.elementFromPoint(r.left - 4, r.top + r.height / 2);
    return {
      bg: cs(row).backgroundColor,
      side: cs(row).borderLeftWidth,
      size: [r.width, r.height],
      glyph: cs(plus).fontWeight,
      value: cs(row.querySelector('#qtyVal')).fontWeight,
      reach: reach === plus,
    };
  });
  expect(copies).toEqual({
    bg: 'rgba(0, 0, 0, 0)',
    side: '0px',
    size: [30, 30],
    glyph: '400',
    value: '400',
    reach: true,
  });

  // The copies stepper still prices the order: two copies of the PDF.
  await page.getByTestId('qty-plus').click();
  await expect(page.locator('#payTotal')).toHaveText('158');
  await page.getByTestId('qty-minus').click();
  await expect(page.locator('#payTotal')).toHaveText('79');

  // The money path: the pill asks pay/init and opens its page in the payment window.
  const frameUrl = new URL('/terms.html', page.url()).href;
  await page.route('**/api/collections/*/pay/init', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: frameUrl }),
    })
  );
  await btn.click();
  await expect(page.locator('#payModal')).toBeVisible();
  await expect(page.locator('#payFrame')).toHaveAttribute('src', frameUrl);
  await page.locator('#payModalClose').click();
  await expect(page.locator('#payModal')).toBeHidden();
});

test('collect.html checkout in the mode: the choices are quiet rows of the card at one width, with drawn controls', async ({
  page,
  request,
}) => {
  await checkoutReady(page);
  const { id, k } = await makeCollection(request);
  await page.goto(`/collect.html?c=${id}&k=${k}`);
  await openCheckout(page);
  // The PDF is offered first and picked by default; delivery is a tick on the printed game.
  await page.locator('.pay-opt:has(input[value="pickup"])').click();
  await page.locator('#shipOpt').click();
  await expect(page.locator('#addressForm')).toBeVisible();

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const look = await page.evaluate(() => {
      const cs = (el) => getComputedStyle(el);
      const box = (sel) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        return {
          bg: cs(el).backgroundColor,
          side: cs(el).borderLeftWidth,
          left: Math.round(r.left),
          right: Math.round(r.right),
        };
      };
      const price = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().left);
      return {
        opt: box('.pay-opt.active'),
        tick: box('#shipOpt'),
        addr: box('#addressForm'),
        optPrice: price('.pay-opt.active .opt-price'),
        tickPrice: price('#shipPrice'),
        radio: cs(document.querySelector('.pay-opt.active input')).appearance,
        tickBg: cs(document.querySelector('#shipToggle')).backgroundColor,
      };
    });
    // No tinted, outlined boxes: the card's own ground, no side frame.
    for (const k of ['opt', 'tick', 'addr']) {
      expect(look[k].bg, `${k} at ${width}`).toBe('rgba(0, 0, 0, 0)');
      expect(look[k].side, `${k} at ${width}`).toBe('0px');
    }
    // The tick is as wide as the option above it (it was indented 18px), and both prices end on one edge.
    expect(look.tick.left, `tick's edge at ${width}`).toBe(look.opt.left);
    expect(look.tick.right, `tick's edge at ${width}`).toBe(look.opt.right);
    expect(
      Math.abs(look.tickPrice - look.optPrice),
      `prices' edge at ${width}`
    ).toBeLessThanOrEqual(1);
    // Drawn controls, not the browser's; the ticked one is filled ink.
    expect(look.radio).toBe('none');
    expect(look.tickBg).toBe('rgb(0, 0, 0)');
  }
});
