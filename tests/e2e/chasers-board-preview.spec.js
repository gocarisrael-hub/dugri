import { test, expect } from '@playwright/test';

// The chasers (drinking-game) add-on drives which game BOARD the customer sees in
// the name-step live preview: with chasers ON the /api/preview request carries a
// `chasers` flag and the server renders the chasers board variant. The real render
// needs Chrome/Python, so we INTERCEPT /api/preview and return a DIFFERENT board
// image depending on the flag — proving the client threads the toggle through and
// applies the returned board. Additive + graceful: no dependency on the generator.

// Two distinct 1x1 PNG data URLs so #namePreviewBoard.src differs by variant.
const BOARD_PLAIN =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const BOARD_CHASERS =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CARD = BOARD_PLAIN;

// Intercept /api/preview: record each request body and return a board that ENCODES
// the chasers flag (chasers board vs plain board), like the real server would.
function mockPreview(page) {
  const reqs = [];
  return page
    .route('**/api/preview', async (route) => {
      const body = route.request().postDataJSON() || {};
      reqs.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          card: CARD,
          back: CARD,
          board: body.chasers ? BOARD_CHASERS : BOARD_PLAIN,
          warning: null,
          word_font: body.word_font || null,
          word_font_options: [],
        }),
      });
    })
    .then(() => reqs);
}

test.describe('chasers add-on drives the name-step board preview', () => {
  test('turning chasers on sends the flag and shows the chasers board', async ({ page }) => {
    const reqs = await mockPreview(page);
    await page.goto('/options.html?plan=base');
    await expect(page.getByTestId('step-1')).toBeVisible();
    await page.getByTestId('design-0').click(); // bachelorette (english, no extra fields)
    await page.getByTestId('next-btn').click(); // -> step 2 (colour + add-ons)

    // turn the chasers add-on ON (step 2), then advance to the name step
    await page.getByTestId('chasers-toggle').check();
    await expect(page.getByTestId('chasers-toggle')).toBeChecked();
    await page.getByTestId('next-btn').click(); // -> step 3 (name)
    await expect(page.getByTestId('step-3')).toBeVisible();

    await page.getByTestId('honoree-input').fill('Shira');

    // the board shown is the CHASERS variant (the mock returns it only when the
    // request carried chasers:true)
    await expect(page.getByTestId('name-preview-board')).toHaveAttribute('src', BOARD_CHASERS);
    // the preview request body carried the chasers flag
    await expect.poll(() => reqs.length).toBeGreaterThanOrEqual(1);
    expect(reqs[reqs.length - 1].chasers).toBe(true);
  });

  test('toggling chasers off re-requests the preview and swaps back to the plain board', async ({
    page,
  }) => {
    const reqs = await mockPreview(page);
    await page.goto('/options.html?plan=base');
    await page.getByTestId('design-0').click();
    await page.getByTestId('next-btn').click(); // -> step 2
    await page.getByTestId('chasers-toggle').check(); // chasers ON
    await page.getByTestId('next-btn').click(); // -> step 3
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview-board')).toHaveAttribute('src', BOARD_CHASERS);

    // go BACK to step 2, turn chasers OFF, return to the name step
    await page.getByTestId('back-btn').click(); // -> step 2
    await expect(page.getByTestId('step-2')).toBeVisible();
    await page.getByTestId('chasers-toggle').uncheck();
    await expect(page.getByTestId('chasers-toggle')).not.toBeChecked();
    await page.getByTestId('next-btn').click(); // -> step 3

    // a fresh preview is requested with chasers:false and the PLAIN board is shown
    await expect(page.getByTestId('name-preview-board')).toHaveAttribute('src', BOARD_PLAIN);
    expect(reqs[reqs.length - 1].chasers).toBe(false);
  });

  test('with chasers off the plain board is shown and the flag is false', async ({ page }) => {
    const reqs = await mockPreview(page);
    await page.goto('/options.html?plan=base');
    await page.getByTestId('design-0').click();
    await page.getByTestId('next-btn').click(); // -> step 2
    await page.getByTestId('next-btn').click(); // -> step 3 (chasers left OFF)
    await page.getByTestId('honoree-input').fill('Shira');

    await expect(page.getByTestId('name-preview-board')).toHaveAttribute('src', BOARD_PLAIN);
    await expect.poll(() => reqs.length).toBeGreaterThanOrEqual(1);
    expect(reqs[reqs.length - 1].chasers).toBe(false);
  });
});
