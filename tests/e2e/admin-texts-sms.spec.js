import { test, expect } from '@playwright/test';

// The SMS section of the texts editor (admin-texts.html).
//
// Its two settings existed on the server with no screen to change them, while
// the setup guide told the owner to switch SMS on here — so she went looking for
// a switch that did not exist. The status line matters as much as the switch:
// SMS switched on with a phone that never checks in looks exactly like SMS
// working, until a customer says she never got the text.
const KEY = 'dugri-admin';

// The writes go to the shared settings store, which both device projects share
// through one server; run the writing tests once. (Same guard, and the same
// reason, as admin-analytics.spec.js.)
const OWNS_STORE = 'Desktop Chrome';

async function resetSms(request) {
  for (const k of ['enabled', 'order_ready']) {
    const r = await request.delete(`/api/admin/settings?section=sms&settingKey=${k}&key=${KEY}`);
    expect(r.ok()).toBeTruthy();
  }
}

// The phone's real state is whatever the shared e2e server last saw, so the
// status line is pinned by stubbing the one read it makes.
function stubStatus(page, body) {
  return page.route('**/api/admin/sms?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        gateway_configured: true,
        last_poll_at: null,
        counts: { pending: 0, taken: 0, sent: 0, failed: 0, expired: 0 },
        messages: [],
        ...body,
      }),
    })
  );
}

test.describe('editing the SMS', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== OWNS_STORE, 'writes the shared settings store; run once');
    await resetSms(request);
  });
  test.afterEach(async ({ request }, testInfo) => {
    if (testInfo.project.name !== OWNS_STORE) return;
    await resetSms(request);
  });

  test('shows the switch and the text the phone will send', async ({ page }) => {
    await stubStatus(page, {});
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.getByTestId('sms-card')).toBeVisible();
    await expect(page.getByTestId('sms-enabled')).not.toBeChecked();
    await expect(page.getByTestId('sms-text')).toHaveValue(/\{honoree\}/);
    await expect(page.getByTestId('sms-count')).toContainText('/ 300');
  });

  test('the switch and the text survive a save and a reload', async ({ page }) => {
    await stubStatus(page, {});
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await page.getByTestId('sms-enabled').check();
    await page.getByTestId('sms-text').fill('ההזמנה של {honoree} מוכנה לאיסוף');
    await page.getByTestId('sms-save').click();
    await expect(page.getByTestId('sms-save-status')).toHaveText('נשמר ✓');

    await page.reload();
    await expect(page.getByTestId('sms-enabled')).toBeChecked();
    await expect(page.getByTestId('sms-text')).toHaveValue('ההזמנה של {honoree} מוכנה לאיסוף');
  });

  // The store keeps ONE line. Showing a line break she typed, then sending the
  // message without it, would be the box lying about the text.
  test('a line break becomes a space as she types, and the length is capped', async ({ page }) => {
    await stubStatus(page, {});
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const box = page.getByTestId('sms-text');
    await box.fill('שורה\nשנייה');
    await expect(box).toHaveValue('שורה שנייה');
    await box.fill('א'.repeat(400));
    await expect(box).toHaveValue('א'.repeat(300));
    await expect(page.getByTestId('sms-count')).toContainText('300 / 300');
  });

  test('an empty message is refused rather than saved', async ({ page }) => {
    await stubStatus(page, {});
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await page.getByTestId('sms-text').fill('   ');
    await page.getByTestId('sms-save').click();
    await expect(page.getByTestId('sms-save-status')).toContainText('ריק');
  });
});

test.describe('whether the phone is actually collecting', () => {
  test('says the phone key is missing, by name', async ({ page }) => {
    await stubStatus(page, { gateway_configured: false });
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const st = page.getByTestId('sms-status');
    await expect(st).toContainText('הטלפון לא מחובר');
    await expect(st).toContainText('SMS_GATEWAY_KEY');
  });

  test('says the phone has not checked in yet', async ({ page }) => {
    await stubStatus(page, { last_poll_at: null });
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.getByTestId('sms-status')).toContainText('הטלפון עוד לא בדק');
  });

  test('says when the phone last checked in, and what is queued', async ({ page }) => {
    await stubStatus(page, {
      last_poll_at: new Date(Date.now() - 2 * 60000).toISOString(),
      counts: { pending: 1, taken: 0, sent: 4, failed: 0, expired: 0 },
    });
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const st = page.getByTestId('sms-status');
    await expect(st).toContainText('הטלפון מחובר');
    await expect(st).toContainText('לפני 2 דקות');
    await expect(page.getByTestId('sms-queue')).toContainText('1 ממתינות');
    await expect(page.getByTestId('sms-queue')).toContainText('4 נשלחו');
  });

  // A quarter of an hour of silence is a phone that is off or has lost the flow
  // — which, from the outside, looks exactly like SMS working.
  test('warns when the phone has gone quiet', async ({ page }) => {
    await stubStatus(page, { last_poll_at: new Date(Date.now() - 3 * 3600000).toISOString() });
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.getByTestId('sms-status')).toContainText('לא בדק מזמן');
  });
});
