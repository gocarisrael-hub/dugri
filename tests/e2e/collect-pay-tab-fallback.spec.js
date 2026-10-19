// The collect page's תשלום tab is up only where the pay cards are not (the owner, 2026-10-19: "payment is already
// everywhere, the tab is clutter"). While the collection is open, unpaid and card payment is on, the top pay card and
// the sticky pay bar open the checkout from every tab, so the tab is down. A collection she closed before paying still
// takes a payment, and there neither card shows: the tab is the one way left in, so it stays.
import { test, expect } from '@playwright/test';

async function makeCollection(request) {
  const res = await request.post('/api/collections', {
    data: {
      honoree_name: 'שירה',
      email: 'paytab@example.com',
      phone: '0521234567',
      design: 'פריז',
      theme: 'bachelorette',
      extra_fields: {},
      buyer_name: 'דנה כהן',
    },
  });
  expect(res.ok()).toBe(true);
  const { id, owner_token: k } = await res.json();
  return { id, k };
}

// The e2e server has no card credentials; flip card_enabled (and, for the closed case, the status) on the state
// response. These tests are about what the page renders in that state, not how it got there.
async function stubState(page, patch) {
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const body = await (await route.fetch()).json();
    return route.fulfill({ json: { ...body, card_enabled: true, ...patch } });
  });
}

test('open and unpaid: no תשלום tab, and the pay bar opens the checkout from any tab', async ({
  page,
  request,
}) => {
  await stubState(page, {});
  const { id, k } = await makeCollection(request);
  await page.goto(`/collect.html?c=${id}&k=${k}`);

  await expect(page.getByTestId('pay-bar')).toBeVisible();
  await expect(page.getByTestId('pay-top')).toBeVisible();
  await expect(page.getByTestId('tab-pay')).toBeHidden();
  await expect(page.getByTestId('tab-words')).toBeVisible();
  await expect(page.getByTestId('tab-finish')).toBeVisible();

  await page.getByTestId('tab-design').click();
  await expect(page.locator('#designPanel')).toBeVisible();
  await page.getByTestId('pay-bar-btn').click();
  const panel = page.locator('#payPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('open', '');
  await expect(page.locator('#payOpts')).toBeVisible();
  // The checkout replaced the tab she was on, as the tab did.
  await expect(page.locator('#designPanel')).toBeHidden();
});

test('closed before paying: the pay cards are gone, so the תשלום tab is back and opens the checkout', async ({
  page,
  request,
}) => {
  await stubState(page, { status: 'closed' });
  const { id, k } = await makeCollection(request);
  await page.goto(`/collect.html?c=${id}&k=${k}`);

  const tab = page.getByTestId('tab-pay');
  await expect(tab).toBeVisible();
  await expect(page.getByTestId('pay-bar')).toBeHidden();
  await expect(page.getByTestId('pay-top')).toBeHidden();

  await tab.click();
  await expect(tab).toHaveClass(/\bon\b/);
  const panel = page.locator('#payPanel');
  await expect(panel).toBeVisible();
  await page.locator('#payPanel > summary').click();
  await expect(page.locator('#payOpts')).toBeVisible();
});
