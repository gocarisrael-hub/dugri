import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// THE EMOJI REFUSAL, from the buyer's chair — "refuse for emojis in title and
// words" (the shop owner).
//
// The unit tests pin the rule; this spec pins the EXPERIENCE, which is the part
// the owner actually asked for. Everything typed into the title box or the word
// list is printed. The card faces are Hebrew and Latin display fonts with no
// emoji glyphs, so a 🎉 does not print as a 🎉 — it prints as a blank box, on all
// 104 cards, and the customer discovers it when the parcel opens. Silently
// removing it would be worse: she typed it deliberately and nothing would ever
// tell her it had gone.
//
// So the shape of every test here is the same three beats:
//   she types the emoji → she is told, in Hebrew, exactly what to remove →
//   she fixes it and carries straight on.
//
// And the other half, which is what stops the rule becoming a nuisance: a buyer
// typing an ordinary name, a geresh, an en dash or a © must sail through
// untouched. A refused legitimate name is a lost order.

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// Stub /api/preview (the real render needs Chrome + Python) AND record every
// request body, so a test can prove the wizard did NOT ask the server to draw a
// title it already knows is unprintable.
async function mockPreview(page) {
  const reqs = [];
  await page.route('**/api/preview', async (route) => {
    reqs.push(route.request().postDataJSON() || {});
    await route.fulfill({
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
    });
  });
  return reqs;
}

// Walk the wizard to step 3 (the name + title step) on the default design.
async function gotoNameStep(page) {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId('design-0').click();
  await page.getByTestId('next-btn').click(); // -> colour + add-ons
  await page.getByTestId('next-btn').click(); // -> name
  await expect(page.getByTestId('step-3')).toBeVisible();
}

// Create a real collection and land on its word-collection page.
async function createCollection(page, name) {
  await mockPreview(page);
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#customTitleInput', name);
  await page.getByTestId('next-btn').click(); // -> pawn photos
  await page.getByTestId('next-btn').click(); // -> contact
  await page.fill('#ownerEmail', 'test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.getByTestId('next-btn').click(); // create
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
}

// ---------------------------------------------------------------------------
// The title
// ---------------------------------------------------------------------------

test.describe('the custom title', () => {
  test('she types 🎉, is told why, fixes it, and moves on', async ({ page }) => {
    const reqs = await mockPreview(page);
    await gotoNameStep(page);
    await page.fill('#customTitleInput', 'Shira');

    const err = page.getByTestId('custom-title-err');
    const next = page.getByTestId('next-btn');
    await expect(err).toBeHidden(); // nothing typed yet — no scolding

    // 1. She types the emoji.
    await page.getByTestId('custom-title-input').fill('שירה חוגגת 40 🎉');

    // 2. She is told — in the field, in Hebrew, naming the character to remove
    //    and saying WHY (it cannot be printed). Not "invalid input".
    await expect(err).toBeVisible();
    await expect(err).toContainText('אימוג׳י');
    await expect(err).toContainText('להדפיס');
    await expect(err).toContainText('🎉');
    // ...and "הבא" is held, because there is no version of "continue anyway"
    // that does not end with a blank box on 104 printed cards.
    await expect(next).toBeDisabled();

    // The wizard also stops asking the server to DRAW it: the preview is sold as
    // WYSIWYG, and a render of a title we already know is unprintable would show
    // her a broken card with no explanation.
    const asked = reqs.filter((r) => (r.title || '').includes('🎉'));
    expect(asked).toEqual([]);

    // 3. She fixes it and carries on — the refusal clears the moment it is out.
    await page.getByTestId('custom-title-input').fill('שירה חוגגת 40');
    await expect(err).toBeHidden();
    await expect(next).toBeEnabled();
    await expect.poll(() => reqs.some((r) => r.title === 'שירה חוגגת 40')).toBe(true);
  });

  test('the refusal is a BLOCK, unlike the "may print small" note beside it', async ({ page }) => {
    // Two hints live under this field and they mean different things. The amber
    // one is advice ("a long title prints smaller — have a look at the preview");
    // this one is a refusal. Confusing them in either direction is a bug: an
    // advisory that blocks is a nuisance, a block that only advises ships an
    // unprintable deck.
    await mockPreview(page);
    await gotoNameStep(page);
    await page.fill('#customTitleInput', 'Shira');

    await page.getByTestId('custom-title-input').fill('כותרת ארוכה מאוד מאוד שלא נגמרת בכלל');
    await expect(page.getByTestId('custom-title-warn')).toBeVisible();
    await expect(page.getByTestId('custom-title-err')).toBeHidden();
    await expect(page.getByTestId('next-btn')).toBeEnabled(); // advisory: never blocks

    await page.getByTestId('custom-title-input').fill('מסיבה 🎉');
    await expect(page.getByTestId('custom-title-err')).toBeVisible();
    await expect(page.getByTestId('next-btn')).toBeDisabled(); // refusal: blocks
  });

  test('every legitimate title she might type is accepted', async ({ page }) => {
    // The nuisance guard. A geresh, an en dash a phone substituted for a hyphen,
    // digits, ordinary punctuation, ©. Refuse any one of these and the order is
    // lost to a rule nobody asked for.
    await mockPreview(page);
    await gotoNameStep(page);
    await page.fill('#customTitleInput', 'Shira');

    const err = page.getByTestId('custom-title-err');
    for (const title of [
      'מזל טוב ׳לשירה׳',
      'דנה–יוסי חוגגים 25',
      'ליאת חוגגת 40!',
      '© דוגרי',
      "O'Neil's night",
    ]) {
      await page.getByTestId('custom-title-input').fill(title);
      await expect(err, 'should have been accepted: ' + title).toBeHidden();
      await expect(page.getByTestId('next-btn')).toBeEnabled();
    }
  });

  test('an emoji in a title is refused by the API too, not only by the field', async ({ page }) => {
    // The field check is a courtesy; a re-post, a stale tab or anything that is
    // not this browser has to hit the same wall. This is that wall.
    const res = await page.request.post('/api/collections', {
      data: { honoree_name: 'Shira', custom_title: 'מסיבה 🎉' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('emoji');
    expect(body.field).toBe('custom_title');
    expect(body.message).toContain('🎉');

    // ...and the identical request without the emoji goes through, so the rule is
    // about the emoji and nothing else.
    const ok = await page.request.post('/api/collections', {
      data: { honoree_name: 'Shira', custom_title: 'מסיבה' },
    });
    expect(ok.status()).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

test.describe('the word list', () => {
  test('she types a word with 🍕, is told why, fixes it, and it lands', async ({ page }) => {
    await createCollection(page, 'Shira');

    const hint = page.locator('#wordLenHint');
    const addBtn = page.locator('#addBtn');

    // 1. She types the emoji.
    await page.fill('#wordInput', 'פיצה 🍕');

    // 2. She is told, live, while the word is still in front of her — and the
    //    add button is held rather than letting the submit fail later.
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('אימוג׳י');
    await expect(hint).toContainText('🍕');
    await expect(addBtn).toBeDisabled();

    // 3. She drops the emoji and the word goes in.
    await page.fill('#wordInput', 'פיצה');
    await expect(hint).toBeHidden();
    await expect(addBtn).toBeEnabled();
    await addBtn.click();
    await expect(page.locator('#wordsWrap')).toContainText('פיצה');
    await expect(page.locator('#count')).toHaveText('1');
  });

  test('a paste keeps its good words and names the ones it left behind', async ({ page }) => {
    // Partial acceptance. Throwing away 39 good words because the 40th had a 🍕
    // would be a worse failure than the emoji ever was.
    await createCollection(page, 'Shira');
    await page.click('#tab-list');
    await page.fill('#pasteBox', 'קמפינג\nפיצה 🍕\nהדייט מטבריה');
    await page.click('#pasteAdd');

    await expect(page.locator('#wordsWrap')).toContainText('קמפינג');
    await expect(page.locator('#wordsWrap')).toContainText('הדייט מטבריה');
    await expect(page.locator('#wordsWrap')).not.toContainText('🍕');
    await expect(page.locator('#count')).toHaveText('2');
    // and the toast says what did NOT land, and why — a partial add must never
    // look like a clean success.
    await expect(page.locator('#toast')).toContainText('אימוג׳י');
  });

  test('a legitimate list is untouched — no word is refused for looking unusual', async ({
    page,
  }) => {
    await createCollection(page, 'Shira');
    await page.click('#tab-list');
    await page.fill('#pasteBox', ['מזל טוב ׳שירה׳', 'דנה–יוסי', 'מכבי חיפה', '© דוגרי'].join('\n'));
    await page.click('#pasteAdd');

    await expect(page.locator('#count')).toHaveText('4');
    await expect(page.locator('#toast')).not.toContainText('אימוג׳י');
  });

  test('the API refuses an emoji word posted straight at it', async ({ page }) => {
    // The store is where this is enforced, which is what also covers the WhatsApp
    // webhook — and a WhatsApp group is where emoji actually come from.
    await createCollection(page, 'Shira');
    const id = new URL(page.url()).searchParams.get('c');

    const res = await page.request.post('/api/collections/' + id + '/words', {
      data: { words: ['קמפינג', 'פיצה 🍕'] },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(1);
    expect(body.emoji).toBe(1);
    expect(body.count).toBe(1);
  });
});
