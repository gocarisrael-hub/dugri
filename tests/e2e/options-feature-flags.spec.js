import { test, expect } from '@playwright/test';
import { ALL_ON, ALL_OFF, stubFeatures } from './feature-flags.js';

// The buyer wizard reads GET /api/features at load and HIDES four gated features
// when their flag is off: colour picking, the chasers add-on, the word-font
// picker and the live name preview. With colour + chasers both off, step 2
// becomes empty and is skipped entirely (steps 1/3/4 always have controls, so
// only step 2 can drop out). This spec drives each state directly by stubbing
// the endpoint per-page (no server seeding — see feature-flags.js).

// A 1x1 transparent PNG for the (stubbed) name-preview render in the all-ON case.
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

// Intercept the create call so no real collection is written; return the captured
// request body so the order-default assertions can read it.
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

// Shared assertions for the "all four hidden + step 2 skipped" state, reached
// either by an explicit all-OFF stub or by a failed /api/features fetch.
async function expectAllHiddenAndStep2Skipped(page) {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();

  // progress reads "מתוך 3" — only three active steps.
  await expect(page.getByTestId('step-total')).toHaveText('3');
  await expect(page.getByTestId('step-now')).toHaveText('1');

  // the four gated regions are hidden.
  await expect(page.getByTestId('color-carousel')).toBeHidden();
  await expect(page.getByTestId('color-list')).toBeHidden();
  await expect(page.getByTestId('chasers-card')).toBeHidden();
  await expect(page.getByTestId('name-preview')).toBeHidden();

  // Next on step 1 skips the empty step 2 and lands on step 3 (name).
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-3')).toBeVisible();
  await expect(page.getByTestId('step-2')).toBeHidden();
  await expect(page.getByTestId('step-now')).toHaveText('2'); // 3 is the 2nd active step

  // On the name step the preview + font picker stay hidden.
  await expect(page.getByTestId('name-preview')).toBeHidden();
  await expect(page.getByTestId('font-opts')).toBeHidden();

  // Back from step 3 skips step 2 again and returns to step 1.
  await page.getByTestId('back-btn').click();
  await expect(page.getByTestId('step-1')).toBeVisible();
  await expect(page.getByTestId('step-now')).toHaveText('1');
}

test.describe('buyer wizard feature flags', () => {
  test('all OFF: four regions hidden, step 2 skipped, order uses the built-in defaults', async ({
    page,
  }) => {
    await stubFeatures(page, ALL_OFF);
    const captured = await captureCollectionPost(page);

    await expectAllHiddenAndStep2Skipped(page);

    // Complete the order end-to-end: name (bachelorette = English) + gender, then
    // contact. No preview is required (the gate is dropped when name-preview is
    // off), so Next enables on a valid name.
    await page.getByTestId('next-btn').click(); // step 1 -> step 3
    await expect(page.getByTestId('step-3')).toBeVisible();
    await page.fill('#honoreeInput', 'Shira');
    await page.getByTestId('gender-female').check();
    await page.getByTestId('next-btn').click(); // step 3 -> step 4
    await expect(page.getByTestId('step-4')).toBeVisible();

    await page.fill('#ownerEmail', 'owner@example.com');
    await page.fill('#ownerPhone', '0521234567');
    const create = page.getByTestId('next-btn');
    await expect(create).toBeEnabled();
    await create.click();
    await page.waitForURL(/collect\.html\?c=test-col&k=test-tok/);

    // The order carries the built-in defaults for every hidden feature.
    expect(captured.body.color).toBe('מקורי');
    expect(captured.body.chasers).toBe(false);
    expect(captured.body.word_font).toBeNull();
  });

  test('a failed /api/features fetch falls back to all-hidden (same as all OFF)', async ({
    page,
  }) => {
    // Abort the flags request entirely — the wizard must default to all-hidden so
    // a network blip never reveals a rough feature.
    await page.route('**/api/features', (route) => route.abort());
    await expectAllHiddenAndStep2Skipped(page);
  });

  test('all ON: the four regions are visible and step 2 is present', async ({ page }) => {
    await stubFeatures(page, ALL_ON);
    await mockPreview(page);
    await page.goto('/options.html?plan=base');

    // progress reads "מתוך 4" — step 2 is back in the flow.
    await expect(page.getByTestId('step-total')).toHaveText('4');

    // Step 2 shows the colour picker + carousel + chasers add-on.
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('2');
    await expect(page.getByTestId('color-carousel')).toBeVisible();
    await expect(page.getByTestId('color-list')).toBeVisible();
    await expect(page.getByTestId('chasers-card')).toBeVisible();

    // Step 3 shows the live name preview + the word-font picker.
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-3')).toBeVisible();
    await page.fill('#honoreeInput', 'Shira');
    await expect(page.getByTestId('name-preview')).toBeVisible();
    await expect(page.locator('.wiz-fontpicker')).toBeVisible();
  });
});
