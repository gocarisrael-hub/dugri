import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// The order wizard collects a generator theme's required extra fields on the
// name step: AGE for the japanese/kids themes (YEARS + two names for
// anniversary). This covers the AGE case: the input appears, is required, and
// is sent — with the resolved theme — in the POST /api/collections payload.

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

// A 1x1 transparent PNG data URL used as the fake rendered preview image.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// The create button is gated on the name step until the name-preview shows, so
// stub /api/preview to open the gate deterministically without the Python render.
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

// Pick a design by its tile testid, then advance to the name step (step 2
// (colour + add-ons) has safe defaults, so Next walks straight through).
async function toNameStepWithDesign(page, designTestId) {
  await mockPreview(page);
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId(designTestId).click();
  await page.getByTestId('next-btn').click(); // -> step 2 (colour + add-ons)
  await page.getByTestId('next-btn').click(); // -> step 3 (name)
  await expect(page.getByTestId('step-3')).toBeVisible();
}

test.describe('theme extra fields on the name step', () => {
  test('a design whose theme needs no extra fields shows none', async ({ page }) => {
    // design-0 = bachelorette -> theme "bachelorette" (extra_fields: [])
    await toNameStepWithDesign(page, 'design-0');
    await expect(page.getByTestId('extra-fields')).toBeHidden();
  });

  test('the AGE-theme design reveals a required age input', async ({ page }) => {
    // design-3 = japanese -> theme "japanese" (extra_fields: [AGE])
    await toNameStepWithDesign(page, 'design-3');
    await expect(page.getByTestId('extra-fields')).toBeVisible();
    await expect(page.getByTestId('extra-age')).toBeVisible();
    // name + gender set but age blank -> Next stays disabled (age is required)...
    await page.getByTestId('honoree-input').fill('Shira');
    await page.getByTestId('gender-female').check();
    await expect(page.getByTestId('next-btn')).toBeDisabled();
    // ...filling the age enables it.
    await page.getByTestId('extra-age').fill('30');
    await expect(page.getByTestId('next-btn')).toBeEnabled();
  });

  test('the age value + resolved theme are sent in the create payload', async ({ page }) => {
    const captured = await captureCollectionPost(page);
    await toNameStepWithDesign(page, 'design-3');
    await page.getByTestId('honoree-input').fill('Shira');
    await page.getByTestId('gender-female').check();
    await page.getByTestId('extra-age').fill('30');
    await page.getByTestId('next-btn').click(); // -> pawn step
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('next-btn').click(); // -> step 4 (contact)
    await page.getByTestId('owner-email').fill('a@b.com');
    await page.getByTestId('owner-phone').fill('0521234567');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => captured.body && captured.body.theme).toBe('japanese');
    expect(captured.body.extra_fields).toEqual({ AGE: '30' });
  });
});

// Marriage / anniversary is a COUPLE event (#8b): the name step must ask the two
// partners' names ONCE — not a single "name" AND then two names. The lone honoree
// name box + gender picker are hidden; the two NAME fields (+ YEARS) are the ask.
test.describe('anniversary (couple) name step', () => {
  // design-1 = marriage -> theme "anniversary" (extra_fields: YEARS, NAME1, NAME2)
  test('hides the single-name box + gender and asks the two partner names once', async ({
    page,
  }) => {
    await toNameStepWithDesign(page, 'design-1');
    await expect(page.getByTestId('extra-fields')).toBeVisible();
    // No redundant single-name ask, and no gender for a couple.
    await expect(page.getByTestId('honoree-input')).toBeHidden();
    await expect(page.getByTestId('gender-group')).toBeHidden();
    // The two partner names + years ARE the ask.
    await expect(page.getByTestId('extra-name1')).toBeVisible();
    await expect(page.getByTestId('extra-name2')).toBeVisible();
    await expect(page.getByTestId('extra-years')).toBeVisible();
    await expect(page.getByTestId('step-3')).toContainText('שמות בני הזוג');
  });

  test('requires both names + years and advances with NO gender prompt', async ({ page }) => {
    await toNameStepWithDesign(page, 'design-1');
    // Blank / partial -> Next disabled.
    await expect(page.getByTestId('next-btn')).toBeDisabled();
    await page.getByTestId('extra-name1').fill('דנה');
    await page.getByTestId('extra-name2').fill('יוסי');
    await expect(page.getByTestId('next-btn')).toBeDisabled(); // years still blank
    await page.getByTestId('extra-years').fill('25');
    await expect(page.getByTestId('next-btn')).toBeEnabled();
    // Advancing must NOT pop the gender prompt (couples have no single gender).
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('gender-modal')).toBeHidden();
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
  });

  test('sends the couple honoree name synthesized from both partner names', async ({ page }) => {
    const captured = await captureCollectionPost(page);
    await toNameStepWithDesign(page, 'design-1');
    await page.getByTestId('extra-name1').fill('דנה');
    await page.getByTestId('extra-name2').fill('יוסי');
    await page.getByTestId('extra-years').fill('25');
    await page.getByTestId('next-btn').click(); // -> pawn step
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('next-btn').click(); // -> step 4 (contact)
    await page.getByTestId('owner-email').fill('a@b.com');
    await page.getByTestId('owner-phone').fill('0521234567');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => captured.body && captured.body.theme).toBe('anniversary');
    expect(captured.body.honoree_name).toBe('דנה ויוסי');
    expect(captured.body.extra_fields).toEqual({ YEARS: '25', NAME1: 'דנה', NAME2: 'יוסי' });
  });
});
