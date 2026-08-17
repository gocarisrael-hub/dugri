import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// THE NAME-LANGUAGE NOTE IS GONE FROM THE WIZARD — for every design in the picker.
//
// Under "כך זה ייראה עם השם:" the preview used to print
//
//     שם החוגג/ת צריך להיות באנגלית (בהתאם לעיצוב): "חגי תשרי"
//
// on every Latin-scripted template, about a name that is only the order's label
// and is printed on nothing. The route stopped sending it (unit sweep in
// tests/unit/preview-no-name-language-note.test.js); this spec covers the other
// half — that the PAGE has nowhere to put one.
//
// So the mock here does the opposite of the real server on purpose: it answers
// every preview with the note in `warning`. That is the only way to prove the
// removal is structural rather than a property of the current response. A
// template whose settings live only on the Railway volume, or an older server,
// could still send the field; the buyer must not see it either way.
//
// And it runs over EVERY design tile, not one. The bug being fixed was reported
// as "you removed it from one template" — a spec that checks design-0 would
// reproduce exactly that mistake.

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const FONT_OPTIONS = [
  { label: 'Cafe', file: 'Cafe Regular.ttf' },
  { label: 'Fredoka', file: 'Fredoka-Medium.ttf' },
];

// The note, exactly as server/validate.js composes it.
const NOTE = 'שם החוגג/ת צריך להיות באנגלית (בהתאם לעיצוב): "חגי תשרי"';

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  // Every preview comes back WITH the note. See the header: this is deliberate.
  await page.route('**/api/preview', async (route) => {
    const body = route.request().postDataJSON() || {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        card: PNG,
        back: PNG,
        ...(body.board ? { board: PNG } : {}),
        warning: NOTE,
        word_font: body.word_font || null,
        word_font_options: FONT_OPTIONS,
      }),
    });
  });
});

// Walk the wizard to the name step on the design at picker index `i`.
async function toNameStep(page, i) {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId('design-' + i).click();
  await page.getByTestId('next-btn').click(); // -> step 2 (colour + add-ons)
  await page.getByTestId('next-btn').click(); // -> step 3 (title)
  await expect(page.getByTestId('step-3')).toBeVisible();
}

test.describe('name-language note', () => {
  test('no design in the picker can show it, even when the server sends it', async ({ page }) => {
    await page.goto('/options.html?plan=base');
    await expect(page.getByTestId('step-1')).toBeVisible();
    // The tiles a buyer can actually pick. Private designs are built but hidden
    // (the indices stay stable), so they are excluded here the same way the
    // buyer's eye excludes them.
    const tiles = page.locator('#designList button.design:not([hidden])');
    const count = await tiles.count();
    // The sweep is worthless if the list came back empty — say so out loud.
    expect(count).toBeGreaterThan(1);

    const indices = [];
    for (let i = 0; i < count; i++) {
      indices.push(Number((await tiles.nth(i).getAttribute('data-testid')).split('-')[1]));
    }

    for (const i of indices) {
      await toNameStep(page, i);
      await page.getByTestId('custom-title-input').fill('חגי תשרי');

      // The preview really did render for this design — otherwise "no note"
      // would just mean "nothing happened".
      const card = page.getByTestId('name-preview-card');
      await expect(card, 'design ' + i + ' rendered a card').toBeVisible();
      await expect(card).toHaveAttribute('src', /^data:image\/png/);

      // The element the note used to live in does not exist at all...
      await expect(
        page.getByTestId('name-preview-warning'),
        'design ' + i + ' has no warning element'
      ).toHaveCount(0);
      // ...and its wording appears nowhere else on the page either.
      await expect(page.locator('body'), 'design ' + i + ' shows no note').not.toContainText(
        'שם החוגג/ת צריך להיות'
      );
      await expect(page.locator('body')).not.toContainText('בהתאם לעיצוב');
    }
  });
});
