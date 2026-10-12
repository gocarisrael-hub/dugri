import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// SEVERAL PRINTED COPIES: A BOX EACH, OR ALL IN ONE BOX.
//
// The checkout's default for 2+ copies of a printed game is a box per copy —
// a sticker each and, for delivery, a shipping fee each. The buyer may tick
// "לשלוח את כל העותקים בקופסה אחת", and then the fee is charged once. The page
// only PREVIEWS that arithmetic; the server prices it (db.deliveryFeeFor), and the
// unit suite (order-boxes.test.js) holds the server's numbers. This spec holds the
// two ends the unit suite cannot see: the tick moving the price on screen, and
// the choice actually travelling to the server and being stored.
//
// Pricing is stubbed for the page (₪199 a copy, ₪39 a box) so the screen
// arithmetic is pinned. page.request calls bypass page.route and hit the real
// server, whose own settings price the stored order.
const UNIT = 199;
const FEE = 39;
const KEY = 'dugri-admin';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        store: { now: UNIT, was: 239 },
        sale: { on: false, label: '', banner: '' },
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
  // The E2E server has no card provider, so the pay button is hidden; switch it
  // on in the base collection GET only (the glob's `*` never spans `/`).
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const body = await resp.json();
    body.card_enabled = true;
    // Present an order from before the box choice existed (see the last test).
    if (legacyView && body.order) body.order.one_box = null;
    return route.fulfill({ json: body });
  });
});

// Set by the test that needs the page to see an order with no box choice.
let legacyView = false;
test.afterEach(() => {
  legacyView = false;
});

async function createCollection(page, name) {
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#customTitleInput', name);
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#ownerEmail', 'boxes@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.fill('#buyerNameInput', 'דנה כהן');
  await page.getByTestId('next-btn').click();
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
  await page.getByTestId('tab-pay').waitFor({ state: 'visible' });
  await page.getByTestId('tab-pay').click();
  await page.locator('#payPanel > summary').click();
  const url = new URL(page.url());
  return { id: url.searchParams.get('c'), k: url.searchParams.get('k') };
}

test('the box tick appears for 2+ printed copies and moves the delivery price', async ({
  page,
}) => {
  await createCollection(page, 'Boxes');
  await page.locator('input[name="payVersion"][value="pickup"]').check();
  await page.locator('#shipToggle').check();

  // One copy: nothing to choose.
  await expect(page.getByTestId('one-box')).toBeHidden();
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT + FEE));

  await page.getByTestId('qty-plus').click();
  await page.getByTestId('qty-plus').click();
  await expect(page.getByTestId('qty-val')).toHaveText('3');

  // Three copies: offered, unticked — a box each, a fee each.
  await expect(page.getByTestId('one-box')).toBeVisible();
  await expect(page.getByTestId('one-box-toggle')).not.toBeChecked();
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 3 + FEE * 3));
  await expect(page.getByTestId('pay-math')).toContainText('3 קופסאות');
  await expect(page.getByTestId('one-box-note')).toContainText('× 3');
  // The delivery tick quotes what it now adds: three boxes' shipping.
  await expect(page.locator('#shipPrice')).toContainText(String(FEE * 3));

  // All in one box: the fee once.
  await page.getByTestId('one-box-toggle').check();
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 3 + FEE));
  await expect(page.getByTestId('pay-math')).toContainText('קופסה אחת');
  await expect(page.getByTestId('one-box-note')).toContainText('משלוח אחד');
  await expect(page.locator('#shipPrice')).toContainText(String(FEE));

  // Unticked again: back to three fees.
  await page.getByTestId('one-box-toggle').uncheck();
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 3 + FEE * 3));
});

test('on a pickup the tick is offered too, and changes no price', async ({ page }) => {
  await createCollection(page, 'Pickup boxes');
  await page.locator('input[name="payVersion"][value="pickup"]').check();
  await page.getByTestId('qty-plus').click();
  await expect(page.getByTestId('one-box')).toBeVisible();
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 2));
  await page.getByTestId('one-box-toggle').check();
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 2));
  // No delivery, so no price note — the choice only decides the labels.
  await expect(page.getByTestId('one-box-note')).toHaveText('');
});

test('the choice travels to the server, which stores it and prices from it', async ({ page }) => {
  const { id, k } = await createCollection(page, 'Boxes to server');
  await page.locator('input[name="payVersion"][value="pickup"]').check();
  await page.locator('#shipToggle').check();
  await page.fill('#addrStreet', 'הרצל 12');
  await page.fill('#addrCity', 'תל אביב');
  await page.fill('#addrPostal', '6100000');
  await page.getByTestId('qty-plus').click();
  await page.getByTestId('qty-plus').click();
  await page.getByTestId('one-box-toggle').check();

  // Catch what the pay button sends. Answered with a refusal so no gateway
  // window opens; the body is the point.
  let sent = null;
  await page.route('**/api/collections/*/pay/init', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 503, json: { error: 'card payment not configured' } });
  });
  await page.locator('#cardPayBtn').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toMatchObject({ version: 'delivery', quantity: 3, one_box: true });

  // The server, given that same choice, stores it and prices from its OWN
  // settings. Placed as pickup (the E2E server's launch default; delivery is
  // switched off there) and moved to delivery by the owner's edit, which is not
  // gated on the public switch.
  const placed = await page.request.post(`/api/collections/${id}/order`, {
    data: { owner_token: k, version: 'pickup', quantity: sent.quantity, one_box: sent.one_box },
  });
  expect(placed.ok()).toBeTruthy();
  expect(await placed.json()).toMatchObject({ quantity: 3, one_box: true, boxes: 1 });

  const real = await (await page.request.get('/api/pricing')).json();
  const edit = async (order) => {
    const r = await page.request.patch(`/api/admin/collections/${id}?key=${KEY}`, {
      data: { order },
    });
    expect(r.ok()).toBeTruthy();
    return (await (await page.request.get(`/api/collections/${id}`)).json()).order;
  };
  const unit = real.versions.pickup.price;
  const fee = real.delivery_fee;

  let o = await edit({ version: 'delivery', address: sent.address });
  expect(o).toMatchObject({ one_box: true, boxes: 1, delivery_fee: fee, total: unit * 3 + fee });

  // …and the owner splitting it into boxes re-prices it per box.
  o = await edit({ one_box: false });
  expect(o).toMatchObject({
    one_box: false,
    boxes: 3,
    delivery_fee: fee * 3,
    total: unit * 3 + fee * 3,
  });
});

// AN ORDER FROM BEFORE THE CHOICE keeps the fee it was priced at. Its copies are
// PACKED a box each (stickers, HFD), so the tick shows unticked — but until the
// buyer touches it, the fee previews ONCE and pay/init is sent no choice, so the
// server leaves the order as it was rather than re-pricing it per box.
test('an order from before the choice: fee once, and no choice is sent', async ({ page }) => {
  const { id, k } = await createCollection(page, 'Legacy boxes');
  const placed = await page.request.post(`/api/collections/${id}/order`, {
    data: { owner_token: k, version: 'pickup', quantity: 3 },
  });
  expect(placed.ok()).toBeTruthy();
  legacyView = true;
  await page.reload();
  await page.getByTestId('tab-pay').waitFor({ state: 'visible' });
  await page.getByTestId('tab-pay').click();
  await page.locator('#payPanel > summary').click();
  await expect(page.getByTestId('qty-val')).toHaveText('3');

  await page.locator('input[name="payVersion"][value="pickup"]').check();
  await page.locator('#shipToggle').check();
  await expect(page.getByTestId('one-box')).toBeVisible();
  await expect(page.getByTestId('one-box-toggle')).not.toBeChecked();
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 3 + FEE));
  await expect(page.getByTestId('one-box-note')).toHaveText('');

  await page.fill('#addrStreet', 'הרצל 12');
  await page.fill('#addrCity', 'תל אביב');
  await page.fill('#addrPostal', '6100000');
  let sent = null;
  await page.route('**/api/collections/*/pay/init', (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 503, json: { error: 'card payment not configured' } });
  });
  await page.locator('#cardPayBtn').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent.quantity).toBe(3);
  expect('one_box' in sent).toBe(false);

  // Touching the tick is a real choice, and from then on it is priced and sent.
  await page.getByTestId('one-box-toggle').check();
  await page.getByTestId('one-box-toggle').uncheck();
  await expect(page.locator('#payTotal')).toHaveText(String(UNIT * 3 + FEE * 3));
});
