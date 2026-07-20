import { test, expect } from '@playwright/test';

// The owner texts editor (WhatsApp trigger catalog + email templates) is behind
// the admin key. The e2e server runs with ADMIN_KEY=dugri-admin and
// DATA_DIR=.e2e-data (throwaway), so overrides written here never touch real data.
const KEY = 'dugri-admin';

// The two device projects run the SAME spec in parallel against ONE server
// (shared DATA_DIR), so a re-fetch of `effective` for a fixed settings key can
// observe another worker's concurrent write. To keep round-trip assertions
// race-free we click Save/Reset and read the page's OWN response: the Node
// server is single-threaded, so each POST/DELETE returns the effective value as
// of that request's own write, with no interleaving. Cross-worker overwrites of
// the shared key are then irrelevant to the assertion.
function matchSettings(method) {
  return (r) => r.url().includes('/api/admin/settings') && r.request().method() === method;
}
async function clickAndRead(page, locator, method) {
  const [resp] = await Promise.all([page.waitForResponse(matchSettings(method)), locator.click()]);
  expect(resp.ok()).toBeTruthy();
  return (await resp.json()).effective;
}
// Restore a key to its default so tests don't leak overrides into a reused dev
// server (settingKey — the `key` query param is reserved for the admin secret).
async function resetKey(request, section, k) {
  const r = await request.delete(
    `/api/admin/settings?section=${section}&settingKey=${encodeURIComponent(k)}&key=${KEY}`
  );
  expect(r.ok()).toBeTruthy();
}

test.describe('admin texts editor', () => {
  test('without a key the page reveals nothing and asks for ?key=', async ({ page }) => {
    // Fail loudly if the page tries to load admin data with no key.
    let hitAdmin = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/settings')) hitAdmin = true;
    });
    await page.goto('/admin-texts.html');
    await expect(page.locator('#noKey')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    expect(hitAdmin).toBe(false);
  });

  test('with the key it renders both groups, the triggers and the email sections', async ({
    page,
  }) => {
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    // both group headings
    await expect(page.locator('.section-title', { hasText: 'וואטסאפ' })).toBeVisible();
    await expect(page.locator('.section-title', { hasText: 'מיילים' })).toBeVisible();

    // WhatsApp arming banner — the e2e server runs with no WHAPI env, so the bot
    // is dormant and the banner reads "רדום".
    const waStatus = page.locator('#waStatus');
    await expect(waStatus).toBeVisible();
    await expect(waStatus).toHaveClass(/wa-status/);
    await expect(waStatus).toContainText('רדום');

    // WhatsApp: an event trigger (no timing) and both time-trigger shapes render
    await expect(page.locator('#card-wa-trigger-list-closed')).toBeVisible();
    // daily_* -> a single `hour` input
    await expect(
      page.locator('#card-wa-trigger-daily-morning .timing[data-timing="hour"] [data-t="hour"]')
    ).toBeVisible();
    // quiet_reminder -> idle_hours + max + window[start,end]
    const quiet = page.locator('#card-wa-trigger-quiet-reminder .timing[data-timing="quiet"]');
    await expect(quiet.locator('[data-t="idle_hours"]')).toBeVisible();
    await expect(quiet.locator('[data-t="max"]')).toBeVisible();
    await expect(quiet.locator('[data-t="win_start"]')).toBeVisible();
    await expect(quiet.locator('[data-t="win_end"]')).toBeVisible();
    // an event trigger carries no timing block
    await expect(page.locator('#card-wa-trigger-list-closed .timing')).toHaveCount(0);

    // Emails: a template (subject + body) and a label map render
    await expect(page.locator('#card-email-order-paid [data-field="subject"]')).toBeVisible();
    await expect(page.locator('#card-email-order-paid [data-field="body"]')).toBeVisible();
    await expect(page.locator('#card-email-version-labels [data-mapkey="pdf"]')).toBeVisible();
    // token hint is shown, including the new insertable tokens on the owner email
    await expect(page.locator('#card-email-order-paid .hint')).toContainText('{honoree}');
    await expect(page.locator('#card-email-order-paid .hint')).toContainText('{orderId}');
    await expect(page.locator('#card-email-order-paid .hint')).toContainText('{adminLink}');

    // The new owner-editable content maps render as label rows.
    await expect(page.locator('#card-email-product-info [data-mapkey="delivery"]')).toBeVisible();
    await expect(page.locator('#card-email-delivery-info [data-mapkey="eta"]')).toBeVisible();
    await expect(page.locator('#card-email-pickup-info [data-mapkey="address"]')).toBeVisible();
  });

  test('saving an event trigger POSTs the override and returns the new effective value', async ({
    page,
    request,
  }) => {
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    const unique = 'בדיקה ' + Date.now();
    const card = page.locator('#card-wa-trigger-list-closed');
    await card.locator('textarea[data-field="text"]').fill(unique);
    const eff = await clickAndRead(page, card.locator('button[data-save]'), 'POST');
    await expect(card.locator('.status')).toHaveText(/נשמר/);

    // event trigger: no timing key, shape preserved
    expect(eff).toEqual({ enabled: true, text: unique });

    await resetKey(request, 'wa', 'trigger.list_closed');
  });

  test('saving a daily_* trigger round-trips the hour timing', async ({ page, request }) => {
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const card = page.locator('#card-wa-trigger-daily-morning');
    await expect(card).toBeVisible();

    const unique = 'בוקר ' + Date.now();
    await card.locator('textarea[data-field="text"]').fill(unique);
    await card.locator('.timing[data-timing="hour"] [data-t="hour"]').fill('6');
    const eff = await clickAndRead(page, card.locator('button[data-save]'), 'POST');
    await expect(card.locator('.status')).toHaveText(/נשמר/);

    expect(eff).toEqual({ enabled: true, text: unique, timing: { hour: 6 } });

    await resetKey(request, 'wa', 'trigger.daily_morning');
  });

  test('saving quiet_reminder round-trips idle_hours/max/window in order', async ({
    page,
    request,
  }) => {
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const card = page.locator('#card-wa-trigger-quiet-reminder');
    await expect(card).toBeVisible();

    const unique = 'שקט ' + Date.now();
    await card.locator('textarea[data-field="text"]').fill(unique);
    const timing = card.locator('.timing[data-timing="quiet"]');
    await timing.locator('[data-t="idle_hours"]').fill('30');
    await timing.locator('[data-t="max"]').fill('5');
    await timing.locator('[data-t="win_start"]').fill('8');
    await timing.locator('[data-t="win_end"]').fill('22');
    const eff = await clickAndRead(page, card.locator('button[data-save]'), 'POST');
    await expect(card.locator('.status')).toHaveText(/נשמר/);

    // window stays a 2-element array in [start, end] order, values intact
    expect(eff).toEqual({
      enabled: true,
      text: unique,
      timing: { idle_hours: 30, max: 5, window: [8, 22] },
    });
    expect(Array.isArray(eff.timing.window)).toBe(true);

    await resetKey(request, 'wa', 'trigger.quiet_reminder');
  });

  test('saving a footer label map keeps the full object with sibling keys intact', async ({
    page,
    request,
  }) => {
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const card = page.locator('#card-email-footer');
    await expect(card).toBeVisible();

    // read the sibling (line2) straight off the page so the assertion is
    // self-contained (no shared re-fetch)
    const line2 = await card.locator('[data-mapkey="line2"]').inputValue();
    const unique = 'חתימה ' + Date.now();
    await card.locator('[data-mapkey="line1"]').fill(unique);
    const eff = await clickAndRead(page, card.locator('button[data-save]'), 'POST');
    await expect(card.locator('.status')).toHaveText(/נשמר/);

    // full plain object: the edited key applied, the sibling NOT dropped/flattened
    expect(eff).toEqual({ line1: unique, line2 });

    await resetKey(request, 'email', 'footer');
  });

  test('reset issues a DELETE and restores the default value', async ({ page, request }) => {
    page.on('dialog', (d) => d.accept()); // reset asks for confirmation
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const card = page.locator('#card-email-order-paid');
    await expect(card).toBeVisible();

    // first override it through the UI, then reset it back
    await card.locator('[data-field="subject"]').fill('X');
    await card.locator('[data-field="body"]').fill('Y');
    const saved = await clickAndRead(page, card.locator('button[data-save]'), 'POST');
    expect(saved).toEqual({ subject: 'X', body: 'Y' });

    const eff = await clickAndRead(page, card.locator('button[data-reset]'), 'DELETE');
    await expect(card.locator('.status')).toHaveText(/אופס/);
    // back to the registry default (which still interpolates {honoree})
    expect(eff.subject).not.toBe('X');
    expect(eff.subject).toContain('{honoree}');

    await resetKey(request, 'email', 'order_paid');
  });

  test('client refuses to save a trigger with an out-of-range or empty hour', async ({ page }) => {
    let posted = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/settings') && req.method() === 'POST') posted = true;
    });
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const card = page.locator('#card-wa-trigger-daily-morning');
    const hour = card.locator('.timing[data-timing="hour"] [data-t="hour"]');

    // out of range -> refused inline, no POST
    await hour.fill('25');
    await card.locator('button[data-save]').click();
    await expect(card.locator('.status')).toHaveText(/0.*23/);
    // cleared field must NOT be coerced to 0 and saved
    await hour.fill('');
    await card.locator('button[data-save]').click();
    await expect(card.locator('.status')).toHaveText(/0.*23/);

    expect(posted).toBe(false);
  });

  test('client refuses quiet_reminder with an out-of-order window', async ({ page }) => {
    let posted = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/settings') && req.method() === 'POST') posted = true;
    });
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const card = page.locator('#card-wa-trigger-quiet-reminder');
    const timing = card.locator('.timing[data-timing="quiet"]');
    await timing.locator('[data-t="win_start"]').fill('21');
    await timing.locator('[data-t="win_end"]').fill('9');
    await card.locator('button[data-save]').click();
    await expect(card.locator('.status')).toHaveText(/לפני/);
    expect(posted).toBe(false);
  });

  test('a server-rejected save surfaces the server error message', async ({ page }) => {
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();
    // Make the API reject the POST with a specific reason; the inline status must
    // show that reason (not a bare "HTTP 400").
    await page.route('**/api/admin/settings**', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'timing.hour must be an integer 0..23' }),
        });
      }
      return route.continue();
    });
    const card = page.locator('#card-wa-trigger-daily-morning');
    // a client-valid value so the request actually reaches the (mocked) server
    await card.locator('.timing[data-timing="hour"] [data-t="hour"]').fill('7');
    await card.locator('button[data-save]').click();
    await expect(card.locator('.status')).toContainText('timing.hour must be an integer 0..23');
  });

  test('opens from the orders-management page nav, carrying the key', async ({ page }) => {
    await page.goto(`/admin.html?key=${KEY}`);
    const link = page.locator('#nav a[data-page="admin-texts.html"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /admin-texts\.html\?key=/);
    await link.click();
    await expect(page).toHaveURL(/admin-texts\.html\?key=/);
    await expect(page.locator('#app')).toBeVisible();
  });
});
