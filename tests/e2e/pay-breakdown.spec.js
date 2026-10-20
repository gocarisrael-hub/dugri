// The breakdown line under the checkout total (#payMath) must ADD UP to the total beside it. With a coupon it used to
// read "price + shipping" with no discount term, so it summed to the struck price while the total showed the discounted
// one: a buyer checking our sum found a different number from the one she was about to pay. Every combination the
// buyer can reach is walked here, on the live page and in redesign mode: pickup or delivery, one to three copies, one
// box or a box each, no coupon, an owner's coupon and a friend's coupon. The line is read the way she reads it, amount
// by amount with its operators, and the total is checked against the server's own arithmetic (db.orderTotal plus the
// pay/init coupon rule).
import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';
import { openCheckout } from './helpers/checkout.js';

const KEY = 'dugri-admin';
// Prices that make the coupon rounding real: 15% of 3 × 199 is not a whole number.
const UNIT = 199;
const FEE = 39;
const PRICING = {
  store: { now: UNIT, was: UNIT },
  sale: { on: false },
  versions: {
    pdf: { enabled: false, price: 79 },
    pickup: { enabled: true, price: UNIT },
    delivery: { enabled: true, price: UNIT },
    custom: { enabled: false, price: 599 },
  },
  delivery_fee: FEE,
};
const uniq = (p) => p + Math.random().toString(36).slice(2, 8).toUpperCase();

async function makeParty(request) {
  const r = await request.post('/api/collections', { data: { honoree_name: 'ליאת' } });
  expect(r.ok()).toBe(true);
  const { id, owner_token: k } = await r.json();
  return { id, k };
}

// The line as the buyer reads it: each .amt is an amount; "× n" multiplies the amount before it; "+" and "−" sign the
// amount after them. Anything else ("עותקים", "משלוח", "הנחה (15%)") is words.
function readLine(el) {
  const terms = [];
  let sign = 1;
  for (const node of el.childNodes) {
    if (node.nodeType === 1 && node.classList.contains('amt')) {
      terms.push(sign * Number(node.textContent.replace(/\D/g, '')));
      sign = 1;
      continue;
    }
    const text = node.textContent;
    const times = /×\s*(\d+)/.exec(text);
    if (times && terms.length) terms[terms.length - 1] *= Number(times[1]);
    if (/\+\s*$/.test(text)) sign = 1;
    if (/−\s*$/.test(text)) sign = -1;
  }
  return { terms, sum: terms.reduce((a, b) => a + b, 0), text: el.textContent };
}

for (const mode of ['live', 'redesign']) {
  test(`${mode}: the line under the total sums to the total, with and without a coupon`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    if (mode === 'redesign') await previewRedesign(page);
    await page.route('**/api/pricing', (r) => r.fulfill({ json: PRICING }));
    // The e2e server has no card credentials, which hides the pay controls; the checkout is about the owner who can pay.
    await page.route('**/api/collections/*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const body = await (await route.fetch()).json();
      body.card_enabled = true;
      return route.fulfill({ json: body });
    });

    const owner = uniq('BRK');
    const made = await request.post(`/api/admin/coupons?key=${KEY}`, {
      data: { code: owner, discount_pct: 15 },
    });
    expect(made.status()).toBe(201);
    const issuer = await makeParty(request);
    const issued = await request.post('/api/friend-coupon', {
      data: { email: uniq('buyer').toLowerCase() + '@example.com', collection_id: issuer.id },
    });
    const { code: friend } = await issued.json();
    expect(friend).toMatch(/-/);

    const { id, k } = await makeParty(request);
    await page.goto(`/collect.html?c=${id}&k=${k}`);
    await openCheckout(page);

    const coupons = [
      { name: 'no coupon', code: null },
      { name: 'owner coupon 15%', code: owner, pct: 15 },
      { name: 'friend coupon', code: friend, pct: null },
    ];
    let checked = 0;
    for (const coupon of coupons) {
      if (await page.locator('#couponRemoveBtn').isVisible())
        await page.locator('#couponRemoveBtn').click();
      if (coupon.code) {
        await page.fill('#couponInput', coupon.code);
        await page.locator('#couponApplyBtn').click();
        await expect(page.locator('#couponMsg')).toContainText('הנחה');
        // A friend code carries its percent; read the one the server granted from the message.
        if (coupon.pct == null)
          coupon.pct = Number(/(\d+)%/.exec(await page.locator('#couponMsg').innerText())[1]);
      }
      for (const ship of [false, true]) {
        if ((await page.locator('#shipToggle').isChecked()) !== ship)
          await page.locator('#shipOpt').click();
        for (const copies of [1, 2, 3]) {
          while (Number(await page.locator('#qtyVal').innerText()) < copies)
            await page.getByTestId('qty-plus').click();
          while (Number(await page.locator('#qtyVal').innerText()) > copies)
            await page.getByTestId('qty-minus').click();
          for (const oneBox of copies > 1 ? [false, true] : [true]) {
            if (copies > 1 && (await page.locator('#oneBoxToggle').isChecked()) !== oneBox)
              await page.locator('#oneBoxOpt').click();
            const label = `${mode} · ${coupon.name} · ${ship ? 'delivery' : 'pickup'} · ${copies} copies${copies > 1 ? (oneBox ? ' · one box' : ' · a box each') : ''}`;

            // The server's arithmetic: the coupon comes off the game money only, shipping is added back whole.
            const fee = ship ? FEE * (oneBox ? 1 : copies) : 0;
            const base = UNIT * copies + fee;
            const want = coupon.code
              ? Math.round((base - fee) * (1 - coupon.pct / 100)) + fee
              : base;
            await expect(page.locator('#payTotal'), label).toHaveText(String(want));

            const struck = await page
              .locator('#payWas')
              .evaluate((el) =>
                el.classList.contains('hidden') ? null : Number(el.textContent.replace(/\D/g, ''))
              );
            expect(struck, `${label}: the struck price is the total before the coupon`).toBe(
              coupon.code ? base : null
            );

            const math = page.locator('#payMath');
            const shown = await math.isVisible();
            // Only a single copy, picked up, at full price, speaks for itself.
            expect(shown, `${label}: a total that is not just the price is spelled out`).toBe(
              want !== UNIT
            );
            if (shown) {
              const line = await math.evaluate(readLine);
              expect(line.sum, `${label}: "${line.text}" sums to the total`).toBe(want);
              if (coupon.code) expect(line.text, label).toContain(`הנחה (${coupon.pct}%)`);
              else expect(line.text, label).not.toContain('הנחה');
            }
            checked++;
          }
        }
      }
    }
    // 3 coupons × (pickup, delivery) × (1 copy + 2 copies × 2 boxings + 3 copies × 2 boxings)
    expect(checked).toBe(30);
  });
}
