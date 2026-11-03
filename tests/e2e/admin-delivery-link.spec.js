// THE OWNER'S "ADD DELIVERY" LINK, end to end in the browser: the button on a
// closed, paid pickup row; the dialog that makes the link; the customer's page
// that takes the address and the payment; and the order back in the orders
// table as a delivery, counted on the sticker button.
//
// The E2E server runs without card or courier credentials on purpose (a test
// never charges a card or books a van), and an order cannot be made PAID in its
// store without a real money event. So the paid states are injected on their
// way to the browser, as admin-hfd.spec.js and admin-ready-batch.spec.js do.
// The server half — link create/replace/cancel, the settle, the conversion, the
// automatic booking and the sticker feed — is tests/unit/delivery-link.test.js.
import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

const KEY = 'dugri-admin';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
const uniq = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const stageChip = (page, id) => page.locator(`#tabs-stage button[data-filter="${id}"]`);

function row(name, order, extra = {}) {
  const now = new Date().toISOString();
  return {
    id: 'dl-' + name,
    honoree_name: name,
    order_no: 'DG-7001',
    owner_token: 'tok',
    created_at: now,
    expires_at: new Date(Date.now() + 864e5).toISOString(),
    status: 'closed',
    word_count: 120,
    production: { state: 'generated', pages: 208, released_at: now },
    order: {
      paid: true,
      total: 199,
      charged_total: 199,
      quantity: 1,
      production: { state: 'generated', pages: 208, released_at: now },
      ...order,
    },
    ...extra,
  };
}

async function injectRows(page, rows) {
  await page.route('**/api/admin/collections*', async (route) => {
    const resp = await route.fetch();
    const body = await resp.json();
    body.collections = rows;
    await route.fulfill({ response: resp, json: body });
  });
}

test('the owner makes, copies and cancels a link from a closed pickup row', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const name = uniq('קישור');
  await injectRows(page, [row(name, { version: 'pickup' })]);

  // The link routes, as the server answers them for an eligible order.
  let link = null;
  const posted = [];
  await page.route('**/api/admin/collections/*/delivery-link*', async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'POST') {
      const amount = JSON.parse(req.postData()).amount;
      posted.push(amount);
      link = {
        token: TOKEN,
        amount,
        created_at: new Date().toISOString(),
        cancelled_at: null,
        paid: false,
      };
    } else if (method === 'DELETE') {
      link = { ...link, cancelled_at: new Date().toISOString() };
    }
    const live = link && !link.cancelled_at;
    return route.fulfill({
      status: method === 'POST' ? 201 : 200,
      json: {
        eligible: true,
        reason: null,
        message: null,
        default_fee: 39,
        boxes: 1,
        link,
        url: live ? 'https://dugri-israel.co.il/add-delivery.html?t=' + TOKEN : null,
      },
    });
  });

  await page.goto(`/admin.html?key=${KEY}`);
  const r = page.locator('tbody tr', { hasText: name });
  await r.getByTestId('delivery-link-btn').click();

  const dlg = page.getByTestId('dlink');
  await expect(dlg).toBeVisible();
  // Prefilled from the settings price the server reports, and hers to change.
  await expect(page.getByTestId('dl-amount')).toHaveValue('39');
  await page.getByTestId('dl-amount').fill('30');
  await page.getByTestId('dl-create').click();
  expect(posted).toEqual([30]);
  await expect(page.getByTestId('dl-url')).toHaveValue(/add-delivery\.html\?t=/);
  await expect(page.getByTestId('dl-status')).toContainText('30 ₪');

  await page.getByTestId('dl-copy').click();
  await expect(page.getByTestId('dl-status')).toContainText('הועתק');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    'add-delivery.html?t=' + TOKEN
  );

  page.once('dialog', (d) => d.accept());
  await page.getByTestId('dl-cancel').click();
  await expect(page.getByTestId('dl-url')).toBeHidden();
  await expect(page.getByTestId('dl-status')).toContainText('בוטל');
});

test('no link button on an open collection or a delivery order', async ({ page }) => {
  const open = uniq('פתוח');
  const deliv = uniq('משלוח');
  await injectRows(page, [
    row(open, { version: 'pickup' }, { status: 'open' }),
    row(deliv, {
      version: 'delivery',
      address: { street: 'הרצל 5', city: 'תל אביב', postal: '6100000' },
    }),
  ]);
  await page.goto(`/admin.html?key=${KEY}`);
  await expect(page.locator('tbody tr', { hasText: open })).toBeVisible();
  await expect(page.getByTestId('delivery-link-btn')).toHaveCount(0);
});

// The customer's page, with the gateway stubbed: pay hands back the URL of our
// own return page, which (inside the frame) tells this page the payment went
// through — exactly what the provider's return does — and the next read of the
// link says paid.
async function stubCustomerApi(page, { paidAfterPay = true } = {}) {
  let paid = false;
  const calls = [];
  await page.route(`**/api/delivery-link/${TOKEN}/pay`, async (route) => {
    calls.push(JSON.parse(route.request().postData()));
    if (paidAfterPay) paid = true;
    return route.fulfill({ json: { url: '/pay-done.html', charged: 39 } });
  });
  await page.route(`**/api/delivery-link/${TOKEN}`, (route) =>
    route.fulfill({
      json: {
        order_ref: 'DG-7001',
        honoree: 'נועה',
        amount: 39,
        boxes: 1,
        paid,
        paid_at: paid ? new Date().toISOString() : null,
        payable: !paid,
        card_enabled: true,
        address: paid
          ? { street: 'הרצל 12', city: 'תל אביב', postal: '6100000', phone: '0521234567' }
          : null,
      },
    })
  );
  return calls;
}

async function fillAndPay(page) {
  await page.getByTestId('ad-street').fill('הרצל 12');
  await page.getByTestId('ad-city').fill('תל אביב');
  await page.getByTestId('ad-postal').fill('6100000');
  await page.getByTestId('ad-phone').fill('052-123-4567');
  await page.getByTestId('ad-pay').click();
}

test('the customer pays on the link page and sees the confirmation', async ({ page }) => {
  const calls = await stubCustomerApi(page);
  await page.goto('/add-delivery.html?t=' + TOKEN);
  await expect(page.getByTestId('ad-form')).toBeVisible();
  await expect(page.getByTestId('ad-order-ref')).toHaveText('DG-7001');
  await expect(page.getByTestId('ad-honoree')).toHaveText('נועה');
  await expect(page.getByTestId('ad-amount')).toHaveText('39');

  // The checkout's own validation: address first, then a mobile.
  await page.getByTestId('ad-pay').click();
  await expect(page.getByTestId('ad-err')).toContainText('רחוב, עיר ומיקוד');
  await page.getByTestId('ad-street').fill('הרצל 12');
  await page.getByTestId('ad-city').fill('תל אביב');
  await page.getByTestId('ad-postal').fill('6100000');
  await page.getByTestId('ad-phone').fill('123');
  await page.getByTestId('ad-pay').click();
  await expect(page.getByTestId('ad-err')).toContainText('נייד');
  expect(calls).toHaveLength(0);

  await fillAndPay(page);
  await expect(page.getByTestId('ad-paid')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('ad-paid-addr')).toContainText('הרצל 12');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    address: { street: 'הרצל 12', city: 'תל אביב', postal: '6100000' },
    phone: '0521234567',
  });
});

test('a dead link says so', async ({ page }) => {
  await page.goto('/add-delivery.html?t=' + 'Z'.repeat(24));
  await expect(page.getByTestId('ad-invalid')).toBeVisible();
});

test('the link page in the redesign', async ({ page }) => {
  await previewRedesign(page);
  await stubCustomerApi(page);
  await page.goto('/add-delivery.html?t=' + TOKEN);
  await expect(page.locator('html')).toHaveClass(/\brd\b/);
  await expect(page.getByTestId('ad-form')).toBeVisible();
  await expect(page.locator('#form h1')).toHaveClass(/rd-title/);
  await expect(page.getByTestId('ad-pay')).toHaveClass(/rd-btn/);
  // Nothing spills sideways at phone width.
  await page.setViewportSize({ width: 360, height: 780 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await fillAndPay(page);
  await expect(page.getByTestId('ad-paid')).toBeVisible({ timeout: 15000 });
});

test('once paid, the order is a delivery with its courier booked, and on the sticker button', async ({
  page,
}) => {
  const name = uniq('הומר');
  const now = new Date().toISOString();
  await injectRows(page, [
    row(name, {
      version: 'delivery',
      address: { street: 'הרצל 12', city: 'תל אביב', postal: '6100000', phone: '0521234567' },
      delivery_fee: 39,
      total: 238,
      charged_total: 238,
      hfd: { shipment_number: '987654', rand_number: 'r-1', sent_at: now, cancelled_at: null },
      shipping: {
        fee: 39,
        paid: true,
        paid_at: now,
        charged_total: 39,
        link: {
          token: TOKEN,
          amount: 39,
          created_at: now,
          cancelled_at: null,
          hfd_auto: { at: now, ok: true, shipments: ['987654'] },
        },
      },
    }),
  ]);
  await page.route('**/api/admin/hfd/status*', (route) =>
    route.fulfill({ json: { configured: true, clientNumber: '4242' } })
  );
  await page.goto(`/admin.html?key=${KEY}`);
  const r = page.locator('tbody tr', { hasText: name });
  await expect(r).toContainText('משלוח נוסף אחרי התשלום');
  await expect(r).toContainText('HFD 987654');
  await expect(r.getByTestId('delivery-link-btn')).toHaveText('משלוח שולם בקישור');

  await stageChip(page, 'to-print').click();
  await expect(page.getByTestId('pickup-stickers')).toBeVisible();
  await expect(page.locator('#stickerCount')).toHaveText('1');
});

// The link is money: the staff key never sees the button or the dialog, and the
// orders page still works for her (js/admin-role.js strips every [data-money]).
test('the worker gets no link button, and her orders page still loads', async ({ page }) => {
  const name = uniq('עובדת');
  await injectRows(page, [row(name, { version: 'pickup' })]);
  await page.goto('/admin.html?key=dugri-staff');
  await expect(page.locator('tbody tr', { hasText: name })).toBeVisible();
  await expect(page.locator('#stats')).toBeVisible();
  await expect(page.getByTestId('delivery-link-btn')).toHaveCount(0);
  await expect(page.getByTestId('dlink')).toHaveCount(0);
});
