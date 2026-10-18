import { test, expect } from '@playwright/test';

// The homepage's (new.html) recommendations, edited by the owner in the content editor. What these pin:
// - every review's quote, occasion, caption (name · date) and screenshot, and every logo's picture and name, take the
//   owner's saved edits, in all three copies of the endless row;
// - a review whose quote she empties, or a logo whose name she empties, leaves the row; the sheet shows her caption
//   (the occasion until she writes one) under her screenshot;
// - in edit mode the caption, the screenshot and the logo's name show in the card to be edited, an emptied card stays
//   (faded) to be filled again, the row holds still and a card does not open;
// - the business text leads with the gift, and the design view has no swipe hint.

const OVERRIDES = {
  'new-review-2-quote': { text: '' },
  'new-review-3-quote': { text: 'ציטוט חדש מהאדמין' },
  'new-review-3-tag': { text: 'חתונה' },
  'new-review-3-cap': { text: 'נועה · מרץ 2026' },
  'new-review-3-shot': { img: 'assets/home/reviews/r1.jpg' },
  'new-logo-1': { img: 'assets/home/logos/hm.webp' },
  'new-logo-1-name': { text: 'חברה חדשה' },
  'new-logo-2-name': { text: '' },
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
  await page.route('**/api/content*', (route) =>
    route.fulfill({
      json: {
        overrides:
          new URL(route.request().url()).searchParams.get('page') === 'new.html' ? OVERRIDES : {},
      },
    })
  );
});

const copies = (page, sel) => page.locator(`#track ${sel}`);
// what is on screen, not the hidden flag: a card's own display rule can keep a [hidden] card showing
const shown = (loc) =>
  loc.evaluateAll(
    (els) => els.filter((e) => getComputedStyle(e.closest('.rc')).display !== 'none').length
  );

test.describe('the recommendations take the owner’s edits', () => {
  test('in all three copies: texts, the screenshot, the logo and its name; emptied cards leave the row', async ({
    page,
  }) => {
    await page.goto('/new.html');
    // the reviews: 8 a copy, one emptied
    await expect.poll(() => shown(copies(page, 'button.rc .ttl'))).toBe(7 * 3);
    await expect(copies(page, 'button.rc .ttl')).toHaveCount(8 * 3);
    const quotes = await copies(page, 'button.rc .ttl').allTextContents();
    expect(quotes.filter((q) => q === 'ציטוט חדש מהאדמין')).toHaveLength(3);
    expect(
      (await copies(page, 'button.rc .tag').allTextContents()).filter((t) => t === 'חתונה')
    ).toHaveLength(3);
    expect(
      await copies(page, 'button.rc .shot').evaluateAll(
        (els) => els.filter((e) => e.getAttribute('src') === 'assets/home/reviews/r1.jpg').length
      )
    ).toBe(3 + 3); // review 7's own screenshot, and review 3's new one
    // the logos: 5 a copy, one emptied; the first is the new picture under its new name
    await expect.poll(() => shown(copies(page, '.rc.logo img'))).toBe(4 * 3);
    const logo1 = await copies(page, '.rc.logo img').evaluateAll((els) =>
      els.filter((e, i) => i % 5 === 0).map((e) => [e.getAttribute('src'), e.alt])
    );
    expect(logo1).toEqual(Array(3).fill(['assets/home/logos/hm.webp', 'חברה חדשה']));
    // nothing in the row is a gap: the row still loops over whole copies
    const sx = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sx).toBe(0);
  });

  test('a review opens on the owner’s screenshot and caption; with no caption, its occasion', async ({
    page,
  }) => {
    await page.goto('/new.html');
    const card = page.locator('#track button.rc:not([aria-hidden])', {
      hasText: 'ציטוט חדש מהאדמין',
    });
    await card.evaluate((b) => b.click());
    await expect(page.locator('#sheet')).toHaveAttribute('open', '');
    await expect(page.locator('#sheetPic img')).toHaveAttribute(
      'src',
      'assets/home/reviews/r1.jpg'
    );
    await expect(page.locator('#sheetCap')).toHaveText('נועה · מרץ 2026');
    await page.keyboard.press('Escape');
    await expect(page.locator('#sheet')).not.toHaveAttribute('open', '');
    await page
      .locator('#track button.rc:not([aria-hidden])')
      .first()
      .evaluate((b) => b.click());
    await expect(page.locator('#sheetCap')).toHaveText('מסיבת רווקות');
    await expect(page.locator('#sheetPic img')).toHaveAttribute(
      'src',
      'assets/home/reviews/r7.jpg'
    );
  });

  test('in edit mode: caption, screenshot and logo name show to be edited, emptied cards stay, the row holds still', async ({
    page,
  }) => {
    await page.goto('/new.html?edit=1&key=dugri-admin');
    await expect(page.locator('html')).toHaveClass(/dugri-editing/);
    const real = page.locator('#track > :not([aria-hidden])');
    await expect(real).toHaveCount(13);
    for (const sel of [
      '[data-edit="new-review-3-cap"]',
      '[data-edit-img="new-review-3-shot"]',
      '[data-edit="new-logo-1-name"]',
    ])
      await expect(page.locator(sel)).toBeVisible();
    await expect(page.locator('[data-edit="new-review-2-quote"]')).toBeVisible(); // emptied, and still there to fill
    await expect(page.locator('#track > .rc-empty:not([aria-hidden])')).toHaveCount(2);
    // the row does not drift under the owner's cursor, and a card does not open
    await page.locator('#recs').scrollIntoViewIfNeeded();
    const sl = await page.locator('#row').evaluate((r) => r.scrollLeft);
    await page.waitForTimeout(800);
    expect(await page.locator('#row').evaluate((r) => r.scrollLeft)).toBe(sl);
    await page.locator('[data-edit="new-review-4-quote"]').click();
    await expect(page.locator('#sheet')).not.toHaveAttribute('open', '');
  });
});

test.describe('the owner’s copy', () => {
  test('the business text leads with the gift', async ({ page }) => {
    await page.goto('/new.html');
    await expect(page.locator('[data-edit="new-biz-sub"]')).toHaveText(
      /^\s*מתנה לעובדים, ערב צוות או יום גיבוש\? נבנה לכם דוגרי על הצוות/
    );
  });

  test('the design view has no swipe hint', async ({ page }) => {
    await page.goto('/new.html');
    const tile = page.locator('#strip .dz:not([aria-hidden])').first();
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await expect(page.locator('#flood')).toHaveAttribute('open', '');
    await expect(page.locator('#flood')).not.toContainText('החליקו למטה');
  });
});
