import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// HER DECK, ON THE PAGE SHE COMES BACK TO — FOUR TABS.
//
// The order wizard asks for the title and the photos on steps that exist exactly
// once: after "צרו את המשחק" there is no route back to them. So a photo picked by
// mistake, or a title she thought better of, meant writing to us.
//
// They are tabs on the collection page now — the page she actually reopens for
// days while words come in: מילים · העיצוב · חיילי המשחק · תשלום. One is showing
// at a time, the payment is BOTH its own tab and the sticky bar that never
// leaves, and the design tab shows her real card, rendered by the same endpoint
// that draws the printed deck.
//
// This file covers the COLLECTION-PAGE tabs. The wizard's own pawn step keeps its
// own spec (pawn-photos.spec.js) — they share an API and nothing else.
//
// What these tests hold:
//   • the tabs show ONE section at a time, and the pay bar survives all of them,
//   • she can SEE the photos (thumbs, full-size on tap) and the card preview,
//   • she can REMOVE a photo and ADD one, up to the four the card has room for,
//   • she can RETITLE the deck, including a two-line title, and the preview
//     redraws with it,
//   • a refused title (emoji) keeps her text and saves nothing,
//   • a CONTRIBUTOR sees no tabs and no photos/title in the payload,
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
  // The orderer's name is required on this step now ("make it must to write") —
  // without it the create button never enables. The rule itself is tested in
  // order-buyer-details.spec.js; here it is just part of getting to an order.
  await page.fill('#buyerNameInput', 'דנה כהן');
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

// The e2e server runs without PELECARD_* credentials, so the API reports
// `card_enabled: false` and every pay affordance is correctly hidden — including
// the sticky bar this file cares about. Flip that one field and leave the rest of
// the server's answer alone, exactly as collect.spec.js does.
async function withCardEnabled(page) {
  await page.route(/\/api\/collections\/[^/?]+(\?|$)/, async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    try {
      const j = JSON.parse(body);
      j.card_enabled = true;
      body = JSON.stringify(j);
    } catch {
      /* not json — hand it back untouched */
    }
    return route.fulfill({ response: res, body });
  });
}

// The e2e server has no card credentials, so `card_enabled` is false and `paid`
// is never set by a real money event. Both are flipped on the collection GET —
// the same trick collect.spec.js uses — because these tests are about what the
// page RENDERS in that state, not about how it got there.
async function enableCardButton(page) {
  const ctl = { paid: false };
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const body = await resp.json();
    body.card_enabled = true;
    if (ctl.paid) body.paid = true;
    return route.fulfill({ json: body });
  });
  return ctl;
}

test('the tabs open her photos and her card, one section at a time', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 2);
  await page.goto(url);

  // She lands on the WORDS, which is what she opens this page for — the rest is
  // one tap away and none of it is in the way.
  await expect(page.getByTestId('tabs')).toBeVisible();
  await expect(page.locator('#addCard')).toBeVisible();
  await expect(page.locator('#designPanel')).toBeHidden();
  await expect(page.locator('#pawnsPanel')).toBeHidden();

  await page.getByTestId('tab-pawns').click();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(2);
  await expect(page.getByTestId('pawn-thumb').first()).toBeVisible();
  // One section at a time: the words are gone while the photos are up.
  await expect(page.locator('#addCard')).toBeHidden();

  await page.getByTestId('tab-design').click();
  await expect(page.locator('#pawnsPanel')).toBeHidden();
  // Her own card, from the same renderer the printed deck uses.
  await expect(page.getByTestId('game-preview')).toHaveAttribute('src', /^data:image\/png/);

  // "Watch them" — tapping a thumb opens the full-size view, and any tap closes it.
  await page.getByTestId('tab-pawns').click();
  await page.getByTestId('pawn-thumb').first().click();
  const view = page.getByTestId('pawn-view');
  await expect(view).toBeVisible();
  await view.click();
  await expect(view).toHaveCount(0);
});

// THE PAYMENT IS EVERYWHERE. It is a tab of its own AND the sticky bar at the
// foot — "any payment is also a section and also in every section", as the owner
// put it. A price that only exists on one tab is a price she has to go looking
// for, on the one page where she is deciding whether to pay at all.
test('the pay bar stays on screen in every tab, and the pay tab holds the checkout', async ({
  page,
}) => {
  const { url } = await createCollection(page);
  await withCardEnabled(page);
  await page.goto(url);

  const bar = page.locator('#payBar');
  await expect(bar).toBeVisible();
  for (const tab of ['design', 'pawns', 'pay', 'words']) {
    await page.getByTestId('tab-' + tab).click();
    await expect(bar).toBeVisible();
  }

  await page.getByTestId('tab-pay').click();
  await expect(page.getByTestId('pay-top')).toBeVisible();
  await expect(page.locator('#payPanel')).toBeVisible();
  // …and the words are not underneath it.
  await expect(page.locator('#addCard')).toBeHidden();
});

// THE PHOTOS ARE SHOWN AS THE CARD THEY BECOME. The pawn card ships inside her
// deck — the front card's paper, the deck's own frame, her photos in its four
// slots — so what she has to judge is how they sit inside it. A strip of
// thumbnails answers a different question.
//
// The RENDER is the generator's (its own pytest); what this holds is that the
// page asks for it at the right moments: when the tab is first opened, and again
// after a photo changes — never on the 5s poll, which would be a browser run on
// the server every five seconds for a picture that did not move.
test('the photos tab shows the rendered card, and redraws it when a photo goes', async ({
  page,
}) => {
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 2);
  const asked = [];
  await page.route('**/pawn-card**', (route) => {
    asked.push(route.request().url());
    return route.fulfill({ json: { card: PNG } });
  });
  await page.goto(url);

  // Not on the words tab: the card costs a Chrome run on the server, and most
  // owners open this page to add words.
  await page.waitForTimeout(300);
  expect(asked).toHaveLength(0);

  await page.getByTestId('tab-pawns').click();
  await expect(page.getByTestId('pawn-card-preview')).toHaveAttribute('src', /^data:image\/png/);
  await expect.poll(() => asked.length).toBe(1);
  // …and it says how many discs it is about to cover. The generator fills the
  // REST with the shipped Dugri pawns, because that is what the printed card
  // does — an order with two photos prints two faces and two pawns. Asking for a
  // card with four bare discs and drawing two of them showed her two empty
  // circles under a caption promising this is exactly how it will be printed.
  expect(asked[0]).toContain('n=2');

  // Leaving and returning does not re-ask — the card cannot have changed.
  await page.getByTestId('tab-words').click();
  await page.getByTestId('tab-pawns').click();
  await page.waitForTimeout(300);
  expect(asked).toHaveLength(1);

  // Removing one does: the card is now a different card — one more pawn on it.
  await page.getByTestId('pawn-remove').first().click();
  await page.locator('#msgModalOk').click();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(1);
  await expect.poll(() => asked.length).toBe(2);
  expect(asked[1]).toContain('n=1');
});

test('she removes a photo and it stays removed', async ({ page }) => {
  const { url, id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 3);
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(3);

  // Removal is confirmed first — the photo leaves the order the moment the
  // server answers, and this page cannot re-take a picture from the party.
  await page.getByTestId('pawn-remove').first().click();
  await page.locator('#msgModalOk').click();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(2);

  // The server holds it, not just this tab.
  await page.reload();
  await page.getByTestId('tab-pawns').click();
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
  await page.getByTestId('tab-pawns').click();
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
  // …and the fourth is the server's, not this page's.
  await page.reload();
  await page.getByTestId('tab-pawns').click();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(4);
});

// A PHOTO THAT DOES NOT MAKE IT SAYS SO.
//
// The upload route is fail-soft on purpose — one bad photo must not lose the
// good ones — but it used to be fail-SILENT: it answered 200 with a shorter list
// than the buyer picked, and this page just re-rendered the shorter list. She saw
// her tap do nothing, with no error and no reason. (Reported from a phone: pick
// two photos in the Instagram in-app browser, come back, nothing there.)
//
// The route now reports what it skipped, and this is where that reaches her.
test('a photo the server would not keep is reported, not swallowed', async ({ page }) => {
  const { url } = await createCollection(page);
  await page.route('**/api/collections/*/pawns*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        pawn_images: [],
        pawn_cutouts: {},
        skipped: [{ name: 'pawn0', filename: 'IMG_0001.HEIC', reason: 'too_large' }],
      }),
    })
  );
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();
  await page.getByTestId('pawn-add-input').setInputFiles({
    name: 'huge.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([PNG_BYTES, Buffer.from('too-big-for-the-store')]),
  });

  const err = page.locator('#pawnErr');
  await expect(err).toBeVisible();
  await expect(err).toContainText('כבדה מדי');
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(0);
});

// …and the same when the answer says nothing at all about skips (an older server,
// or any other reason the list simply did not grow). "Your photo is not here" is
// still the truth, and silence was the one answer that was not.
test('an upload that adds nothing is never left looking like success', async ({ page }) => {
  const { url } = await createCollection(page);
  await page.route('**/api/collections/*/pawns*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pawn_images: [], pawn_cutouts: {} }),
    })
  );
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();
  await page.getByTestId('pawn-add-input').setInputFiles({
    name: 'nope.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([PNG_BYTES, Buffer.from('vanishes')]),
  });
  await expect(page.locator('#pawnErr')).toContainText('לא נקלטו');
});

// WHILE IT IS WORKING, IT SAYS SO. Adding a photo runs a cut on the device (the
// segmenter is ~18MB the first time and is allowed 15s per photo) and then an
// upload; renderPawns draws nothing at all while pawnBusy, so every second of
// that used to look exactly like a tap that did not register.
test('the photo strip says it is working while the upload is in flight', async ({ page }) => {
  const { url } = await createCollection(page);
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  await page.route('**/api/collections/*/pawns*', async (route) => {
    await held;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        pawn_images: ['/content-uploads/aaaaaaaaaaaaaaaa.png'],
        pawn_cutouts: {},
        skipped: [],
      }),
    });
  });
  await page.goto(url);
  await page.getByTestId('tab-pawns').click();
  await page.getByTestId('pawn-add-input').setInputFiles({
    name: 'slow.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([PNG_BYTES, Buffer.from('in-flight')]),
  });

  await expect(page.getByTestId('pawn-busy')).toBeVisible();
  release();
  // …and it goes away the moment the answer lands, leaving the photo behind.
  await expect(page.getByTestId('pawn-busy')).toBeHidden();
  await expect(page.getByTestId('pawn-thumb')).toHaveCount(1);
});

test('a contributor never sees her photos', async ({ page }) => {
  const { id, k } = await createCollection(page);
  await attachPhotos(page, id, k, 2);

  // The link she forwards to the party carries no owner token.
  await page.goto(`/collect.html?c=${id}`);
  await expect(page.locator('#addCard')).toBeVisible();
  // No tab strip at all: three of the four tabs are not hers, and offering them
  // would be three dead ends.
  await expect(page.getByTestId('tabs')).toBeHidden();
  await expect(page.locator('#designPanel')).toBeHidden();
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

  await page.getByTestId('tab-pawns').click();
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
  await page.getByTestId('tab-design').click();

  const preview = page.getByTestId('game-preview');
  await expect(preview).toHaveAttribute('src', /^data:image\/png/);
  // Opening asks for the card as it stands — and never for the board, which is by
  // far the heaviest thing that endpoint draws.
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(asked[asked.length - 1].board).toBe(false);

  await page.getByTestId('title-input').fill('30 שנה לשירה שלנו');
  await page.getByTestId('title-save').click();

  // The server holds it…
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
  await page.getByTestId('tab-design').click();

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
  await page.getByTestId('tab-design').click();
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

// THE HEADING AT THE TOP OF THE PAGE NAMES THE DECK TOO.
//
// `honoree_name` is the order's LABEL, seeded from the first line of the title
// at creation and never moved again — so a buyer who retitled her deck was left
// reading the OLD title in the heading of the very page she retitled it on.
test('the page heading follows the title she saves, not the one the order was created under', async ({
  page,
}) => {
  const { url } = await createCollection(page, 'שירה');
  await page.goto(url);
  // Before she touches anything: the title the order was created with.
  await expect(page.locator('#title')).toHaveText('אוספים מילים על שירה');

  await page.getByTestId('tab-design').click();
  await page.getByTestId('title-input').fill('החגיגה של שירה');
  await page.getByTestId('title-save').click();

  // Saving moves the heading NOW — not on whatever the 5s poll does next.
  await expect(page.locator('#title')).toHaveText('אוספים מילים על החגיגה של שירה');
  await expect(page).toHaveTitle('דוגרי · מילים על החגיגה של שירה');

  // Clearing it restores the theme's own title on the card, and the heading goes
  // back to the name the order is filed under rather than reading "מילים על ".
  await page.getByTestId('title-input').fill('');
  await page.getByTestId('title-save').click();
  await expect(page.locator('#title')).toHaveText('אוספים מילים על שירה');
});

test('a two-line title reads as one line in the heading — the break is a space, not a join', async ({
  page,
}) => {
  const { url, id, k } = await createCollection(page);
  // The generator prints each line of the title as its own line; a heading has
  // one. Dropping the break would fuse "החגיגה של" and "שירה" into one word.
  await page.request.put(`/api/collections/${id}/title?k=${encodeURIComponent(k)}`, {
    data: { custom_title: 'החגיגה של\nשירה' },
  });
  await page.goto(url);
  await expect(page.locator('#title')).toHaveText('אוספים מילים על החגיגה של שירה');
});

test('a contributor reads the honoree name in the heading, never the deck title', async ({
  page,
}) => {
  const { id, k } = await createCollection(page, 'שירה');
  await page.request.put(`/api/collections/${id}/title?k=${encodeURIComponent(k)}`, {
    data: { custom_title: 'מסיבת ההפתעה' },
  });
  // The link forwarded to the party carries no owner token, and `custom_title` is
  // owner-only in the payload — the friends arriving from the WhatsApp group keep
  // the one name of the two that means anything to them.
  await page.goto(`/collect.html?c=${id}`);
  await expect(page.locator('#title')).toHaveText('אוספים מילים על שירה');
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
  await page.getByTestId('tab-design').click();

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
  await page.getByTestId('tab-design').click();
  await expect(page.getByTestId('title-input')).toHaveValue(long);
  await page.getByTestId('title-save').click();
  await expect(page.getByTestId('title-err')).toBeHidden();

  const state = await page.request
    .get(`/api/collections/${id}?k=${encodeURIComponent(k)}`)
    .then((r) => r.json());
  expect(state.custom_title).toBe(long);
});

// SENDING TO PRINT IS ATTESTED, NOT ASSUMED. The sign-off tab lists the three
// things that stop being changeable — the title, the photos, the filler style —
// and the owner asked for something she has to TICK, so a deck can never go to
// the press with "I never looked at that" as the explanation. The dialog that
// follows asks "are you sure"; this asks "did you look", which is a different
// question and the only one that can still change the outcome.
test('the collection cannot be closed until she confirms she went over it', async ({ page }) => {
  const { url } = await createCollection(page);
  await page.goto(url);
  await page.getByTestId('tab-finish').click();

  const close = page.locator('#closeBtn');
  const ack = page.getByTestId('finish-ack');
  await expect(close).toBeVisible();
  await expect(close).toBeDisabled();
  await expect(ack).not.toBeChecked();

  await ack.check();
  await expect(close).toBeEnabled();

  // …and unticking puts it back, so this is a live gate rather than a one-way
  // door she can trip by accident.
  await ack.uncheck();
  await expect(close).toBeDisabled();

  // With the tick, the close still goes through the confirmation dialog — the
  // gate is in ADDITION to it, not instead of it.
  await ack.check();
  await close.click();
  await expect(page.getByTestId('close-ask')).toBeVisible();
  await page.getByTestId('close-ask-no').click();
  await expect(page.getByTestId('close-ask')).toBeHidden();
});

// The payment tab is the one thing on this page that stops being a question the
// moment it is answered. Leaving it up sends her back to a checkout that has
// nothing left to take.
test('the payment tab disappears once the order is paid', async ({ page }) => {
  const ctl = await enableCardButton(page);
  const { url, id, k } = await createCollection(page);
  await page.request.post(`/api/collections/${id}/order`, {
    data: { owner_token: k, version: 'pickup' },
  });
  await page.goto(url);
  await expect(page.getByTestId('tab-pay')).toBeVisible();

  ctl.paid = true;
  await page.reload();
  await expect(page.getByTestId('tab-pay')).toBeHidden();
  // …and the tabs that still mean something are all there.
  await expect(page.getByTestId('tab-words')).toBeVisible();
  await expect(page.getByTestId('tab-finish')).toBeVisible();
});
