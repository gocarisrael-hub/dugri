import { test, expect } from '@playwright/test';

// THE BOX QR, as the person holding the box meets it: scan the QR on a printed
// game's sticker, leave an email, get the order's ONE personal code on screen —
// and never again after that — then use it on an order of their own.
//
// The rules (one per order, no leak, not on its own order, spent on paid, the
// staff key) are pinned against the real store in tests/unit/box-qr-coupon.test.js;
// the sticker's QR is rendered and scanned in generator/test_pickup_stickers.py.
//
// A box needs a PAID physical order, and the e2e server takes no card payment —
// so the source order is paid the one real way it can be here, a 100% owner
// coupon. Its box link comes from the owner's admin route (the same token the
// sticker prints), since there is no generator here to print a sticker.

const KEY = 'dugri-admin';
const uniq = (p) => `${p}${Math.random().toString(36).slice(2, 8)}`;

async function makeParty(request, name) {
  const r = await request.post('/api/collections', { data: { honoree_name: name } });
  expect(r.ok()).toBeTruthy();
  const { id, owner_token: k } = await r.json();
  return { id, k };
}

// A paid self-collection order (a box exists) and its box QR path.
async function boxWithQr(request) {
  const free = uniq('BOXFREE').toUpperCase();
  const c = await request.post(`/api/admin/coupons?key=${KEY}`, {
    data: { code: free, discount_pct: 100, valid_until: null },
  });
  expect(c.status()).toBe(201);
  const party = await makeParty(request, 'Shira');
  const paid = await request.post(`/api/collections/${party.id}/pay/init`, {
    data: { owner_token: party.k, version: 'pickup', coupon: free },
  });
  expect(paid.ok()).toBeTruthy();
  const link = await request.get(`/api/admin/collections/${party.id}/box-qr?key=${KEY}`);
  expect(link.status()).toBe(200);
  const { path, claimed } = await link.json();
  expect(claimed).toBe(false);
  expect(path).toMatch(/^\/box\?t=[A-Za-z0-9_-]{22}$/);
  return { party, path };
}

test('scan the box → claim the code once → it applies on a new order', async ({
  page,
  request,
}) => {
  const { path } = await boxWithQr(request);

  await page.goto(path);
  const card = page.getByTestId('box-card');
  await expect(card).toHaveAttribute('data-state', 'open');
  await expect(page.locator('h1')).toHaveText('החזקתם דוגרי ביד? מגיע לכם 10%');
  // Marketing consent is offered ticked (the owner's standing choice).
  await expect(page.getByTestId('box-consent')).toBeChecked();

  await page.getByTestId('box-email').fill('scan.' + uniq('x') + '@example.com');
  await page.getByTestId('box-submit').click();
  await expect(card).toHaveAttribute('data-state', 'done');
  const code = (await page.getByTestId('box-code').innerText()).trim();
  expect(code).toMatch(/^SCAN10-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  await expect(page.getByTestId('box-start')).toHaveAttribute(
    'href',
    new RegExp('^/\\?coupon=' + code + '&')
  );

  // Scanned again — by the same phone or anyone's — it is claimed, and the code
  // is nowhere on the page.
  await page.reload();
  await expect(card).toHaveAttribute('data-state', 'claimed');
  await expect(page.getByTestId('box-claimed')).toContainText('כבר נלקח');
  expect(await page.content()).not.toContain(code);

  // The code at work: the start link lands with it active, and a new order's
  // checkout takes it. Pickup 199, minus 10% of the game: 179.
  await page.goto(`/?coupon=${code}&utm_source=coupon&utm_medium=qr&utm_campaign=box_qr`);
  await expect(page.getByTestId('coupon-landing')).toHaveText(/10% הנחה/);
  const mine = await makeParty(request, 'Dana');
  await page.goto(`/collect.html?c=${mine.id}&k=${mine.k}`);
  const tab = page.getByTestId('tab-pay');
  await tab.waitFor({ state: 'visible' });
  await tab.click();
  await page.locator('#payPanel > summary').click();
  await expect(page.locator('#couponInput')).toHaveValue(code);
  await expect(page.locator('#couponMsg')).toContainText('10% הנחה');
  await expect(page.locator('#payTotal')).toHaveText('179');
});

test('a link no box carries says so', async ({ page }) => {
  await page.goto('/box?t=AAAAAAAAAAAAAAAAAAAAAA');
  await expect(page.getByTestId('box-card')).toHaveAttribute('data-state', 'not_found');
});

test('the coupons page shows the QR section to the owner', async ({ page, request }) => {
  const { path } = await boxWithQr(request);
  const email = uniq('qradmin') + '@example.com';
  const t = new URL('http://x' + path).searchParams.get('t');
  const r = await request.post(`/api/box-qr/${t}`, { data: { email } });
  const { code } = await r.json();

  await page.goto(`/coupons.html?key=${KEY}`);
  const panel = page.getByTestId('qr-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('qr-summary-row')).toContainText('קופוני QR, 10%');
  await expect(page.locator('#qrMonths')).toHaveValue('6');
  await page.getByTestId('qr-summary-row').click();
  await page.getByTestId('qr-search').fill(email);
  const rows = panel.locator('[data-testid="qr-row"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(code);
  // The friend section does not list it.
  await page.getByTestId('friend-summary-row').click();
  await page.getByTestId('friend-search').fill(email);
  await expect(page.locator('[data-testid="friend-row"]')).toHaveCount(0);
});
