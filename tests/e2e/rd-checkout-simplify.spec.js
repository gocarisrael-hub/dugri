// The checkout made simpler in the redesign (the owner, 2026-10-21): the printed game is one product, "דוגרי אישי", with
// delivery as its own add-on nested under it rather than a second option beside it; and the coupon field folds behind
// one row until it is asked for, or until a code is in play. The live page keeps its order and its open field.
import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';
import { openCheckout } from './helpers/checkout.js';

const KEY = 'dugri-admin';
const uniq = (p) =>
  p +
  Date.now().toString(36).toUpperCase().slice(-6) +
  Math.random().toString(36).slice(2, 5).toUpperCase();

const PRICING = {
  store: { now: 79, was: 129 },
  sale: { on: false },
  versions: {
    pdf: { enabled: true, price: 79 },
    pickup: { enabled: true, price: 199 },
    delivery: { enabled: true, price: 199 },
    custom: { enabled: true, price: 599 },
  },
  // Without a fee the delivery tick is not offered.
  delivery_fee: 39,
};

async function checkoutReady(page) {
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const body = await (await route.fetch()).json();
    body.card_enabled = true;
    return route.fulfill({ json: body });
  });
  await page.route('**/api/pricing', (route) => route.fulfill({ json: PRICING }));
}

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

async function makeCoupon(request) {
  const code = uniq('FOLD');
  const r = await request.post(`/api/admin/coupons?key=${KEY}`, {
    data: { code, discount_pct: 10 },
  });
  expect(r.status()).toBe(201);
  return code;
}

// The ids of #payOpts' children that are shown, in DOM order (the order the keyboard and a screen reader take).
const order = (page) =>
  page.locator('#payOpts').evaluate((box) =>
    Array.from(box.children)
      .filter((el) => el.getClientRects().length)
      .map(
        (el) =>
          el.id || (el.querySelector('input[name="payVersion"]') || {}).value || el.dataset.testid
      )
  );

test.describe('redesign', () => {
  test.beforeEach(({ page }) => previewRedesign(page));

  test('the printed game is "דוגרי אישי", and delivery is its add-on, nested under it', async ({
    page,
    request,
  }) => {
    await checkoutReady(page);
    const { id, k } = await makeCollection(request);
    await page.goto(`/collect.html?c=${id}&k=${k}`);
    await openCheckout(page);
    const printed = page.locator('.pay-opt:has(input[value="pickup"])');
    await expect(printed.locator('.opt-title')).toContainText('דוגרי אישי');
    await printed.click();

    // Straight under the game it adds to, ahead of the pickup note and the custom design.
    expect(await order(page)).toEqual(['pdf', 'pickup', 'shipOpt', 'pickup-details', 'custom']);

    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const look = await page.evaluate(() => {
        const ship = document.getElementById('shipOpt');
        const game = ship.previousElementSibling;
        const r = (el) => el.getBoundingClientRect();
        const cs = (el, p) => getComputedStyle(el, p);
        const title = ship.querySelector('.opt-title');
        const price = ship.querySelector('#shipPrice');
        return {
          // RTL: the indent is on the right
          indent: Math.round(r(game).right - r(ship).right),
          rule: cs(ship).borderTopWidth,
          smaller:
            parseFloat(cs(title).fontSize) <
            parseFloat(cs(game.querySelector('.opt-title')).fontSize),
          plus: cs(title, '::before').content,
          dot: cs(price, '::before').content,
          // the price beside the words, not out on the versions' price edge
          priceGap: Math.round(r(title.firstElementChild).left - r(price).right),
        };
      });
      expect(look.indent, `indent at ${width}`).toBe(30);
      expect(look.rule, `no rule of its own at ${width}`).toBe('0px');
      expect(look.smaller, `one size down at ${width}`).toBe(true);
      expect(look.plus).toContain('+');
      expect(look.dot).toContain('·');
      expect(look.priceGap, `price beside the words at ${width}`).toBeLessThan(40);
    }

    // The behaviour is the tick's: pickup by default, ticking adds delivery and asks for the address.
    await expect(page.locator('#shipToggle')).not.toBeChecked();
    await expect(page.locator('#addressForm')).toBeHidden();
    await expect(page.locator('#payTotal')).toHaveText('199');
    await page.locator('#shipOpt').click();
    await expect(page.locator('#shipToggle')).toBeChecked();
    await expect(page.locator('#addressForm')).toBeVisible();
    await expect(page.locator('#payTotal')).toHaveText('238');

    // The PDF has nothing to ship: the add-on goes with the game.
    await page.locator('.pay-opt:has(input[value="pdf"])').click();
    await expect(page.locator('#shipOpt')).toBeHidden();
  });

  test('the coupon folds behind one row; the row is a button that says whether it is open', async ({
    page,
    request,
  }) => {
    await checkoutReady(page);
    const code = await makeCoupon(request);
    const { id, k } = await makeCollection(request);
    await page.goto(`/collect.html?c=${id}&k=${k}`);
    await openCheckout(page);

    const fold = page.getByTestId('coupon-toggle');
    await expect(fold).toBeVisible();
    await expect(fold).toHaveText('יש לכם קוד קופון?');
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(fold).toHaveAttribute('aria-controls', 'couponBody');
    await expect(page.locator('#couponInput')).toBeHidden();
    await expect(page.locator('#couponApplyBtn')).toBeHidden();

    // From the keyboard: it opens, and the field takes the focus.
    await fold.focus();
    await page.keyboard.press('Enter');
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#couponInput')).toBeFocused();
    await expect(page.locator('#couponApplyBtn')).toBeVisible();
    // The field is still named for a screen reader, though the row now says it.
    await expect(page.getByLabel('קוד קופון')).toHaveId('couponInput');

    // Folded and opened again with a click.
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#couponInput')).toBeHidden();
    await fold.click();

    await page.locator('#couponInput').fill(code);
    await page.locator('#couponApplyBtn').click();
    await expect(page.locator('#couponMsg')).toContainText('הנחה');
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#couponRemoveBtn')).toBeVisible();
  });

  test('a code carried in from a link arrives with the coupon open and applied', async ({
    page,
    request,
  }) => {
    await checkoutReady(page);
    const code = await makeCoupon(request);
    const { id, k } = await makeCollection(request);
    await page.goto(`/collect.html?c=${id}&k=${k}&coupon=${code}`);
    await openCheckout(page);
    await expect(page.getByTestId('coupon-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#couponMsg')).toContainText('הנחה');
    await expect(page.locator('#couponInput')).toBeVisible();
    await expect(page.locator('#couponInput')).toHaveValue(code);
  });
});

test('live: the delivery tick keeps its place after the versions, and the coupon field stays open', async ({
  page,
  request,
}) => {
  await checkoutReady(page);
  const { id, k } = await makeCollection(request);
  await page.goto(`/collect.html?c=${id}&k=${k}`);
  await openCheckout(page);
  await page.locator('.pay-opt:has(input[value="pickup"])').click();
  expect(await order(page)).toEqual(['pdf', 'pickup', 'pickup-details', 'custom', 'shipOpt']);
  await expect(page.getByTestId('coupon-toggle')).toBeHidden();
  await expect(page.locator('#couponInput')).toBeVisible();
  await expect(page.locator('#couponApplyBtn')).toBeVisible();
});
