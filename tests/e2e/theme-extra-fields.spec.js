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
// name step: AGE for the japanese/kids themes, YEARS + two partner names on a
// couple deck. WHICH fields a design collects is owner-editable in the admin, so
// the wizard resolves them live (GET /api/design-names -> fields) rather than
// from the mirror baked into its bundle. This covers the AGE case: the input
// appears, is required, and is sent — with the resolved theme — in the POST
// /api/collections payload.

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

// סנטוריני (design-1 = marriage -> theme "anniversary") USED to be a couple
// anniversary deck. The owner changed it, in the admin, into a deck about ONE
// person: she enters a name and nothing else.
//
// The wizard hid the single-name box and composed the honoree name out of
// NAME1 + NAME2 whenever the theme was called "anniversary" — a NAME check, not a
// FIELDS check. With the couple fields gone that combination is fatal: the lone
// name box stays hidden, the composed name is always empty, and NOBODY can place
// an order for this design at all. These tests are the guard on that.
test.describe('סנטוריני is a ONE-PERSON deck', () => {
  test('asks for a single name — no partner names, no years', async ({ page }) => {
    await toNameStepWithDesign(page, 'design-1');
    await expect(page.getByTestId('extra-fields')).toBeHidden();
    await expect(page.getByTestId('extra-name1')).toBeHidden();
    await expect(page.getByTestId('extra-name2')).toBeHidden();
    await expect(page.getByTestId('extra-years')).toBeHidden();
    // The single-name ask is BACK — this is the input that used to be hidden with
    // nothing put in its place.
    await expect(page.getByTestId('honoree-input')).toBeVisible();
    await expect(page.getByTestId('gender-group')).toBeVisible();
    await expect(page.getByTestId('step-3')).toContainText('שם בעל/ת השמחה');
  });

  test('a buyer can complete an order for it with only a name', async ({ page }) => {
    const captured = await captureCollectionPost(page);
    await toNameStepWithDesign(page, 'design-1');
    await expect(page.getByTestId('next-btn')).toBeDisabled(); // name still blank
    await page.getByTestId('honoree-input').fill('מיכל');
    await page.getByTestId('gender-female').check();
    await expect(page.getByTestId('next-btn')).toBeEnabled();
    await page.getByTestId('next-btn').click(); // -> pawn step
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('next-btn').click(); // -> step 4 (contact)
    await page.getByTestId('owner-email').fill('a@b.com');
    await page.getByTestId('owner-phone').fill('0521234567');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => captured.body && captured.body.theme).toBe('anniversary');
    // The name the buyer typed, not an empty string composed from two hidden boxes.
    expect(captured.body.honoree_name).toBe('מיכל');
    expect(captured.body.extra_fields).toEqual({});
  });
});

// Couple mode still EXISTS — it is just no longer welded to a theme called
// "anniversary". It is now decided by the fields a design actually collects, so
// any deck that asks for NAME1 + NAME2 gets it, and one that stops asking loses
// it. These tests drive it exactly the way production does: through the live
// fields the owner edits in the admin.
test.describe('an admin field change reaches the wizard with no rebuild', () => {
  test('declaring NAME1+NAME2 turns the SAME design back into a couple ask', async ({ page }) => {
    await stubDesignFields(page, COUPLE_FIELDS);
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
    await stubDesignFields(page, COUPLE_FIELDS);
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
    await stubDesignFields(page, COUPLE_FIELDS);
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

  test('adding AGE to a fieldless design makes the wizard ask for it', async ({ page }) => {
    // design-0 = bachelorette, which ships extra_fields: []. Nothing about this
    // design is special-cased anywhere — if the owner says it collects an age, the
    // wizard collects an age.
    await stubDesignFields(page, { bachelorette: { extra_fields: ['AGE'] } });
    await toNameStepWithDesign(page, 'design-0');
    await expect(page.getByTestId('extra-fields')).toBeVisible();
    await expect(page.getByTestId('extra-age')).toBeVisible();
    await page.getByTestId('honoree-input').fill('Shira');
    await page.getByTestId('gender-female').check();
    await expect(page.getByTestId('next-btn')).toBeDisabled(); // age required now
    await page.getByTestId('extra-age').fill('30');
    await expect(page.getByTestId('next-btn')).toBeEnabled();
  });

  test('a dead endpoint leaves the wizard on its bundled fields (still orderable)', async ({
    page,
  }) => {
    // Fail-safe: the fields ride on a buyer-facing fetch, so a 500 (or a timeout,
    // or garbage) must never leave the name step blank or stuck.
    await page.route('**/api/design-names', (route) => route.fulfill({ status: 500, body: '' }));
    await toNameStepWithDesign(page, 'design-3'); // japanese -> AGE in the bundle
    await expect(page.getByTestId('extra-age')).toBeVisible();
    await page.getByTestId('honoree-input').fill('Shira');
    await page.getByTestId('gender-female').check();
    await page.getByTestId('extra-age').fill('30');
    await expect(page.getByTestId('next-btn')).toBeEnabled();
  });
});

// A custom title (F7) OVERRIDES the design's own title, so the theme extra fields
// (AGE / wedding YEARS / partner NAMES) that only ever fed the DEFAULT title are
// no longer needed. With a custom title set: the extras stop being required, a
// note explains why, and the couple theme reverts to the single honoree-name ask.
test.describe('custom title relaxes the theme extra fields', () => {
  test('AGE stops being required + the skip note shows (and reverses on clear)', async ({
    page,
  }) => {
    await toNameStepWithDesign(page, 'design-3'); // japanese -> AGE required
    await expect(page.getByTestId('extra-age')).toBeVisible();
    await page.getByTestId('honoree-input').fill('Shira');
    await page.getByTestId('gender-female').check();
    // baseline: age blank -> Next disabled, no skip note.
    await expect(page.getByTestId('extra-fields-skip-note')).toBeHidden();
    await expect(page.getByTestId('next-btn')).toBeDisabled();
    // typing a custom title drops the age requirement + reveals the note.
    await page.getByTestId('custom-title-input').fill('שירה חוגגת 40');
    await expect(page.getByTestId('extra-fields-skip-note')).toBeVisible();
    await expect(page.getByTestId('extra-age')).toBeHidden();
    await expect(page.getByTestId('next-btn')).toBeEnabled();
    // clearing it restores the original required-age behaviour.
    await page.getByTestId('custom-title-input').fill('');
    await expect(page.getByTestId('extra-fields-skip-note')).toBeHidden();
    await expect(page.getByTestId('extra-age')).toBeVisible();
    await expect(page.getByTestId('next-btn')).toBeDisabled();
  });

  test('a couple deck + custom title shows the SINGLE name input, not the two partners', async ({
    page,
  }) => {
    await stubDesignFields(page, COUPLE_FIELDS);
    await toNameStepWithDesign(page, 'design-1'); // couple fields -> two partner names
    // baseline couple mode: two partner names, no single box, no gender.
    await expect(page.getByTestId('extra-name1')).toBeVisible();
    await expect(page.getByTestId('honoree-input')).toBeHidden();
    // a custom title reverts to the single honoree-name ask.
    await page.getByTestId('custom-title-input').fill('דנה ויוסי חוגגים 25');
    await expect(page.getByTestId('extra-fields-skip-note')).toBeVisible();
    await expect(page.getByTestId('honoree-input')).toBeVisible();
    await expect(page.getByTestId('extra-name1')).toBeHidden();
    await expect(page.getByTestId('extra-name2')).toBeHidden();
    // Gender belongs to the EVENT type: a couple deck has no single gender even
    // with a custom title, so the picker stays hidden.
    await expect(page.getByTestId('gender-group')).toBeHidden();
  });

  test('a couple deck + custom title sends one honoree name and NO extra fields', async ({
    page,
  }) => {
    await stubDesignFields(page, COUPLE_FIELDS);
    const captured = await captureCollectionPost(page);
    await toNameStepWithDesign(page, 'design-1');
    await page.getByTestId('custom-title-input').fill('דנה ויוסי');
    await page.getByTestId('honoree-input').fill('דנה');
    // No gender is asked for a couple — the single name alone advances the step.
    await page.getByTestId('next-btn').click(); // -> pawn step
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('next-btn').click(); // -> step 4 (contact)
    await page.getByTestId('owner-email').fill('a@b.com');
    await page.getByTestId('owner-phone').fill('0521234567');
    await page.getByTestId('next-btn').click(); // create
    await expect.poll(() => captured.body && captured.body.honoree_name).toBe('דנה');
    expect(captured.body.extra_fields).toEqual({});
    expect(captured.body.custom_title).toBe('דנה ויוסי');
  });
});
