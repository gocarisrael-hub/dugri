import { test, expect } from '@playwright/test';

// The owner texts editor (WhatsApp trigger catalog + email templates) is behind
// the admin key. The e2e server runs with ADMIN_KEY=dugri-admin and
// DATA_DIR=.e2e-data (throwaway), so overrides written here never touch real data.
const KEY = 'dugri-admin';

// Read the effective value of one settings key straight from the admin API.
async function effective(request, section, k) {
  const r = await request.get(`/api/admin/settings?key=${KEY}`);
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  return body.effective[section][k];
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
    // token hint is shown
    await expect(page.locator('#card-email-order-paid .hint')).toContainText('{honoree}');
  });

  test('saving a trigger POSTs the override and the effective value updates', async ({
    page,
    request,
  }) => {
    await page.goto(`/admin-texts.html?key=${KEY}`);
    await expect(page.locator('#app')).toBeVisible();

    const unique = 'בדיקה ' + Date.now();
    const card = page.locator('#card-wa-trigger-list-closed');
    await card.locator('textarea[data-field="text"]').fill(unique);
    await card.locator('button[data-save]').click();
    await expect(card.locator('.status')).toHaveText(/נשמר/);

    // the server now returns the new effective text
    const eff = await effective(request, 'wa', 'trigger.list_closed');
    expect(eff.text).toBe(unique);
    expect(eff.enabled).toBe(true); // shape preserved

    await resetKey(request, 'wa', 'trigger.list_closed');
  });

  test('reset issues a DELETE and restores the default value', async ({ page, request }) => {
    // seed an override via the API, then reset it through the UI button
    const seed = await request.post(`/api/admin/settings?key=${KEY}`, {
      data: { section: 'email', key: 'order_paid', value: { subject: 'X', body: 'Y' } },
    });
    expect(seed.ok()).toBeTruthy();

    page.on('dialog', (d) => d.accept()); // reset asks for confirmation
    await page.goto(`/admin-texts.html?key=${KEY}`);
    const card = page.locator('#card-email-order-paid');
    await expect(card.locator('[data-field="subject"]')).toHaveValue('X');

    await card.locator('button[data-reset]').click();
    await expect(card.locator('.status')).toHaveText(/אופס/);

    // back to the registry default (which interpolates {honoree})
    const r = await request.get(`/api/admin/settings?key=${KEY}`);
    const body = await r.json();
    expect(body.effective.email.order_paid).toEqual(body.defaults.email.order_paid);
    expect(body.effective.email.order_paid.subject).toContain('{honoree}');
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
