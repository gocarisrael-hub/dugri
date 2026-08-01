import { test, expect } from '@playwright/test';
import { ALL_ON, ALL_OFF, stubFeatures } from './feature-flags.js';

// The name step (3) asks for the honoree's details — name, gender, optional
// custom title — and only THEN renders the live preview. Before the details are
// filled in, the space where the preview will appear carries a teaser box that
// says it's coming, so the buyer knows the step pays off.
//
// The contract this spec pins: the teaser and the live preview are MUTUALLY
// EXCLUSIVE. Exactly one of them is on screen at any moment on step 3 — and
// neither, when the name_preview feature is gated off.

// A 1x1 transparent PNG so the stubbed render never touches the generator.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

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

// design-0 = bachelorette -> theme "bachelorette" (no extra fields needed).
async function toNameStep(page) {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId('design-0').click();
  await page.getByTestId('next-btn').click(); // -> step 2 (colour + add-ons)
  await page.getByTestId('next-btn').click(); // -> step 3 (name)
  await expect(page.getByTestId('step-3')).toBeVisible();
}

test.describe('name-step preview teaser', () => {
  test.beforeEach(async ({ page }) => {
    await stubFeatures(page, ALL_ON);
    await mockPreview(page);
  });

  test('before a name is entered the teaser stands in for the preview', async ({ page }) => {
    await toNameStep(page);

    const teaser = page.getByTestId('preview-teaser');
    await expect(teaser).toBeVisible();
    // It promises the preview rather than warning about anything.
    await expect(teaser).toContainText('תצוגה חיה');
    // ...and the real preview is not up yet, so the two never overlap.
    await expect(page.getByTestId('name-preview')).toBeHidden();
  });

  test('a valid name swaps the teaser out for the live preview', async ({ page }) => {
    await toNameStep(page);
    await expect(page.getByTestId('preview-teaser')).toBeVisible();

    await page.getByTestId('honoree-input').fill('Shira');

    await expect(page.getByTestId('name-preview')).toBeVisible();
    await expect(page.getByTestId('preview-teaser')).toBeHidden();
  });

  test('clearing the name brings the teaser back', async ({ page }) => {
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview')).toBeVisible();

    await page.getByTestId('honoree-input').fill('');

    await expect(page.getByTestId('preview-teaser')).toBeVisible();
    await expect(page.getByTestId('name-preview')).toBeHidden();
  });

  test('the teaser only lives on the name step', async ({ page }) => {
    await page.goto('/options.html?plan=base');
    await expect(page.getByTestId('step-1')).toBeVisible();
    // It sits inside step 3's section, so it is not on screen on step 1.
    await expect(page.getByTestId('preview-teaser')).toBeHidden();
  });
});

test('name_preview gated OFF: no preview and no promise of one', async ({ page }) => {
  await stubFeatures(page, ALL_OFF);
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  // colour + chasers are off too, so Next from step 1 skips the empty step 2.
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-3')).toBeVisible();

  await expect(page.getByTestId('name-preview')).toBeHidden();
  await expect(page.getByTestId('preview-teaser')).toBeHidden();

  // Still nothing to promise once a valid name is typed.
  await page.getByTestId('honoree-input').fill('Shira');
  await expect(page.getByTestId('preview-teaser')).toBeHidden();
});
