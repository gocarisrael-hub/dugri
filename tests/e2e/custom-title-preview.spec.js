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

test.describe('the title on step 3', () => {
  test('the title input is the step, and nothing is previewed until it is typed', async ({
    page,
  }) => {
    // It used to be an OPTIONAL override on top of a title the theme composed, and
    // an empty box meant "use the design's own". There is no design title behind
    // it any more — the buyer's text IS the title — so an empty box has nothing to
    // preview and the step cannot be left.
    const reqs = await mockPreview(page);
    await gotoNameStep(page);

    const titleInput = page.getByTestId('custom-title-input');
    await expect(titleInput).toBeVisible();
    await expect(titleInput).toHaveValue(''); // empty on arrival
    await expect(page.getByTestId('next-btn')).toBeDisabled();
    // Nothing was asked of the server for an empty title.
    await page.waitForTimeout(600);
    expect(reqs).toHaveLength(0);

    // The moment there IS a title, it is what the preview renders.
    await titleInput.fill('ליאת חוגגת 40');
    await expect.poll(() => reqs.length).toBeGreaterThanOrEqual(1);
    expect(reqs[reqs.length - 1].title).toBe('ליאת חוגגת 40');
  });

  test('editing the title re-requests the preview with the typed title', async ({ page }) => {
    const reqs = await mockPreview(page);
    await gotoNameStep(page);

    await page.getByTestId('custom-title-input').fill('Shira');
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
    await page.getByTestId('custom-title-input').fill('Shira');

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
