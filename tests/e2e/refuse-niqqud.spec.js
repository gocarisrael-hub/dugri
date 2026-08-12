import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// THE NIQQUD REFUSAL, from the contributor's chair — "can you decline emojis or
// punctuation (ניקוד) in new words in the collecting words page?" (the owner).
//
// The unit tests pin the rule; this spec pins the EXPERIENCE. Every word here is
// printed, and the card faces are display fonts drawn for UNPOINTED Hebrew — so
// "שָׁלוֹם" does not print as a pointed word, it prints with the marks as boxes or
// collided onto the letter, on a deck already paid for. The marks also spend the
// 25-character entry cap.
//
// Same three beats as the emoji spec: she types the pointed word → she is told,
// in Hebrew, with the clean word to type instead → she fixes it and carries on.
//
// And the nuisance guard, which matters more here than for emoji because the
// refused characters live in the middle of the Hebrew block: בן־גוריון (maqaf)
// and ר״ח (gershayim) are ORDINARY Hebrew and must sail through untouched.

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

async function mockPreview(page) {
  await page.route('**/api/preview', async (route) => {
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
}

async function createCollection(page, name) {
  await mockPreview(page);
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#honoreeInput', name);
  await page.getByTestId('gender-female').check();
  await page.getByTestId('next-btn').click(); // -> pawn photos
  await page.getByTestId('next-btn').click(); // -> contact
  await page.fill('#ownerEmail', 'test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.getByTestId('next-btn').click(); // create
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
}

test('she types a pointed word, is told what to write instead, and it lands', async ({ page }) => {
  await createCollection(page, 'Shira');

  const hint = page.locator('#wordLenHint');
  const addBtn = page.locator('#addBtn');

  await page.fill('#wordInput', 'שָׁלוֹם');

  // Told live, while the word is still in front of her — and the button is held
  // rather than letting the submit fail after she has moved on. The message
  // carries the CLEAN word, because the marks are invisible on their own and
  // "remove the niqqud" with nothing to point at is not actionable.
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('ניקוד');
  await expect(hint).toContainText('שלום');
  await expect(addBtn).toBeDisabled();

  await page.fill('#wordInput', 'שלום');
  await expect(hint).toBeHidden();
  await expect(addBtn).toBeEnabled();
  await addBtn.click();
  await expect(page.locator('#wordsWrap')).toContainText('שלום');
  await expect(page.locator('#count')).toHaveText('1');
});

test('a paste keeps its good words and names the pointed ones', async ({ page }) => {
  // Partial acceptance, same as every other entry rule: losing 39 good words
  // because the 40th was pointed would be the worse failure.
  await createCollection(page, 'Shira');
  await page.click('#tab-list');
  await page.fill('#pasteBox', 'קמפינג\nשָׁלוֹם\nהדייט מטבריה');
  await page.click('#pasteAdd');

  await expect(page.locator('#wordsWrap')).toContainText('קמפינג');
  await expect(page.locator('#wordsWrap')).toContainText('הדייט מטבריה');
  await expect(page.locator('#count')).toHaveText('2');
  // A partial add must never look like a clean success.
  await expect(page.locator('#toast')).toContainText('ניקוד');
});

test('the pointed word is refused, never quietly unpointed', async ({ page }) => {
  // The failure this guards: "שָׁלוֹם" landing on the list as "שלום" — a word
  // changed on her behalf, which nothing ever told her about.
  await createCollection(page, 'Shira');
  await page.click('#tab-list');
  await page.fill('#pasteBox', 'שָׁלוֹם');
  await page.click('#pasteAdd');

  await expect(page.locator('#toast')).toContainText('ניקוד');
  await expect(page.locator('#count')).toHaveText('0');
});

test('ordinary Hebrew is untouched — no word is refused for looking unusual', async ({ page }) => {
  // The maqaf and the gershayim live in the same Unicode block as the marks and
  // are ordinary printable type. A buyer refused for typing בן־גוריון is a lost
  // order.
  await createCollection(page, 'Shira');
  await page.click('#tab-list');
  await page.fill('#pasteBox', ['בן־גוריון', 'ר״ח', 'צ׳יפס', 'מכבי חיפה'].join('\n'));
  await page.click('#pasteAdd');

  await expect(page.locator('#count')).toHaveText('4');
  await expect(page.locator('#toast')).not.toContainText('ניקוד');
});

test('the API refuses a pointed word posted straight at it', async ({ page }) => {
  // Enforced in the store, which is what also covers the WhatsApp webhook — and
  // a phone keyboard that points is where pointed words actually come from.
  await createCollection(page, 'Shira');
  const id = new URL(page.url()).searchParams.get('c');

  const res = await page.request.post('/api/collections/' + id + '/words', {
    data: { words: ['קמפינג', 'שָׁלוֹם'] },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.added).toBe(1);
  expect(body.niqqud).toBe(1);
  expect(body.count).toBe(1);
});
