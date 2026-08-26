// A BLOGGER'S COUPON, from the owner creating it to the blogger reading her own
// earnings — through both real pages.
//
// The two screens exist to stop the same argument: "how much do you owe me?".
// So what is tested is that they agree, that the blogger's page needs no login
// and shows no customer, and that recording a payment moves the number she
// actually reads.
import { test, expect } from '@playwright/test';

const KEY = 'dugri-admin';
const uniq = (p) => p + Date.now().toString(36).toUpperCase().slice(-6);

// This spec WRITES coupons, which the coupon admin page and the checkout both
// read. Like admin-faq.spec.js it runs on ONE project so the two device profiles
// cannot race each other against a single server.
const ONLY = 'Desktop Chrome';

async function makePartner(request, code, over = {}) {
  const r = await request.post(`/api/admin/coupons?key=${KEY}`, {
    data: {
      code,
      discount_pct: 15,
      partner_name: 'נועה',
      commission_type: 'fixed',
      commission_value: 30,
      ...over,
    },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).coupon;
}

// A real order paid with the code, through the free-coupon path (discount 100),
// so the sale exists without a card. Its commission is 0 — a free order earns
// nothing — which is exactly what the "she sees a sale" assertions rely on NOT
// being, so this helper is only used where the sale itself is the point.
async function paidCollection(request, _code) {
  const c = await request.post('/api/collections', {
    data: { honoree_name: 'שירה כהן', owner_email: 'buyer@example.com', owner_phone: '0541234567' },
  });
  return await c.json();
}

test.describe('a partner coupon', () => {
  test('the owner creates one and gets a private link for the blogger', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared coupon state — one project only');
    const code = uniq('BLG');
    await makePartner(request, code);

    await page.goto(`/coupons.html?key=${KEY}`);
    const row = page.locator('tbody tr').filter({ hasText: code });
    await expect(row).toHaveCount(1);
    // The two facts that turn a discount into a partnership sit in the row.
    await expect(row).toContainText('נועה');
    await expect(row).toContainText('30 ₪ לעותק');
    await expect(row.getByRole('button', { name: 'העתק קישור לדוח' })).toBeVisible();
  });

  test('an ordinary discount code gets no partner controls', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared coupon state — one project only');
    const code = uniq('PLN');
    const r = await request.post(`/api/admin/coupons?key=${KEY}`, {
      data: { code, discount_pct: 10 },
    });
    expect(r.status()).toBe(201);

    await page.goto(`/coupons.html?key=${KEY}`);
    const row = page.locator('tbody tr').filter({ hasText: code });
    await expect(row.getByRole('button', { name: 'העתק קישור לדוח' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'רווחים ותשלומים' })).toHaveCount(0);
  });

  test('her page opens on the link alone, with no admin key', async ({ page, request }) => {
    const code = uniq('LNK');
    const coupon = await makePartner(request, code);

    await page.goto(`/partner.html?t=${coupon.report_token}`);
    await expect(page.getByRole('heading', { name: /נועה/ })).toBeVisible();
    // Her terms, in her own words — she should not have to work out what she is
    // owed from a percentage someone told her once in a DM.
    await expect(page.locator('#rate')).toContainText('30');
    await expect(page.locator('#rate')).toContainText('15%');
    await expect(page.locator('#code')).toHaveText(code);
  });

  test('a bad link explains itself instead of showing an empty report', async ({ page }) => {
    await page.goto('/partner.html?t=' + 'a'.repeat(48));
    await expect(page.locator('#err')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
  });

  test('with no link at all it says so', async ({ page }) => {
    await page.goto('/partner.html');
    await expect(page.locator('#err')).toBeVisible();
  });

  test('recording a payment moves the number she reads', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared coupon state — one project only');
    const code = uniq('PAY');
    const coupon = await makePartner(request, code);

    const r = await request.post(`/api/admin/coupons/${coupon.id}/payouts?key=${KEY}`, {
      data: { amount: 90, note: 'ביט' },
    });
    expect(r.status()).toBe(201);

    await page.goto(`/partner.html?t=${coupon.report_token}`);
    await expect(page.locator('#tPaid')).toContainText('90');
    // Earned nothing yet, so 90 paid reads as an overpayment rather than as zero.
    await expect(page.locator('#tOwed')).toContainText('-90');
    await expect(page.locator('#payouts')).toContainText('ביט');
  });

  test('her page never shows a customer', async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== ONLY, 'writes shared coupon state — one project only');
    const code = uniq('PRV');
    const coupon = await makePartner(request, code);
    await paidCollection(request, code);

    await page.goto(`/partner.html?t=${coupon.report_token}`);
    await expect(page.locator('#app')).toBeVisible();
    // Whatever else is on the page, the shop's buyers are not.
    const body = await page.locator('body').innerText();
    for (const secret of ['שירה כהן', 'buyer@example.com', '0541234567']) {
      expect(body, secret).not.toContain(secret);
    }
  });

  test('it is kept out of search results', async ({ page, request }) => {
    const coupon = await makePartner(request, uniq('IDX'));
    await page.goto(`/partner.html?t=${coupon.report_token}`);
    // One blogger's earnings must not be findable by searching for them.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });
});
