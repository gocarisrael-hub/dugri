import { test, expect } from '@playwright/test';

// GA's loadGA() is a no-op on localhost, so nothing here reaches Google; the
// assertions read the dataLayer queue, which fills on every host.
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

function mockSummary(page, body) {
  return page.route('**/api/collections/**/summary**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  );
}

const purchases = (dataLayer) =>
  dataLayer.filter((e) => e[0] === 'event' && e[1] === 'purchase').map((e) => e[2]);

const readLayer = (page) => page.evaluate(() => window.dataLayer.map((a) => Array.from(a)));

test.describe('purchase event', () => {
  test('a paid order reports value, currency and the order number', async ({ page }) => {
    await mockSummary(page, SUMMARY);
    await page.goto('/pay-success.html?c=abc&k=tok');
    await expect(page.locator('#orderNoVal')).toHaveText('DG-1042');

    const [purchase, ...extra] = purchases(await readLayer(page));
    expect(extra).toHaveLength(0);
    expect(purchase).toMatchObject({
      transaction_id: 'DG-1042',
      value: 437,
      currency: 'ILS',
      shipping: 39,
    });
    expect(purchase.items[0]).toMatchObject({
      item_id: 'bachelorette',
      item_name: 'החבילה המלאה',
      price: 199,
      quantity: 2,
    });
  });

  test('a reload does not count the same sale twice', async ({ page }) => {
    await mockSummary(page, SUMMARY);
    await page.goto('/pay-success.html?c=abc&k=tok');
    await expect(page.locator('#orderNoVal')).toHaveText('DG-1042');
    expect(purchases(await readLayer(page))).toHaveLength(1);

    await page.reload();
    await expect(page.locator('#orderNoVal')).toHaveText('DG-1042');
    expect(purchases(await readLayer(page))).toHaveLength(0);
  });

  test('an unpaid order reports nothing', async ({ page }) => {
    await mockSummary(page, {
      ...SUMMARY,
      order_no: 'DG-1043',
      order: { ...SUMMARY.order, paid: false, charged: null },
    });
    await page.goto('/pay-success.html?c=abc&k=tok');
    await expect(page.locator('#orderNoVal')).toHaveText('DG-1043');
    expect(purchases(await readLayer(page))).toHaveLength(0);
  });
});

test('the shop page is instrumented — its CTA clicks reach the dataLayer', async ({ page }) => {
  await page.goto('/products.html');
  await page.evaluate(() => {
    document.querySelectorAll('a[data-ga]').forEach((a) => {
      a.addEventListener('click', (e) => e.preventDefault());
    });
  });
  await page.locator('a[data-ga="contact_click"]').first().click();
  const dataLayer = await readLayer(page);
  expect(dataLayer.some((e) => e[0] === 'event' && e[1] === 'contact_click')).toBe(true);
});
