import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// "המשחק שלי" — HER DECK, ON THE PAGE SHE COMES BACK TO.
//
// The order wizard asks for the title and the photos on steps that exist exactly
// once: after "צרו את המשחק" there is no route back to them. So a photo picked by
// mistake, or a title she thought better of, meant writing to us.
//
// They live behind ONE ROW on the collection page now — the page she actually
// reopens for days while words come in. The row is a summary; the sheet it opens
// is the only place anything changes, and it shows her real card while she edits,
// rendered by the same endpoint that draws the printed deck.
//
// This file covers the COLLECTION-PAGE sheet. The wizard's own pawn step keeps its
// own spec (pawn-photos.spec.js) — they share an API and nothing else.
//
// What these tests hold:
//   • the ROW reports what is actually there, and opens the sheet,
//   • she can SEE the photos (thumbs, full-size on tap) and the card preview,
//   • she can REMOVE a photo and ADD one, up to the four the card has room for,
//   • she can RETITLE the deck, including a two-line title, and the preview
//     redraws with it,
//   • a refused title (emoji) keeps her text and saves nothing,
//   • a CONTRIBUTOR sees no row, no sheet and no photos/title in the payload,
//   • once CLOSED the deck is in production: visible, frozen, and the API says no.

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
// A real 1x1 PNG as bytes, for the file picker. extFromMagic sniffs the header,
// so this is accepted exactly like a photo off a phone.
const PNG_BYTES = Buffer.from(PNG.split(',')[1], 'base64');

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// Run the wizard to a real collection and return { url, id, k }.
//
// The wizard is TITLE-ONLY now (#449/#451): no honoree-name box and no gender
// picker — the buyer writes one title and that is her whole identity step. This
// walks it the way the wizard's own spec does (deep-link to step 3, fill
// #customTitleInput, advance), then carries on through the pawn step to contact
// and submit.
async function createCollection(page, title = 'Shira') {
  // The create button is gated on the name step until the preview shows — stub
  // /api/preview so the gate opens without the Python render.
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      json: {
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      },
    })
  );
  await page.goto('/options.html?step=3');
  await expect(page.getByTestId('step-3')).toBeVisible();
  await page.fill('#customTitleInput', title);
  await page.getByTestId('next-btn').click(); // title -> optional pawn photos
  await expect(page.getByTestId('step-pawns')).toBeVisible();
  await page.getByTestId('next-btn').click(); // pawn photos -> contact
  await expect(page.getByTestId('step-4')).toBeVisible();
  await page.fill('#ownerEmail', 'test@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.getByTestId('next-btn').click(); // create
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
  const url = new URL(page.url());
  return { url: page.url(), id: url.searchParams.get('c'), k: url.searchParams.get('k') };
}

// Attach `n` photos the way the wizard does — through the upload route itself,
// so the test starts from a state a real order can actually be in.
async function attachPhotos(page, id, k, n) {
  const boundary = '----dugriE2EPawns';
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="pawn${i}"; filename="p${i}.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      // Distinct bytes per photo: the paths are content-addressed, so four copies
      // of the same file would de-dupe to ONE and the cap tests would be testing
      // nothing.
      Buffer.concat([PNG_BYTES, Buffer.from(`slot${i}`)]),
      Buffer.from('\r\n')
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const res = await page.request.post(`/api/collections/${id}/pawns?k=${encodeURIComponent(k)}`, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    data: Buffer.concat(chunks),
  });
  expect(res.status()).toBe(200);
  return (await res.json()).pawn_images;
}

test('the row reports the deck, and opens the sheet with photos and the card', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 2);
  await page.goto(url);

  // The row is a summary: it says what is inside without being opened.
  const row = page.getByTestId('game-row');
  await expect(row).toBeVisible();
  await expect(page.getByTestId('game-row-sub')).toContainText('2 תמונות');
  // The title itself, so a wrong one is visible without opening the sheet.
  await expect(page.getByTestId('game-row-sub')).toContainText('Shira');
  // …and nothing is editable until it is opened.
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(0);

  await row.click();
  await expect(page.getByTestId('game-sheet')).toBeVisible();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(2);
  // Her own card, from the same renderer the printed deck uses.
  await expect(page.getByTestId('game-preview')).toHaveAttribute('src', /^data:image\/png/);

  // "Watch them" — tapping a thumb opens the full-size view, and any tap closes it.
  await page.getByTestId('pawn-thumb').first().click();
  const view = page.getByTestId('pawn-view');
  await expect(view).toBeVisible();
  await view.click();
  await expect(view).toHaveCount(0);
});

test('she removes a photo and it stays removed', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 3);
  await page.goto(url);
  await page.getByTestId('game-row').click();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(3);

  // Removal is confirmed first — the photo leaves the order the moment the
  // server answers, and this page cannot re-take a picture from the party.
  await page.getByTestId('pawn-remove').first().click();
  await page.locator('#msgModalOk').click();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(2);

  // The server holds it, not just this tab.
  await page.reload();
  await expect(page.getByTestId('game-row-sub')).toContainText('2 תמונות');
  await page.getByTestId('game-row').click();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(2);
  const state = await page.request
    .get(`/api/collections/${id}?k=${encodeURIComponent(k)}`)
    .then((r) => r.json());
  expect(state.pawn_images).toHaveLength(2);
});

test('she adds a photo back, and the fourth fills the card', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 3);
  await page.goto(url);
  await page.getByTestId('game-row').click();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(3);

  const add = page.getByTestId('pawn-add');
  await expect(add).toBeEnabled();
  await page.getByTestId('pawn-add-input').setInputFiles({
    name: 'new.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([PNG_BYTES, Buffer.from('added-later')]),
  });
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(4);

  // Four is what the printed photo card holds. The slot stays on screen but
  // disabled, so the cap is visible rather than a control that vanished.
  await expect(add).toBeDisabled();
  await page.reload();
  await expect(page.getByTestId('game-row-sub')).toContainText('4 תמונות');
});

test('a contributor never sees her photos', async ({ page }) => {
  const { id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 2);

  // The link she forwards to the party carries no owner token.
  await page.goto(`/collect.html?c=${id}`);
  await expect(page.locator('#addCard')).toBeVisible();
  await expect(page.getByTestId('game-row')).toBeHidden();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(0);

  // …and the payload itself doesn't carry them, so there is nothing to find in
  // devtools either.
  const guest = await page.request.get(`/api/collections/${id}`).then((r) => r.json());
  expect('pawn_images' in guest).toBe(false);
});

test('once the collection is closed the photos are visible but frozen', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 2);
  // Closing is what starts production — from here the deck is being made, so the
  // photos it is made from can no longer move.
  // The close route takes the owner token in the BODY, not the query string.
  const closed = await page.request.post(`/api/collections/${id}/close`, {
    data: { owner_token: k },
  });
  expect(closed.status()).toBe(200);
  await page.goto(url);

  await expect(page.getByTestId('game-row-sub')).toContainText('לצפייה בלבד');
  await page.getByTestId('game-row').click();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(2);
  await expect(page.getByTestId('pawn-remove')).toHaveCount(0);
  await expect(page.getByTestId('pawn-add')).toHaveCount(0);
  await expect(page.getByTestId('title-input')).toBeDisabled();
  await expect(page.locator('#sheetClosedNote')).toBeVisible();

  // …and the API refuses too, so the freeze is a rule rather than a hidden button.
  const refused = await page.request.put(
    `/api/collections/${id}/title?k=${encodeURIComponent(k)}`,
    { data: { custom_title: 'אחרי הסגירה' } }
  );
  expect(refused.status()).toBe(409);
});

// THE TITLE. What she is approving is a picture, not a string — so the card above
// the field redraws with whatever she typed, from the same renderer that draws the
// printed deck.
test('she retitles the deck and the card redraws with the new title', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  // What the SHEET ASKS FOR is the thing under test: the render itself is stubbed
  // here (a real one spawns Chrome), so asserting the picture changed would only
  // be asserting the stub. Recording the bodies proves the card being drawn is
  // the card with her new title on it.
  const asked = [];
  await page.route('**/api/preview', (route) => {
    asked.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({
      json: {
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      },
    });
  });
  await page.goto(url);
  await page.getByTestId('game-row').click();

  const preview = page.getByTestId('game-preview');
  await expect(preview).toHaveAttribute('src', /^data:image\/png/);
  // Opening asks for the card as it stands — and never for the board, which is by
  // far the heaviest thing that endpoint draws.
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(asked[asked.length - 1].board).toBe(false);

  await page.getByTestId('title-input').fill('30 שנה לשירה שלנו');
  await page.getByTestId('title-save').click();

  // The row picks up the new title…
  await expect(page.getByTestId('game-row-sub')).toContainText('30 שנה לשירה שלנו');
  // …the server holds it…
  const state = await page.request
    .get(`/api/collections/${id}?k=${encodeURIComponent(k)}`)
    .then((r) => r.json());
  expect(state.custom_title).toBe('30 שנה לשירה שלנו');
  // …and the card being drawn is the one carrying her title.
  await expect
    .poll(() => asked[asked.length - 1].title, {
      message: 'the preview must be redrawn with the new title',
    })
    .toBe('30 שנה לשירה שלנו');
});

test('an emoji title is refused, and her text stays in the field to fix', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  await page.goto(url);
  await page.getByTestId('game-row').click();

  await page.getByTestId('title-input').fill('שירה בת 30 🎉');
  await page.getByTestId('title-save').click();

  // The server's own message, not a generic failure — it names the problem.
  const err = page.getByTestId('title-err');
  await expect(err).toBeVisible();
  await expect(err).toContainText('אימוג');
  // Her text is still there to correct, and nothing was stored.
  await expect(page.getByTestId('title-input')).toHaveValue('שירה בת 30 🎉');
  // Nothing was stored: the title is still the one the wizard wrote.
  const state = await page.request
    .get(`/api/collections/${id}?k=${encodeURIComponent(k)}`)
    .then((r) => r.json());
  expect(state.custom_title).toBe('Shira');
});

// A TWO-LINE TITLE MUST SURVIVE THIS SHEET.
//
// The break is real everywhere else: the generator splits the title on \n and
// prints each line as its own title line, the store's sanitizer deliberately
// keeps \n (it trims each line and rejoins), and the wizard collects it in a
// <textarea rows="2"> for exactly that reason.
//
// An <input type="text"> would run the HTML value sanitization algorithm, which
// STRIPS U+000A instead of converting it — so "החגיגה של\nשירה" both displays and
// saves as "החגיגה שלשירה", two words fused, with nothing said to the buyer. She
// need not even touch the field: opening the sheet and saving anything is enough.
test('a stored two-line title survives opening and saving the sheet', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  const seeded = 'החגיגה של\nשירה';
  const put = await page.request.put(`/api/collections/${id}/title?k=${encodeURIComponent(k)}`, {
    data: { custom_title: seeded },
  });
  expect(put.status()).toBe(200);
  expect((await put.json()).custom_title).toBe(seeded);

  await page.goto(url);
  await page.getByTestId('game-row').click();
  // The break is IN the box — not flattened on the way in.
  await expect(page.getByTestId('title-input')).toHaveValue(seeded);

  // Saving without touching the field must be a no-op, not a silent rewrite.
  await page.getByTestId('title-save').click();
  await expect(page.getByTestId('title-err')).toBeHidden();
  const state = await page.request
    .get(`/api/collections/${id}?k=${encodeURIComponent(k)}`)
    .then((r) => r.json());
  expect(state.custom_title).toBe(seeded);
});

test('she can type a two-line title, and the card is drawn with both lines', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  const asked = [];
  await page.route('**/api/preview', (route) => {
    asked.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({
      json: {
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      },
    });
  });
  await page.goto(url);
  await page.getByTestId('game-row').click();

  // Enter inserts a line, it does not submit.
  const box = page.getByTestId('title-input');
  await box.fill(''); // the wizard already wrote a title; start clean
  await box.click();
  await page.keyboard.type('החגיגה של');
  await page.keyboard.press('Enter');
  await page.keyboard.type('שירה');
  await expect(box).toHaveValue('החגיגה של\nשירה');

  await page.getByTestId('title-save').click();
  const state = await page.request
    .get(`/api/collections/${id}?k=${encodeURIComponent(k)}`)
    .then((r) => r.json());
  expect(state.custom_title).toBe('החגיגה של\nשירה');
  // …and the preview asked for the card with both lines, not the fused string.
  await expect.poll(() => asked[asked.length - 1].title).toBe('החגיגה של\nשירה');
});

// The same failure mode as the newline, from the other direction: this sheet caps
// typing at the wizard's 63, but the STORE allows 120 and the admin can use them.
// A longer title she never touched must come back out whole — the box may refuse
// new characters, it must not quietly shorten what is already there.
test('a title longer than the box allows is not truncated by saving it untouched', async ({
  page,
}) => {
  const { url, id, k } = await createCollection(page);
  const long = 'כותרת ארוכה שנקבעה מהאדמין '.repeat(3).trim(); // ~80 chars, over the box's 63
  await page.request.put(`/api/collections/${id}/title?k=${encodeURIComponent(k)}`, {
    data: { custom_title: long },
  });

  await page.goto(url);
  await page.getByTestId('game-row').click();
  await expect(page.getByTestId('title-input')).toHaveValue(long);
  await page.getByTestId('title-save').click();
  await expect(page.getByTestId('title-err')).toBeHidden();

  const state = await page.request
    .get(`/api/collections/${id}?k=${encodeURIComponent(k)}`)
    .then((r) => r.json());
  expect(state.custom_title).toBe(long);
});
