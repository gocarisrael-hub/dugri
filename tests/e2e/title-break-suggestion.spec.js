import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// "maybe it should suggest a new line if the font in the title gets too small?"
//
// The renderer never breaks a title by itself — it breaks where the buyer
// pressed Enter and nowhere else, because a title is her sentence and choosing
// where it breaks is choosing her phrasing. So this SUGGESTS, and one tap
// applies it.
//
// The split is the space that leaves the two halves closest in length: a title
// is sized by its widest line, so an even split is what buys back the most size.

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function toTitleStep(page) {
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
  await page.goto('/options.html?step=3');
  await expect(page.getByTestId('step-3')).toBeVisible();
}

test('a long title is offered a break, and one tap takes it', async ({ page }) => {
  await toTitleStep(page);
  const warn = page.getByTestId('custom-title-warn');
  const offer = page.getByTestId('custom-title-break');

  await page.fill('#customTitleInput', 'ליאת חוגגת ארבעים בגדול');
  await expect(warn).toBeVisible();
  await expect(warn).toContainText('ירידת שורה');
  // The evenest split of that sentence, not simply the middle word.
  await expect(offer).toHaveText('ליאת חוגגת / ארבעים בגדול');

  await offer.click();
  await expect(page.locator('#customTitleInput')).toHaveValue('ליאת חוגגת\nארבעים בגדול');
  // …and once it is two lines there is nothing left to suggest.
  await expect(offer).toBeHidden();
});

test('a title already on two lines is not nagged', async ({ page }) => {
  await toTitleStep(page);
  await page.fill('#customTitleInput', 'החגיגה הגדולה של\nליאת שלנו');
  await expect(page.getByTestId('custom-title-break')).toBeHidden();
});

test('one unbreakable word is told the truth instead', async ({ page }) => {
  // There is no space to break at, so a suggestion would be a lie. The warning
  // still fires — the title WILL print small — it just does not pretend there is
  // an easy fix.
  await toTitleStep(page);
  await page.fill('#customTitleInput', 'אינטרנציונליזם');
  await expect(page.getByTestId('custom-title-warn')).toBeVisible();
  await expect(page.getByTestId('custom-title-warn')).not.toContainText('ירידת שורה');
  await expect(page.getByTestId('custom-title-break')).toBeHidden();
});

test('a short title is left alone entirely', async ({ page }) => {
  await toTitleStep(page);
  await page.fill('#customTitleInput', 'ליאת חוגגת 40');
  await expect(page.getByTestId('custom-title-warn')).toBeHidden();
  await expect(page.getByTestId('custom-title-break')).toBeHidden();
});
