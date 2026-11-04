import { test, expect } from '@playwright/test';
import fs from 'node:fs';

// THE BOX QR, as the person holding the game meets it: ONE static QR on the box
// art opens /box, they type the phone number the order was placed with, and the
// code that order earned is on screen (and, says the page, in the order's inbox)
// — then it carries into a new order's checkout.
//
// WHAT THE E2E SERVER CANNOT DO. A code is earned by a PAID and PRODUCED order,
// and this server can reach neither: it takes no card payment for a produced
// deck and has no Python to build one. So where a test needs an issued code, the
// claim's ANSWER is stubbed and carries a real code issued the real way here (a
// friend code, through the same coupon pipeline the QR codes use), and the page,
// its start link, the landing and the checkout all run for real. The rules
// themselves — the phone match, eligibility, one per produced order oldest
// first, the rate limits, "not on its own order" — are pinned against the real
// store in tests/unit/box-qr-coupon.test.js.

const KEY = 'dugri-admin';
const uniq = (p) => `${p}${Math.random().toString(36).slice(2, 8)}`;
const randomPhone = () => '058' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');

async function makeParty(request, name) {
  const r = await request.post('/api/collections', { data: { honoree_name: name } });
  expect(r.ok()).toBeTruthy();
  const { id, owner_token: k } = await r.json();
  return { id, k };
}

test('scan → phone → the code on screen with the masked address → it applies on a new order', async ({
  page,
  request,
}) => {
  const party = await makeParty(request, 'Noa');
  const issued = await request.post('/api/friend-coupon', {
    data: { email: uniq('scan') + '@example.com', collection_id: party.id },
  });
  const { code } = await issued.json();
  expect(code).toMatch(/^SCAN/);

  let sent = null;
  await page.route('**/api/box-qr', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ok: true,
        created: true,
        emailed: true,
        email: 'ha***@gmail.com',
        code,
        percent: 5,
        expires_at: new Date(Date.now() + 864e5 * 180).toISOString(),
      },
    });
  });

  await page.goto('/box');
  const card = page.getByTestId('box-card');
  await expect(card).toHaveAttribute('data-state', 'open');
  // The owner's words, from the real server.
  await expect(page.locator('h1')).toHaveText('תודה שבחרתם בדוגרי! מגיע לכם 10% הנחה לפעם הבאה');
  await expect(card).toContainText(
    'הקלידו את מספר הטלפון שאיתו הזמנתם, ותקבלו קוד אישי של 10% הנחה למשחק הבא. ' +
      'הקוד בתוקף ל-6 חודשים. ושוב תודה :)'
  );
  // Ticked by default: the owner's standing choice.
  await expect(page.getByTestId('box-consent')).toBeChecked();
  await expect(card).toContainText('אשמח לקבל מדוגרי עדכונים והטבות במייל');

  await page.getByTestId('box-phone').fill('+972 52-727-5047');
  await page.getByTestId('box-submit').click();
  await expect(card).toHaveAttribute('data-state', 'done');
  // The number goes as typed: the server normalises it.
  expect(sent).toEqual({ phone: '+972 52-727-5047', marketing_consent: true });
  await expect(page.getByTestId('box-code')).toHaveText(code);
  await expect(page.getByTestId('box-emailed')).toHaveText(
    'שלחנו אותו גם ל-ha***@gmail.com, שלא ילך לאיבוד.'
  );
  const start = page.getByTestId('box-start');
  await expect(start).toHaveAttribute('href', new RegExp('^/\\?coupon=' + code + '&'));

  // The code at work: the start link lands with it active, and a new order's
  // checkout takes it. Pickup 199, minus 5% of the game: 189.
  await start.click();
  await expect(page.getByTestId('coupon-landing')).toHaveText(/5% הנחה/);
  const mine = await makeParty(request, 'Dana');
  await page.goto(`/collect.html?c=${mine.id}&k=${mine.k}`);
  const tab = page.getByTestId('tab-pay');
  await tab.waitFor({ state: 'visible' });
  await tab.click();
  await page.locator('#payPanel > summary').click();
  await expect(page.locator('#couponInput')).toHaveValue(code);
  await expect(page.locator('#couponMsg')).toContainText('5% הנחה');
  await expect(page.locator('#payTotal')).toHaveText('189');
});

test('a number with no produced order: the neutral message, and the form stays for another try', async ({
  page,
}) => {
  // The real server: this number has never ordered.
  await page.goto('/box');
  const card = page.getByTestId('box-card');
  await expect(card).toHaveAttribute('data-state', 'open');
  await page.getByTestId('box-phone').fill(randomPhone());
  await page.getByTestId('box-submit').click();
  await expect(card).toHaveAttribute('data-miss', '1');
  await expect(page.getByTestId('box-err')).toHaveText(
    'לא מצאנו משחק שהפקנו למספר הזה. נסו את המספר שנתתם כשהזמנתם, בדיוק אותו אחד.'
  );
  await expect(card).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('box-submit')).toBeEnabled();
  await expect(page.getByTestId('box-code')).toHaveCount(0);
});

test('unticking the marketing box sends consent false', async ({ page }) => {
  let sent = null;
  await page.route('**/api/box-qr', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, all_claimed: true } });
  });
  await page.goto('/box');
  const consent = page.getByTestId('box-consent');
  await expect(consent).toBeChecked();
  await consent.uncheck();
  await page.getByTestId('box-phone').fill('0527275047');
  await page.getByTestId('box-submit').click();
  await expect(page.getByTestId('box-card')).toHaveAttribute('data-state', 'all_claimed');
  expect(sent).toEqual({ phone: '0527275047', marketing_consent: false });
});

test('not a phone number is caught before it is sent', async ({ page }) => {
  let posted = false;
  await page.route('**/api/box-qr', (route) => {
    if (route.request().method() === 'POST') posted = true;
    return route.fallback();
  });
  await page.goto('/box');
  await page.getByTestId('box-phone').fill('1234');
  await page.getByTestId('box-submit').click();
  await expect(page.getByTestId('box-err')).toHaveText('המספר לא נראה תקין');
  expect(posted).toBe(false);
});

test('every code of the number already claimed: says so, and shows no code', async ({ page }) => {
  await page.route('**/api/box-qr', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: { ok: true, all_claimed: true } })
      : route.fallback()
  );
  await page.goto('/box');
  await page.getByTestId('box-phone').fill('0527275047');
  await page.getByTestId('box-submit').click();
  const card = page.getByTestId('box-card');
  await expect(card).toHaveAttribute('data-state', 'all_claimed');
  await expect(page.getByTestId('box-all-claimed')).toContainText('כבר נלקחו');
  await expect(page.getByTestId('box-code')).toHaveCount(0);
});

test('in the redesign the page takes the kit’s look', async ({ page }) => {
  await page.goto('/box?rd=1');
  await expect(page.locator('html')).toHaveClass(/(^|\s)rd(\s|$)/);
  await expect(page.locator('link[href*="/css/rd/box."]')).toHaveCount(1);
  await expect(page.getByTestId('box-card')).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('box-card')).toHaveClass(/rd-box/);
  await expect(page.getByTestId('box-submit')).toHaveClass(/rd-btn/);
  // The same words and the same ticked box in the new look.
  await expect(page.locator('h1')).toHaveText('תודה שבחרתם בדוגרי! מגיע לכם 10% הנחה לפעם הבאה');
  await expect(page.getByTestId('box-card')).toContainText('ושוב תודה :)');
  await expect(page.getByTestId('box-consent')).toBeChecked();
  await expect(page.getByTestId('box-consent')).toBeVisible();
  await page.goto('/box?rd=0');
});

test('the coupons page: the QR section, its settings, and the static QR to download', async ({
  page,
}) => {
  // The e2e server has no PUBLIC_BASE_URL to build the QR from; the picture the
  // real route draws is decoded in the unit test. Here: what the page does with it.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><rect width="29" height="29" fill="#fff"/><path fill="#000" d="M4 4h7v1h-7z"/></svg>';
  await page.route('**/api/admin/box-qr?*', (route) =>
    route.fulfill({ json: { url: 'https://staging.example/box', svg } })
  );
  // The list behind the summary row, with a row this server cannot issue.
  await page.route('**/api/admin/friend-coupons?source=qr*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.coupons = [
      {
        id: 'qr-1',
        source: 'qr',
        email: 'buyer@example.com',
        code: 'DUGRI10-K7Q2-ABCD-EFGH',
        box_order_no: 'DG-1234',
        created_at: new Date().toISOString(),
        used_at: null,
        email_sent_at: new Date().toISOString(),
        email_sends: 1,
      },
    ];
    await route.fulfill({ json: body });
  });

  await page.goto(`/coupons.html?key=${KEY}`);
  const panel = page.getByTestId('qr-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('qr-summary-row')).toContainText('קופוני QR, 10%');
  await expect(page.locator('#qrMonths')).toHaveValue('6');
  await expect(page.locator('#qrLead')).toHaveValue(/מספר הטלפון שאיתו הזמנתם/);
  await expect(page.locator('#qrNoMatch')).toHaveValue(/לא מצאנו משחק שהפקנו/);
  // Nothing of the sticker is left on the page.
  await expect(panel).not.toContainText('מדבקה');

  await expect(page.getByTestId('qr-url')).toHaveText('https://staging.example/box');
  const [svgFile] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('qr-svg').click(),
  ]);
  expect(svgFile.suggestedFilename()).toBe('dugri-box-qr.svg');
  expect(fs.readFileSync(await svgFile.path(), 'utf8')).toBe(svg);
  const [pngFile] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('qr-png').click(),
  ]);
  expect(pngFile.suggestedFilename()).toBe('dugri-box-qr.png');
  const png = fs.readFileSync(await pngFile.path());
  // A real PNG, drawn big enough to print: the signature, then 1200 x 1200.
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(1200);
  expect(png.readUInt32BE(20)).toBe(1200);

  await page.getByTestId('qr-summary-row').click();
  const rows = panel.locator('[data-testid="qr-row"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('DUGRI10-K7Q2-ABCD-EFGH');
  await expect(rows.first()).toContainText('DG-1234');
});

test('the coupons page says so when there is no address to build the QR from', async ({ page }) => {
  // The e2e server's own answer: no PUBLIC_BASE_URL.
  await page.goto(`/coupons.html?key=${KEY}`);
  await expect(page.getByTestId('qr-panel')).toBeVisible();
  await expect(page.locator('#qrNoUrl')).toBeVisible();
  await expect(page.getByTestId('qr-png')).toBeDisabled();
});
