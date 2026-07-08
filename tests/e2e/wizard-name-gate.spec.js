import { test, expect } from '@playwright/test';

// Two order-wizard rules on the name step (step 4):
//  1. The create/next button is GATED on the live name-preview: it stays disabled
//     until the preview has rendered on screen (or a 20s backstop elapses), so the
//     game is never created before the customer has seen a preview.
//  2. The honoree name must be a SINGLE word in the design's LANGUAGE — an English
//     design rejects a Hebrew name and a name with a space, a Hebrew design rejects
//     a Latin name — each with a clear inline error that blocks advancing.

// A 1x1 transparent PNG used as the fake rendered preview image.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const previewBody = JSON.stringify({
  card: PNG,
  back: PNG,
  board: PNG,
  warning: null,
  word_font: null,
  word_font_options: [],
});

test.describe('create-button preview gate (step 4)', () => {
  test('the button stays disabled until the name-preview renders, then unlocks', async ({
    page,
  }) => {
    // Hold the preview response until we release it, so we can observe the button
    // gated while the preview is pending and unlocking once it renders.
    let releasePreview;
    const pending = new Promise((r) => (releasePreview = r));
    await page.route('**/api/preview', async (route) => {
      await pending;
      await route.fulfill({ status: 200, contentType: 'application/json', body: previewBody });
    });

    await page.goto('/options.html?step=4'); // default design = bachelorette (english)
    await expect(page.getByTestId('step-4')).toBeVisible();

    const next = page.getByTestId('next-btn');
    // A single valid English name → fields are valid, but the preview hasn't shown
    // yet, so the button is held disabled purely by the gate.
    await page.fill('#honoreeInput', 'Shira');
    await expect(page.getByTestId('name-err')).toBeHidden();
    await expect(next).toBeDisabled();
    // give the debounced request time to fire and sit pending — still gated.
    await page.waitForTimeout(700);
    await expect(next).toBeDisabled();

    // Release the preview → the card renders and the gate opens.
    releasePreview();
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(next).toBeEnabled();
  });

  test('a FAILED preview still unlocks the button (never permanently stuck)', async ({ page }) => {
    // The Python render is unavailable → /api/preview always 500s. The UI settles
    // on its graceful fallback, and the gate opens so a valid client isn't stuck.
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
    );
    await page.goto('/options.html?step=4');
    await expect(page.getByTestId('step-4')).toBeVisible();

    await page.fill('#honoreeInput', 'Shira');
    // the graceful fallback shows the name, and the button becomes enabled.
    await expect(page.getByTestId('name-preview-fallback')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('next-btn')).toBeEnabled({ timeout: 5000 });
  });
});

test.describe('name language + single-word rules block Next', () => {
  test('an ENGLISH design rejects a Hebrew name and a spaced name, accepts a single English word', async ({
    page,
  }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    await page.goto('/options.html?step=4'); // bachelorette = english
    await expect(page.getByTestId('step-4')).toBeVisible();
    const next = page.getByTestId('next-btn');
    const err = page.getByTestId('name-err');

    // Hebrew name on an English design → language error + blocked.
    await page.fill('#honoreeInput', 'שירה');
    await expect(err).toBeVisible();
    await expect(err).toContainText('אנגלית');
    await expect(next).toBeDisabled();

    // A space (two words) → single-word format error + blocked.
    await page.fill('#honoreeInput', 'Anne Marie');
    await expect(err).toBeVisible();
    await expect(next).toBeDisabled();

    // A single English word → accepted (error clears; the gate opens via preview).
    await page.fill('#honoreeInput', 'Shira');
    await expect(err).toBeHidden();
    await expect(next).toBeEnabled();
  });

  test('a HEBREW design rejects a Latin name with a Hebrew-language hint', async ({ page }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    // kids = birthday-boys-basketball (hebrew). Deep-link straight to the name step.
    await page.goto('/options.html?design=kids&step=4');
    await expect(page.getByTestId('step-4')).toBeVisible();
    const err = page.getByTestId('name-err');

    // An English name on a Hebrew design → language error + blocked.
    await page.fill('#honoreeInput', 'Shira');
    await expect(err).toBeVisible();
    await expect(err).toContainText('עברית');
    await expect(page.getByTestId('next-btn')).toBeDisabled();

    // A Hebrew name clears the name error (age is still required to advance).
    await page.fill('#honoreeInput', 'שירה');
    await expect(err).toBeHidden();
  });
});
