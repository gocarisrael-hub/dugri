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
          back: PNG,
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
  await page.getByTestId('next-btn').click(); // -> step 2 (colour + add-ons)
  await page.getByTestId('next-btn').click(); // -> step 3 (name)
  await expect(page.getByTestId('step-3')).toBeVisible();
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
    // the design's real card back renders too, alongside the card + board
    await expect(page.getByTestId('name-preview-back')).toHaveAttribute('src', /^data:image\/png/);
    await expect(page.getByTestId('name-preview-back')).toBeVisible();
    await expect(page.getByTestId('name-preview-board')).toHaveAttribute('src', /^data:image\/png/);

    // the name was sent to the preview endpoint
    await expect.poll(() => reqs.length).toBeGreaterThanOrEqual(1);
    expect(reqs[reqs.length - 1].name).toBe('Shira');
    expect(reqs[reqs.length - 1].theme).toBe('bachelorette');

    // the picker rendered the five shared options plus the "מקורי" (original) chip
    await expect(
      page.getByTestId('font-opts').locator('.font-opt:not(.font-opt-orig)')
    ).toHaveCount(5);
    await expect(page.getByTestId('font-opt-original')).toBeVisible();
  });

  test('switching the word font re-requests the preview with that font', async ({ page }) => {
    const reqs = await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(
      page.getByTestId('font-opts').locator('.font-opt:not(.font-opt-orig)')
    ).toHaveCount(5);

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

  test('the ORIGINAL font is preselected on load and marked so clients can tell', async ({
    page,
  }) => {
    await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(
      page.getByTestId('font-opts').locator('.font-opt:not(.font-opt-orig)')
    ).toHaveCount(5);

    // exactly one chip is marked selected on load, and it's the "מקורי" (original) chip.
    const pressed = page.getByTestId('font-opts').locator('.font-opt[aria-pressed="true"]');
    await expect(pressed).toHaveCount(1);
    await expect(page.getByTestId('font-opt-original')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the font picker sits ABOVE the rendered card/board images', async ({ page }) => {
    await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview-card')).toBeVisible();

    const fontsBottom = await page
      .getByTestId('font-opts')
      .evaluate((el) => el.getBoundingClientRect().bottom);
    const imgsTop = await page
      .locator('#namePreviewImgs')
      .evaluate((el) => el.getBoundingClientRect().top);
    // the picker's bottom is at or above the images' top → it's above them
    expect(fontsBottom).toBeLessThanOrEqual(imgsTop + 1);
  });

  test('the name preview no longer offers a fullscreen enlarge affordance', async ({ page }) => {
    await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview-card')).toBeVisible();

    // the name-preview zoom was removed: no enlarge button, and tapping the
    // inline preview does NOT open the shared fullscreen overlay.
    await expect(page.getByTestId('name-zoom-open')).toHaveCount(0);
    await page.getByTestId('name-preview-viewport').click({ position: { x: 20, y: 20 } });
    await expect(page.getByTestId('zoom-overlay')).toBeHidden();
  });
});

test.describe('name-step preview resilience', () => {
  // When /api/preview keeps failing the UI must never look broken: it shows the
  // friendly fallback (name in a script font) with a retry — after one automatic
  // retry — instead of a stuck "טוען תצוגה…".
  test('a failing preview falls back gracefully with a retry', async ({ page }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
    );
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    // the fallback card shows the name — never a blank / stuck loader
    await expect(page.getByTestId('name-preview-fallback')).toBeVisible();
    await expect(page.locator('#npfName')).toHaveText('Shira');
    await expect(page.getByTestId('name-preview-loading')).toBeHidden();

    // after the single automatic retry also fails, a manual retry is offered
    await expect(page.getByTestId('name-preview-retry')).toBeVisible({ timeout: 5000 });
  });

  test('an automatic retry self-heals a transient hiccup', async ({ page }) => {
    const PNG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    let calls = 0;
    await page.route('**/api/preview', (route) => {
      calls += 1;
      if (calls === 1) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          card: PNG,
          board: PNG,
          warning: null,
          word_font: null,
          word_font_options: [{ label: 'Cafe', file: 'Cafe Regular.ttf' }],
        }),
      });
    });
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    // the first attempt fails, the auto-retry succeeds → the real image lands
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/, {
      timeout: 5000,
    });
    await expect(page.getByTestId('name-preview-fallback')).toBeHidden();
  });
});

test.describe('name preview shows more of the card artwork', () => {
  // The rendered card/back are cropped single cards delivered at up to 700px wide,
  // so the inline preview was needlessly small (300px). It now renders larger so
  // more of each card's themed background/artwork reads. Guard the framing: the
  // card + back images are shown noticeably bigger, at their TRUE ratio (no
  // stretch — object-fit stays contain).
  test('the card + back preview images are enlarged (bigger max-width, undistorted)', async ({
    page,
  }) => {
    await mockPreview(page);
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    const card = page.getByTestId('name-preview-card');
    const back = page.getByTestId('name-preview-back');
    await expect(card).toBeVisible();

    // the enlarged framing: card/back capped at 400px (was 300), viewport at 420.
    const cardMaxW = await card.evaluate((el) => parseFloat(getComputedStyle(el).maxWidth));
    const backMaxW = await back.evaluate((el) => parseFloat(getComputedStyle(el).maxWidth));
    expect(cardMaxW).toBeGreaterThanOrEqual(400);
    expect(backMaxW).toBeGreaterThanOrEqual(400);
    const vpMaxW = await page
      .getByTestId('name-preview-viewport')
      .evaluate((el) => parseFloat(getComputedStyle(el).maxWidth));
    expect(vpMaxW).toBeGreaterThanOrEqual(420);

    // still undistorted: object-fit contain, never stretched to fill a box.
    expect(await card.evaluate((el) => getComputedStyle(el).objectFit)).toBe('contain');
  });
});
