import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// Ordering several copies of the same deck from the checkout. Pricing is stubbed
// so the arithmetic is pinned to known numbers: ₪199 a copy, ₪39 shipping charged
// ONCE for the whole order.
const UNIT = 199;
const FEE = 39;

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        store: { now: 199, was: 239 },
        // Sale mode ON: these specs assert the struck was-price, which
        // css/tokens.css hides unless /api/pricing reports a live sale.
        sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
        versions: {
          pdf: { enabled: false, price: 79 },
          pickup: { enabled: true, price: UNIT },
          delivery: { enabled: true, price: UNIT },
          custom: { enabled: false, price: 599 },
        },
        delivery_fee: FEE,
      }),
    })
  );
});

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function createCollection(page, name) {
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      }),
    })
  );
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#customTitleInput', name);
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#ownerEmail', 'copies@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.getByTestId('next-btn').click();
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
  await page.locator('#payPanel summary').click();
}

test('copies: the total multiplies, and one copy shows no arithmetic to explain', async ({
  page,
}) => {
  await createCollection(page, 'Copies');

  // One copy of a pickup order needs no explanation — it is just the price.
  await expect(page.getByTestId('qty-val')).toHaveText('1');
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT));
  await expect(page.getByTestId('pay-math')).toBeHidden();
  // Nothing below 1 copy exists, so the minus control is dead at the floor.
  await expect(page.getByTestId('qty-minus')).toBeDisabled();

  await page.getByTestId('qty-plus').click();
  await expect(page.getByTestId('qty-val')).toHaveText('2');
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 2));
  // Now the sum is not self-evident, so it is spelled out.
  await expect(page.getByTestId('pay-math')).toBeVisible();
  await expect(page.getByTestId('pay-math')).toContainText('2');

  await page.getByTestId('qty-plus').click();
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 3));
  await page.getByTestId('qty-minus').click();
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 2));
});

test('copies: delivery charges shipping once, however many copies', async ({ page }) => {
  await createCollection(page, 'Shipping');
  // Delivery is a tick on the printed game, not a version of its own.
  await page.locator('input[name="payVersion"][value="pickup"]').check();
  await page.locator('#shipToggle').check();
  // One copy: price + one shipping.
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT + FEE));

  for (let i = 0; i < 4; i += 1) await page.getByTestId('qty-plus').click();
  await expect(page.getByTestId('qty-val')).toHaveText('5');
  // The owner's own example: 199 x 5 + 39 = 1034. Shipping is NOT multiplied.
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 5 + FEE));
  await expect(page.getByTestId('pay-math')).toContainText(String(FEE));

  // Switching to pickup drops the fee entirely, keeping the count.
  await page.locator('input[name="payVersion"][value="pickup"]').check();
  await page.locator('#shipToggle').uncheck();
  await expect(page.getByTestId('qty-val')).toHaveText('5');
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 5));
});

test('copies: the count reaches the server and survives a reload', async ({ page }) => {
  await createCollection(page, 'Persist');
  for (let i = 0; i < 2; i += 1) await page.getByTestId('qty-plus').click();
  await expect(page.getByTestId('qty-val')).toHaveText('3');

  // Place the order through the same API the pay button uses.
  const id = new URL(page.url()).searchParams.get('c');
  const k = new URL(page.url()).searchParams.get('k');
  const res = await page.request.post(`/api/collections/${id}/order`, {
    data: { owner_token: k, version: 'pickup', quantity: 3 },
  });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).total).toBe(UNIT * 3);

  // A reload (and the 5s poll) must not reset the buyer's count to 1.
  await page.reload();
  await page.locator('#payPanel summary').click();
  await expect(page.getByTestId('qty-val')).toHaveText('3');
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 3));
});

test('copies: the server prices the order, not the browser', async ({ page }) => {
  await createCollection(page, 'Tamper');
  const id = new URL(page.url()).searchParams.get('c');
  const k = new URL(page.url()).searchParams.get('k');
  // A hand-rolled request claiming five copies cost ₪1.
  const res = await page.request.post(`/api/collections/${id}/order`, {
    data: { owner_token: k, version: 'pickup', quantity: 5, total: 1, unit_price: 1 },
  });
  expect((await res.json()).total).toBe(UNIT * 5);
});

test('copies: the 5s poll must not overwrite a count the buyer is choosing', async ({ page }) => {
  await createCollection(page, 'Poll');
  // Place a 1-copy order so the server has a stored quantity to sync FROM.
  const id = new URL(page.url()).searchParams.get('c');
  const k = new URL(page.url()).searchParams.get('k');
  await page.request.post(`/api/collections/${id}/order`, {
    data: { owner_token: k, version: 'pickup', quantity: 1 },
  });

  await page.getByTestId('qty-plus').click();
  await page.getByTestId('qty-plus').click();
  await expect(page.getByTestId('qty-val')).toHaveText('3');

  // The background poll runs every 5s and re-applies pricing from the server,
  // where the order still says 1. The buyer's unsent choice must survive it —
  // otherwise she watches 3 turn back into 1, and pays for one deck.
  await page.waitForTimeout(6500);
  await expect(page.getByTestId('qty-val')).toHaveText('3');
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 3));
});

test('copies: a locked order shows its stored total, never total × copies', async ({ page }) => {
  await createCollection(page, 'Locked');
  const id = new URL(page.url()).searchParams.get('c');
  const k = new URL(page.url()).searchParams.get('k');
  // An admin-created order locks checkout to its own stored total.
  const made = await page.request.post(`/api/admin/collections/${id}/custom?key=dugri-admin`, {
    data: {},
  });
  expect(made.ok()).toBeTruthy();

  await page.goto(`/collect.html?c=${id}&k=${k}`);
  await page.locator('#payPanel summary').click();

  // Whatever the locked total is, the page must show exactly it — not a figure
  // re-derived from the copy count, and not with shipping added on top.
  const stored = (await (await page.request.get(`/api/collections/${id}`)).json()).order.total;
  await expect(page.locator('#payTotal')).toHaveText(String(stored));
  // The stepper isn't offered on a locked order, so no arithmetic line either.
  await expect(page.locator('#qtyRow')).toBeHidden();
  await expect(page.getByTestId('pay-math')).toBeHidden();
});
