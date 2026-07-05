import { test, expect } from '@playwright/test';

// After entering the honoree name on the wizard's name step, the customer sees a
// REAL rendered preview (card + board) and can pick the Hebrew word font, which
// re-requests the preview. The actual render needs Chrome/Python, so here we
// INTERCEPT /api/preview and return a fake payload — this exercises the client
// wiring (fetch on name, image render, font picker, re-request on font switch)
// without depending on the generator being runnable in CI.

// A 1x1 transparent PNG data URL used as the fake rendered image.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const FONT_OPTIONS = [
  { label: 'Cafe', file: 'Cafe Regular.ttf' },
  { label: 'almoni-neue', file: 'almoni-neue-aaa-bold-OFFICE.ttf' },
  { label: 'nrkis', file: 'nrkis.ttf' },
  { label: 'Playpen Sans Hebrew', file: 'PlaypenSansHebrew-Medium.ttf' },
  { label: 'Fredoka', file: 'Fredoka-Medium.ttf' },
];

// Intercept /api/preview: record each request body, reply with the fake images +
// options (echoing the requested word_font, like the real route does).
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
          card: PNG,
          board: PNG,
          warning: null,
          word_font: body.word_font || null,
          word_font_options: FONT_OPTIONS,
        }),
      });
    })
    .then(() => reqs);
}

// design-0 = bachelorette -> theme "bachelorette" (no extra fields, english).
async function toNameStep(page) {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId('design-0').click();
  await page.getByTestId('next-btn').click(); // -> step 2
  await page.getByTestId('next-btn').click(); // -> step 3
  await page.getByTestId('next-btn').click(); // -> step 4 (name)
  await expect(page.getByTestId('step-4')).toBeVisible();
}

test.describe('name-step live preview + font picker', () => {
  test('entering a name shows a rendered preview image', async ({ page }) => {
    const reqs = await mockPreview(page);
    await toNameStep(page);

    // no preview before a name is entered
    await expect(page.getByTestId('name-preview')).toBeHidden();

    await page.getByTestId('honoree-input').fill('Shira');

    const card = page.getByTestId('name-preview-card');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('src', /^data:image\/png/);
    await expect(page.getByTestId('name-preview-board')).toHaveAttribute('src', /^data:image\/png/);

    // the name was sent to the preview endpoint
    await expect.poll(() => reqs.length).toBeGreaterThanOrEqual(1);
    expect(reqs[reqs.length - 1].name).toBe('Shira');
    expect(reqs[reqs.length - 1].theme).toBe('bachelorette');

    // the font picker rendered all five options
    await expect(page.getByTestId('font-opts').locator('.font-opt')).toHaveCount(5);
  });

  test('switching the word font re-requests the preview with that font', async ({ page }) => {
    const reqs = await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('font-opts').locator('.font-opt')).toHaveCount(5);

    const before = reqs.length;
    await page.getByTestId('font-opt-Fredoka-Medium.ttf').click();

    await expect.poll(() => reqs.length).toBeGreaterThan(before);
    expect(reqs[reqs.length - 1].word_font).toBe('Fredoka-Medium.ttf');
    // the chosen font is marked active
    await expect(page.getByTestId('font-opt-Fredoka-Medium.ttf')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});
