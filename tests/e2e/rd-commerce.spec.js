// Commerce's own pages in redesign mode (site/css/rd/{pickup,pay-success,pay-done,partner,coupons}.css): each one gets
// its restyle, nothing scrolls sideways at a phone or desktop width, what a page hides stays hidden (a shell class sets
// display, which would otherwise outrank the hidden attribute), and the money steps on them still work in the mode.
// Outside the mode none of these files is linked; that half is the gate's own test (redesign-gate).
import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

const KEY = 'dugri-admin';
const uniq = (p) => p + Date.now().toString(36).toUpperCase().slice(-6);

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
