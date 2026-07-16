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

// The WhatsApp consent line was removed from the details step. It must no longer
// appear anywhere in the wizard (the phone field itself still shows).
test('the WhatsApp consent line is gone from the phone step', async ({ page }) => {
  await mockPreview(page);
  await page.goto('/options.html?step=3');
  await page.fill('#honoreeInput', 'Shira');
  await page.getByTestId('gender-female').check(); // gender is required to advance
  await page.getByTestId('next-btn').click();
  // name → optional pawn-photos step → details
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-4')).toBeVisible();

  await expect(page.getByTestId('wa-consent')).toHaveCount(0);
  // The phone field is still there.
  await expect(page.getByTestId('owner-phone')).toBeVisible();
});
