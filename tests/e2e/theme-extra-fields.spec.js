import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// THE WIZARD NO LONGER ASKS FOR EXTRA FIELDS — and this file is what is left of
// the spec that proved it did.
//
// AGE, YEARS and the two partner names existed for ONE purpose: to fill the
// blanks in a title the theme composed ("{NAME} {m:בן|f:בת} {AGE}"). The owner
// removed that whole mechanism — "no name no gender only free text title" — so
// nothing consumes them. Asking a buyer for her mother's age to print a title she
// typed herself would be a question with no answer behind it.
//
// The tests that asserted the asking are gone. What survives is the guarantee
// that matters now: whatever a theme DECLARES, the wizard asks nothing extra and
// the order carries nothing extra — and the theme itself still resolves onto the
// order, because that is what picks the artwork.

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

// Make GET /api/design-names declare a design's extra fields.
//
// This is the OWNER's channel, and the reason it exists: she edits a template's
// extra_fields in the admin, they land in themes.json on the volume, and this
// endpoint is the only way they can reach a wizard whose own copy of themes.json
// is compiled into the browser bundle. Stubbing it is therefore the honest way to
// exercise "the owner changed the fields" without an admin round trip.
async function stubDesignFields(page, fields) {
  await page.route('**/api/design-names', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ names: {}, fields }),
    })
  );
}

// סנטוריני (design id `marriage`) as a COUPLE deck — the shape it had before the
// owner made it a one-person deck. Nothing in the repo ships couple fields any
// more, so couple mode is now exercised exactly the way a real one would arrive.
const COUPLE_FIELDS = {
  marriage: { extra_fields: ['YEARS', 'NAME1', 'NAME2'], language: 'hebrew' },
};

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

test.describe('a theme that declares extra fields', () => {
  test('is not asked about — no matter what it declares', async ({ page }) => {
    // The owner's own channel says this design wants an age...
    await stubDesignFields(page, { 'birthday-girls': { extra_fields: ['AGE'] } });
    await toNameStepWithDesign(page, 'design-2');
    // ...and the step asks for a title, and only a title.
    await expect(page.getByTestId('custom-title-input')).toBeVisible();
    await expect(page.getByTestId('extra-fields')).toHaveCount(0);
    await expect(page.getByTestId('extra-age')).toHaveCount(0);
  });

  test('does not hold up the order, and still reaches it as the THEME', async ({ page }) => {
    // The failure this guards: an order that cannot be completed because the
    // wizard is waiting for a field it no longer shows. The theme still has to
    // travel — it is what picks the artwork.
    await stubDesignFields(page, { 'birthday-girls': { extra_fields: ['AGE'] } });
    const captured = await captureCollectionPost(page);
    await toNameStepWithDesign(page, 'design-2');
    await page.fill('#customTitleInput', 'יעל חוגגת 12');
    await page.getByTestId('next-btn').click(); // -> pawn photos
    await page.getByTestId('next-btn').click(); // -> contact
    await page.fill('#ownerEmail', 'owner@example.com');
    await page.fill('#ownerPhone', '0521234567');
    await page.getByTestId('next-btn').click();

    await expect.poll(() => !!captured.body).toBe(true);
    expect(captured.body.custom_title).toBe('יעל חוגגת 12');
    expect(captured.body.extra_fields).toEqual({});
    expect(captured.body.theme).toBeTruthy();
    // The order's LABEL is the title's first line — it is not printed anywhere.
    expect(captured.body.honoree_name).toBe('יעל חוגגת 12');
    // Nothing gendered is collected any more.
    expect(captured.body.gender).toBe(null);
  });

  test('a couple deck asks for a title too, not two partner names', async ({ page }) => {
    // סנטוריני as a couple deck — the shape the owner can still declare. It used
    // to swap the single-name ask for two partner names and synthesize "דנה ויוסי"
    // as the honoree; now there is one box and it is the title.
    await stubDesignFields(page, COUPLE_FIELDS);
    await toNameStepWithDesign(page, 'design-1'); // סנטוריני
    await expect(page.getByTestId('custom-title-input')).toBeVisible();
    await expect(page.getByTestId('extra-name1')).toHaveCount(0);
    await expect(page.getByTestId('extra-name2')).toHaveCount(0);
    await expect(page.getByTestId('extra-years')).toHaveCount(0);
  });
});
