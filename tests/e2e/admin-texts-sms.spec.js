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

// THE TEXT ONLY. `sms.enabled` is a single value on the one server this whole
// suite shares, and sms-gateway.spec.js turns it ON in its own beforeEach and
// then presses מוכן — so a DELETE of that key from here, landing in the gap
// between that spec's write and its assertion, fails a test in another file for
// no reason anyone reading it could see. Nothing in this file needs the switch
// reset: what it asserts about the switch is pinned per test (pinEnabled) or is
// a value this test itself just saved.
async function resetSms(request) {
  const r = await request.delete(
    `/api/admin/settings?section=sms&settingKey=order_ready&key=${KEY}`
  );
  expect(r.ok()).toBeTruthy();
}

// What THIS page is told the switch is. The same shared-switch problem in the
// other direction: an assertion that the box is off cannot be left to depend on
// whether another spec happened to turn SMS on a moment earlier. Only the read
// is pinned — saves and resets still go to the real server.
function pinEnabled(page, enabled) {
  return page.route('**/api/admin/settings?**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json();
    if (body && body.effective && body.effective.sms) body.effective.sms.enabled = enabled;
    return route.fulfill({ response: res, body: JSON.stringify(body) });
  });
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
    await pinEnabled(page, false);
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.getByTestId('sms-card')).toBeVisible();
    await expect(page.getByTestId('sms-enabled')).not.toBeChecked();
    await expect(page.getByTestId('sms-text')).toHaveValue(/\{honoree\}/);
    await expect(page.getByTestId('sms-count')).toContainText('/ 700');
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

  // Her pickup message is laid out in lines, and an SMS carries them as they are.
  test('keeps her line breaks, and caps the length at 700', async ({ page }) => {
    await stubStatus(page, {});
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const box = page.getByTestId('sms-text');
    await box.fill('שורה\nשנייה');
    await expect(box).toHaveValue('שורה\nשנייה');
    await box.fill('א'.repeat(800));
    await expect(box).toHaveValue('א'.repeat(700));
    await expect(page.getByTestId('sms-count')).toContainText('700 / 700');
  });

  // The phone sends only as many parts as Automate's "Multipart limit" allows
  // (default 1) and cuts the rest without a word — exactly how her first test
  // arrived half-written. So the box names the number to set.
  test('a long message says how many parts it is, and what to set on the phone', async ({
    page,
  }) => {
    await stubStatus(page, {});
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const box = page.getByTestId('sms-text');
    const count = page.getByTestId('sms-count');
    await box.fill('א'.repeat(200)); // 200 Hebrew characters: ceil(200 / 67) = 3 parts
    await expect(count).toContainText('3 חלקים');
    await expect(count).toContainText('Multipart limit צריך להיות לפחות 3');
    await box.fill('קצר');
    await expect(count).toContainText('הודעה אחת');
    await expect(count).not.toContainText('Multipart limit');
  });

  // THE COUNT IS ON THE MESSAGE, NOT ON THE BOX. `{link}` is six characters here
  // and about 117 once the server fills it in; `{honoree}` is nine and up to
  // eighty. Measured as typed, the shipped default is 53 characters — "הודעה
  // אחת", no advice — while what is actually queued is three parts. The owner
  // left Automate's Multipart limit at its default of 1 and the customer got a
  // third of a message with the link cut off.
  test('counts the message that will be SENT, tokens filled in', async ({ page }) => {
    await stubStatus(page, {});
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const count = page.getByTestId('sms-count');
    // The shipped default, untouched.
    await expect(page.getByTestId('sms-text')).toHaveValue(/\{link\}/);
    await expect(count).not.toContainText('הודעה אחת');
    await expect(count).toContainText('Multipart limit');
    // It says WHY the two numbers differ, or the bigger one looks like a bug.
    await expect(count).toContainText('בשליחה');
    await expect(count).toContainText('53 / 700');
  });

  test('a token is what makes the difference, not the length of the box', async ({ page }) => {
    await stubStatus(page, {});
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const box = page.getByTestId('sms-text');
    const count = page.getByTestId('sms-count');
    await box.fill('ההזמנה מוכנה');
    await expect(count).toContainText('הודעה אחת');
    await expect(count).not.toContainText('בשליחה');
    // The same short line with a link in it is three parts on the wire.
    await box.fill('ההזמנה מוכנה {link}');
    await expect(count).not.toContainText('הודעה אחת');
    await expect(count).toContainText('בשליחה');
  });

  // resetSms asks for the default TEXT back. It used to repaint the whole card,
  // which re-read the SAVED switch position — so the owner ticked מופעל, pressed
  // reset to get the default wording, saw "אופס ✓", and left the page believing
  // SMS was on while the switch had quietly flipped back to off.
  test('resetting the wording leaves the switch where she put it', async ({ page }) => {
    await stubStatus(page, {});
    await page.goto(`/admin-texts.html?key=${KEY}`);
    page.on('dialog', (d) => d.accept());
    const box = page.getByTestId('sms-enabled');
    await box.check();
    await page.getByTestId('sms-text').fill('נוסח אחר לגמרי');
    await page.getByTestId('sms-reset').click();
    await expect(page.getByTestId('sms-save-status')).toHaveText('אופס ✓');
    await expect(page.getByTestId('sms-text')).toHaveValue(/\{honoree\}/);
    await expect(box).toBeChecked();
  });

  test('a message in several lines survives a save and a reload', async ({ page }) => {
    await stubStatus(page, {});
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await page.getByTestId('sms-text').fill('היי!\nההזמנה מוכנה.\n\nתודה רבה!!');
    await page.getByTestId('sms-save').click();
    await expect(page.getByTestId('sms-save-status')).toHaveText('נשמר ✓');
    await page.reload();
    await expect(page.getByTestId('sms-text')).toHaveValue('היי!\nההזמנה מוכנה.\n\nתודה רבה!!');
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
      last_poll_at: new Date(Date.now() - 5 * 60000).toISOString(),
      counts: { pending: 1, taken: 0, sent: 4, failed: 0, expired: 0 },
    });
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const st = page.getByTestId('sms-status');
    await expect(st).toContainText('הטלפון מחובר');
    await expect(st).toContainText('לפני 5 דקות');
    await expect(page.getByTestId('sms-queue')).toContainText('1 ממתינות');
    await expect(page.getByTestId('sms-queue')).toContainText('4 נשלחו');
  });

  // EXPIRED IS THE ONE THAT MEANS A CUSTOMER WAS NEVER TOLD. A message the phone
  // failed to collect inside its 12-hour window reconciles to `expired`, not
  // `failed` — so a night of unsent "המשחק מוכן" rendered here exactly like a
  // healthy idle queue, on the panel built to make that visible.
  test('shows the expired count, not only the failed one', async ({ page }) => {
    await stubStatus(page, {
      last_poll_at: new Date(Date.now() - 5 * 60000).toISOString(),
      counts: { pending: 0, taken: 0, sent: 0, failed: 0, expired: 7 },
    });
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.getByTestId('sms-queue')).toContainText('7 פגו');
  });

  // Hebrew counts one and two with their own words. "לפני 1 דקות" is reachable a
  // minute after every poll, and the phone polls every 2–5 minutes.
  test('says one and two in Hebrew, not as numbers', async ({ page }) => {
    await stubStatus(page, { last_poll_at: new Date(Date.now() - 61000).toISOString() });
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.getByTestId('sms-status')).toContainText('לפני דקה');
    await expect(page.getByTestId('sms-status')).not.toContainText('לפני 1');

    await stubStatus(page, { last_poll_at: new Date(Date.now() - 2 * 60000).toISOString() });
    await page.reload();
    await expect(page.getByTestId('sms-status')).toContainText('לפני שתי דקות');
  });

  // A quarter of an hour of silence is a phone that is off or has lost the flow
  // — which, from the outside, looks exactly like SMS working.
  test('warns when the phone has gone quiet', async ({ page }) => {
    await stubStatus(page, { last_poll_at: new Date(Date.now() - 3 * 3600000).toISOString() });
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.getByTestId('sms-status')).toContainText('לא בדק מזמן');
  });
});
