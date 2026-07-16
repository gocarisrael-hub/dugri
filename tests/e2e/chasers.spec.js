import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// Full flow for the optional "צ'ייסרים" drinking-game add-on:
// toggle it in step 3 of the order wizard -> finish the wizard (name + contact)
// -> the owner sees the 🥃 badge in the admin orders table.
// A 1x1 transparent PNG used as the fake rendered preview image.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test('chasers add-on flows from the wizard into the order and admin', async ({ page }) => {
  // The create button is gated on the name step until the preview shows — stub
  // /api/preview so the gate opens without the Python render.
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
  await page.goto('/options.html?plan=base');

  // Step 1 -> 2 (colour + add-ons), then turn the add-on on (carries ?chasers=1).
  await page.getByTestId('next-btn').click();
  // The chasers add-on icon is the owner-provided photo, not the old svg.
  const chasersIco = page.locator('#chasersCard img.addon-ico');
  await expect(chasersIco).toHaveAttribute('src', 'assets/ico-chasers.png');
  await expect(page.locator('#chasersCard svg.addon-ico')).toHaveCount(0);
  await page.getByTestId('chasers-toggle').check();
  await expect(page.getByTestId('chasers-toggle')).toBeChecked();
  expect(page.url()).toContain('chasers=1');

  // the toggle's "on" state paints the warm-sand accent (--accent #b7a389),
  // not the old near-black ink (poll past the 0.2s background transition).
  await expect
    .poll(() =>
      page
        .locator('#chasersCard .switch input:checked + .track')
        .evaluate((el) => getComputedStyle(el).backgroundColor)
    )
    .toBe('rgb(183, 163, 137)');

  // Step 2 -> 3 (name) -> 4 (contact) -> create the shared collection. The
  // honoree is a SINGLE English word (default design bachelorette is english),
  // made unique with a letters-only suffix (digits are rejected in a name) so the
  // admin row can be found by it.
  const honoree = 'Chaser' + String(Date.now()).replace(/[0-9]/g, (d) => 'abcdefghij'[+d]);
  await page.getByTestId('next-btn').click();
  await page.fill('#honoreeInput', honoree);
  await page.getByTestId('gender-female').check(); // gender is required to advance
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-pawns')).toBeVisible(); // optional pawn step
  await page.getByTestId('next-btn').click();
  await page.fill('#ownerEmail', 'chasers-test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.getByTestId('next-btn').click();
  await page.waitForURL(/collect\.html/);

  // The owner's admin view shows a ✓ in the chasers column for this order.
  await page.goto('/admin.html?key=dugri-admin');
  const row = page.locator('tr', { hasText: honoree }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('✓');
});
