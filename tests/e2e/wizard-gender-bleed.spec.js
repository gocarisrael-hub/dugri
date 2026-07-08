import { test, expect } from '@playwright/test';

// Covers two order-wizard additions:
//  1. a REQUIRED gender choice on the honoree-name step, sent as `gender` in the
//     POST /api/collections payload (exactly 'female' | 'male' — no default:
//     nothing is pre-selected and a choice is required to advance);
//  2. the card preview showing a real printed-background "bleed" around the card.

// A 1x1 transparent PNG used as the fake rendered preview image.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// The create button is gated on the name step until the preview shows, so stub
// /api/preview to open the gate deterministically without the Python render.
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

async function toNameStep(page) {
  await mockPreview(page);
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  // steps 1-3 have safe defaults -> Next straight through to the name step.
  await page.getByTestId('next-btn').click(); // -> step 2
  await page.getByTestId('next-btn').click(); // -> step 3
  await page.getByTestId('next-btn').click(); // -> step 4 (name)
  await expect(page.getByTestId('step-4')).toBeVisible();
}

// Intercept the create call so no real collection is written; return the
// captured request body.
function captureCollectionPost(page) {
  const captured = {};
  return page
    .route('**/api/collections', async (route) => {
      captured.body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'test-col', owner_token: 'test-tok' }),
      });
    })
    .then(() => captured);
}

test.describe('honoree gender', () => {
  test('gender control exists with nothing pre-selected', async ({ page }) => {
    await toNameStep(page);
    await expect(page.getByTestId('gender-group')).toBeVisible();
    // no default: neither option is checked until the user actively picks one
    await expect(page.getByTestId('gender-female')).not.toBeChecked();
    await expect(page.getByTestId('gender-male')).not.toBeChecked();
  });

  test('advancing without a gender is blocked and prompts a choice', async ({ page }) => {
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    // name is set but no gender picked -> Next must not advance...
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await expect(page.getByTestId('step-5')).not.toBeVisible();
    // ...and a prompt tells the user to choose.
    await expect(page.getByTestId('gender-modal')).toBeVisible();

    // dismissing then picking a gender lets the wizard advance.
    await page.getByTestId('gender-modal-ok').click();
    await expect(page.getByTestId('gender-modal')).toBeHidden();
    await page.getByTestId('gender-female').check();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-5')).toBeVisible();
  });

  test('the gender prompt does not linger after navigating away', async ({ page }) => {
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await page.getByTestId('next-btn').click(); // no gender -> prompt opens
    await expect(page.getByTestId('gender-modal')).toBeVisible();
    // navigating away (browser Back -> popstate) must dismiss the full-screen
    // overlay so it never lingers on top of an unrelated step.
    await page.goBack(); // -> step 3
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('gender-modal')).toBeHidden();
  });

  test('choosing female is sent in the create payload', async ({ page }) => {
    const captured = await captureCollectionPost(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await page.getByTestId('gender-female').check();
    await expect(page.getByTestId('gender-female')).toBeChecked();
    await page.getByTestId('next-btn').click(); // -> step 5 (contact)
    await page.getByTestId('owner-email').fill('a@b.com');
    await page.getByTestId('owner-phone').fill('0521234567');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => captured.body && captured.body.gender).toBe('female');
    expect(captured.body.honoree_name).toBe('Shira');
  });

  test('choosing male is sent in the create payload', async ({ page }) => {
    const captured = await captureCollectionPost(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Danny');
    await page.getByTestId('gender-male').check();
    await expect(page.getByTestId('gender-male')).toBeChecked();
    await page.getByTestId('next-btn').click(); // -> step 5
    await page.getByTestId('owner-email').fill('a@b.com');
    await page.getByTestId('owner-phone').fill('0521234567');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => captured.body && captured.body.gender).toBe('male');
  });
});

test.describe('full-page preview has no fake bleed frame', () => {
  test('the active preview renders edge-to-edge (no inset bleed padding)', async ({ page }) => {
    await page.goto('/options.html?plan=base');
    const front = page.getByTestId('preview-front');
    await expect(front.locator('svg')).toBeVisible();
    const pad = await front.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        padTop: parseFloat(cs.paddingTop) || 0,
        padLeft: parseFloat(cs.paddingLeft) || 0,
        padBottom: parseFloat(cs.paddingBottom) || 0,
      };
    });
    // The full-page design already prints its background to the edge, so the old
    // fake print-bleed frame is gone — the page shows edge-to-edge with no inset.
    expect(pad.padTop).toBeLessThanOrEqual(2);
    expect(pad.padLeft).toBeLessThanOrEqual(2);
    expect(pad.padBottom).toBeLessThanOrEqual(2);
  });
});
