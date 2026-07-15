import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// F7 custom title: an OPTIONAL free-form title on the name step that OVERRIDES the
// design's own title on the cards + board. Editing it re-requests /api/preview so
// the buyer sees the EXACT title (WYSIWYG) before paying. The real render needs
// Chrome/Python, so we INTERCEPT /api/preview and echo back whether the request
// carried a `title` — proving the client threads the field through and that it is
// OPTIONAL (empty => no title in the body). Mirrors chasers-board-preview.spec.js.

const CARD =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// Intercept /api/preview: record each request body and return a minimal payload.
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
          board: CARD,
          warning: null,
          word_font: body.word_font || null,
          word_font_options: [],
        }),
      });
    })
    .then(() => reqs);
}

// Advance the bachelorette design (english, no extra fields) to the name step.
async function gotoNameStep(page) {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId('design-0').click();
  await page.getByTestId('next-btn').click(); // -> step 2
  await page.getByTestId('next-btn').click(); // -> step 3 (name)
  await expect(page.getByTestId('step-3')).toBeVisible();
}

test.describe('custom title (F7) on the name step', () => {
  test('the custom-title input is present and OPTIONAL (empty => no title sent)', async ({
    page,
  }) => {
    const reqs = await mockPreview(page);
    await gotoNameStep(page);

    const titleInput = page.getByTestId('custom-title-input');
    await expect(titleInput).toBeVisible();
    await expect(titleInput).toHaveValue(''); // optional: empty by default

    // Entering only a name (no title) still previews, and the body carries no
    // meaningful title — the design's own title is used.
    await page.getByTestId('honoree-input').fill('Shira');
    await expect.poll(() => reqs.length).toBeGreaterThanOrEqual(1);
    const last = reqs[reqs.length - 1];
    expect(last.title == null || last.title === '').toBe(true);
  });

  test('editing the title re-requests the preview with the typed title', async ({ page }) => {
    const reqs = await mockPreview(page);
    await gotoNameStep(page);

    await page.getByTestId('honoree-input').fill('Shira');
    await expect.poll(() => reqs.length).toBeGreaterThanOrEqual(1);

    const before = reqs.length;
    await page.getByTestId('custom-title-input').fill('ליאת חוגגת 40');

    // a fresh preview is requested, and its body carries the custom title
    await expect.poll(() => reqs.length).toBeGreaterThan(before);
    expect(reqs[reqs.length - 1].title).toBe('ליאת חוגגת 40');
  });

  test('a long title shows a non-blocking "may print small" note but never blocks', async ({
    page,
  }) => {
    const reqs = await mockPreview(page);
    await gotoNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    const warn = page.getByTestId('custom-title-warn');
    await expect(warn).toBeHidden(); // no warning for an empty / short title

    await page.getByTestId('custom-title-input').fill('כותרת ארוכה מאוד מאוד שלא נגמרת בכלל');
    await expect(warn).toBeVisible(); // advisory note appears

    // it is NON-blocking: the preview still fires with the long title
    await expect.poll(() => reqs.some((r) => (r.title || '').includes('כותרת ארוכה'))).toBe(true);
    // and the wizard can still advance (Next is not disabled by the warning)
    await expect(page.getByTestId('next-btn')).toBeEnabled();
  });
});
