import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { openCheckout } from './helpers/checkout.js';

// PARTNER VOUCHERS, as the two people involved meet them: the owner creates a
// reseller's pool on the admin page and exports the codes to hand over; a buyer
// types one into the ordinary checkout coupon field and gets a free order with
// no card charge; the owner then sees the code used, the order tagged with the
// partner, and the amount owed.
//
// The e2e server has no card credentials, so the collection is reported as
// card_enabled (the only fiction, as in pay-handoff.spec.js) — and the voucher
// order goes through the REAL pay/init free path, which needs no card provider.

const KEY = 'dugri-admin';
// This spec writes a pool and spends a code. Like partner-coupons.spec.js it runs
// on ONE project, so two device profiles never race on the same server state.
const ONLY = 'Desktop Chrome';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const rand = (n) =>
  Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');

async function cardEnabled(page) {
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const body = await resp.json();
    body.card_enabled = true;
    return route.fulfill({ json: body });
  });
}

test('the owner creates a pool and exports it; a buyer redeems a code into a free order', async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== ONLY, 'writes shared voucher state — one project only');
  const prefix = 'E' + rand(4);
  const partner = 'Hi Tech Zone ' + rand(3);

  // 1. The owner creates the pool on the admin page.
  await page.goto(`/admin-partners.html?key=${KEY}`);
  await page.fill('#pName', partner);
  await page.fill('#pPrefix', prefix.toLowerCase());
  await page.fill('#pCount', '3');
  await page.click('#createBtn');
  const pool = page.getByTestId('pool').filter({ hasText: prefix });
  await expect(pool).toHaveCount(1);
  await expect(pool.getByTestId('pool-issued')).toContainText('3');
  await expect(pool.getByTestId('pool-used')).toContainText('0');
  // No price agreed yet, and the page says so rather than showing 0 ₪.
  await expect(pool.getByTestId('pool-owed')).toContainText('לא נקבע');

  // 2. She exports the codes to hand to the reseller.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    pool.getByTestId('csv-unused').click(),
  ]);
  expect(download.suggestedFilename()).toBe(prefix + '-codes.csv');
  const csv = fs.readFileSync(await download.path(), 'utf8');
  const codes = [...csv.matchAll(new RegExp('"(' + prefix + '(?:-[A-Z2-9]{4}){4})"', 'g'))].map(
    (m) => m[1]
  );
  expect(codes).toHaveLength(3);

  // 3. A buyer with an order of her own types one code into the checkout.
  const made = await request.post('/api/collections', {
    data: {
      honoree_name: 'Dana',
      owner_email: 'buyer@example.com',
      owner_phone: '0541234567',
    },
  });
  const { id, owner_token: k } = await made.json();
  await cardEnabled(page);
  await page.goto(`/collect.html?c=${id}&k=${k}`);
  await openCheckout(page);
  await expect(page.locator('#payTotal')).not.toHaveText('-');
  const toggle = page.getByTestId('coupon-toggle');
  if (await toggle.isVisible()) await toggle.click();
  // Typed the way people type: lower case, spaces for dashes.
  await page.fill('#couponInput', codes[0].toLowerCase().replace(/-/g, ' '));
  await page.click('#couponApplyBtn');
  await expect(page.locator('#couponMsg')).toContainText('קוד המתנה הופעל');
  await expect(page.locator('#payTotal')).toHaveText('0');

  // Paying opens no card window: the order is paid on the spot.
  await page.click('#cardPayBtn');
  await page.waitForURL(/pay-success\.html/);
  await expect(page.locator('#payModal')).toHaveCount(0);

  // 4. The owner sees the code used, with the order behind it…
  await page.goto(`/admin-partners.html?key=${KEY}`);
  await expect(pool.getByTestId('pool-used')).toContainText('1');
  await pool.getByTestId('codes-toggle').click();
  const row = pool.getByTestId('code-row').filter({ hasText: codes[0] });
  await expect(row).toContainText('נוצל');
  await expect(row.locator('a')).toHaveAttribute('href', new RegExp('c=' + id));

  // …and once she sets the price, what the reseller owes.
  await pool.getByTestId('pool-price').fill('40');
  await pool.getByRole('button', { name: 'שמירה' }).click();
  await expect(pool.getByTestId('pool-owed')).toContainText('40');

  // 5. The orders list tags the order with the partner.
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.getByTestId('order-partner-tag').filter({ hasText: partner })).toHaveCount(1);

  // 6. The same code cannot be used again.
  const again = await request.post('/api/collections', { data: { honoree_name: 'Noa' } });
  const second = await again.json();
  const r = await request.post(`/api/collections/${second.id}/coupon/validate`, {
    data: { owner_token: second.owner_token, code: codes[0] },
  });
  expect(await r.json()).toEqual({ valid: false, reason: 'used' });
});

test('the staff key is turned away from the partners page', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== ONLY, 'one project is enough for a refusal');
  const r = await page.request.get('/api/admin/partner-pools?key=dugri-staff');
  expect(r.status()).toBe(403);
});
