import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// A 1x1 transparent PNG data URL for the mocked preview response.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function mockPreview(page) {
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
}

// The WhatsApp consent line must be present and visible at the phone-number
// (contact) step, so the buyer knows a group will be opened and their number
// added after payment.
test('the WhatsApp consent line is shown at the phone step', async ({ page }) => {
  await mockPreview(page);
  await page.goto('/options.html?step=3');
  await page.fill('#honoreeInput', 'Shira');
  await page.getByTestId('gender-female').check(); // gender is required to advance
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-4')).toBeVisible();

  const consent = page.getByTestId('wa-consent');
  await expect(consent).toBeVisible();
  await expect(consent).toContainText('וואטסאפ');
  // It sits by the phone field.
  await expect(page.getByTestId('owner-phone')).toBeVisible();
});
