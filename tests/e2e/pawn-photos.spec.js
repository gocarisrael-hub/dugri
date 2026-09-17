import { test, expect } from '@playwright/test';
import { ALL_OFF, stubFeatures } from './feature-flags.js';

// The OPTIONAL "upload up to 4 photos" step (stable data-step id 5) sits between
// the name step (3) and the details step (4). It is FREE and skippable — Next must
// work with zero images — and the selected files are only uploaded (to the
// owner-token-gated POST /api/collections/:id/pawns) AFTER the collection is
// created. All flags are stubbed OFF (the launch default): step 2 drops out and
// no name-preview gate applies, so the name step's Next enables on a valid name.

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_OFF);
});

// A tiny valid 1x1 PNG for a fake pawn selection (mimeType drives file.type).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// A TALL photo, 4 x 12, because the head anchor only decides anything when the
// photo is taller than it is wide: build.plain_crop centres a square of the short
// side on SUBJECT_Y of the height. PNG_BYTES above is 1x1, and on a square every
// anchor gives the same crop — a test using one cannot see the constant arrive at
// all. At 4x12 the module's own answers are "0 2 4 4" at the default 0.3 and
// "0 5 4 4" at 0.6.
const TALL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAMCAIAAADKwItEAAAAXklEQVR4nA3H0QAAIBBEwYMIIoiFCCKIhQgiiIV4EMF08zdVhQoXKaoGGniQ0Zlo4klmR0hYRJ2FFl5kdTbaeJPdMTI2ceeggw85nYsuvuR2goJD0gGBIXQeeviRxwdYCEsBYbuDdgAAAABJRU5ErkJggg==',
  'base64'
);

// Stub the create call so no real collection is written; returns {id, owner_token}
// the client needs to then upload the pawns.
async function stubCreate(page) {
  await page.route('**/api/collections', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'test-col', owner_token: 'test-tok' }),
    })
  );
}

// Stub + record the pawn-upload call, including the raw multipart body so the
// cutout parts that travel with each photo can be asserted.
function capturePawns(page) {
  const captured = { called: false, url: '', body: '' };
  page.route('**/api/collections/*/pawns*', (route) => {
    captured.called = true;
    captured.url = route.request().url();
    const buf = route.request().postDataBuffer();
    captured.body = buf ? buf.toString('latin1') : '';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pawn_images: ['/content-uploads/abc.png'] }),
    });
  });
  return captured;
}

// A 2x2 fully transparent-cornered PNG standing in for a real cutout.
const CUT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4AWNgYPjPAMEMDFAGDAMAI9EBAWDwPtsAAAAASUVORK5CYII=';

// Replace site/js/pawn-cutout.js with a stub that returns a known PNG (or null).
// The real module downloads ~18MB of self-hosted model + wasm and its OUTPUT
// depends on what the segmenter sees in the photo — neither belongs in a test of
// the WIRING. The real runtime is exercised by the "loads the real segmenter"
// test below and by tests/unit/pawn-cutout.test.js.
// `png` is the base64 cutout the stub hands back (default CUT_PNG, which has no
// measurable subject); `succeeds` is how many of the FIRST calls return null before the stub starts
// producing a cutout: false = never cuts, true = always cuts, 'after-1' = the
// first photo misses and the retry succeeds. The module is imported once and
// cached by the browser, so a re-pick has to be driven from inside the stub
// rather than by re-routing.
async function stubCutter(page, { succeeds, png }) {
  const misses = succeeds === true ? 0 : succeeds === 'after-1' ? 1 : Infinity;
  const body = `let n = 0;
     // The page also asks this module to re-encode a picked photo before upload
     // (shrinkForUpload). These tests hand the input a tiny PNG that is already
     // under every cap, so the honest stand-in is the identity — and exporting it
     // keeps the stub the same SHAPE as the module it replaces.
     export async function shrinkForUpload(file) {
       return file;
     }
     export async function cutPawnPhoto() {
       if (n++ < ${misses === Infinity ? 'Infinity' : misses}) return null;
       const bin = atob(${JSON.stringify(png || CUT_PNG)});
       const a = new Uint8Array(bin.length);
       for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
       return new Blob([a], { type: 'image/png' });
     }`;
  // pawn-cutout.js is dynamically imported and may be served content-hashed
  // (/js/pawn-cutout.<hash>.js via the import map — server/asset-hashing.js).
  await page.route(/\/js\/pawn-cutout(?:\.[0-9a-f]{8})?\.js(?:\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body })
  );
}

// Deep-link to the name step, enter a valid name + gender, advance to the pawn step.
async function toPawnStep(page) {
  await page.goto('/options.html?step=3');
  await expect(page.getByTestId('step-3')).toBeVisible();
  await page.fill('#customTitleInput', 'Shira');
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-pawns')).toBeVisible();
}

// THE COUNT LIVES BEHIND A BUTTON NOW — four players is the standard deck, so the
// 4/8/12/16 choice is revealed rather than shown, and a test that wants a
// different deck has to open it the way a buyer does.
//
// Idempotent on purpose: several tests below press three or four counts in a row,
// and a blind click would shut the panel again halfway through the loop.
async function openPawnCount(page) {
  const toggle = page.getByTestId('pawn-count-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId('pawn-count-panel')).toBeVisible();
}

test.describe('optional pawn-photos step', () => {
  test('sits between the name and details steps and is skippable with 0 images', async ({
    page,
  }) => {
    await toPawnStep(page);
    // Its copy + 4 empty slots show, and Next is enabled with nothing selected.
    await expect(page.getByTestId('step-pawns')).toContainText('חיילים');
    await expect(page.getByTestId('pawn-grid')).toBeVisible();
    await expect(page.getByTestId('next-btn')).toBeEnabled();

    // Next (0 images) advances to the details step.
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();

    // Back returns to the pawn step, then to the name step.
    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('step-3')).toBeVisible();
  });

  test('the דלגו skip button advances to the details step', async ({ page }) => {
    await toPawnStep(page);
    await page.getByTestId('pawn-skip').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
  });

  // A CARD THAT COMES BACK WITHOUT ITS DISCS IS NOT A REASON TO LOSE THE STEP.
  // `filter` and `fallbacks` have always degraded to a default, but `slots` and
  // `viewBox` were read straight through — and slotRect destructures the viewBox,
  // so a partial answer threw inside the render and took the whole photo step
  // with it. It falls back to the plain tile this page already draws before the
  // card arrives, which is the same answer as "the card has not come yet".
  test('a card that comes back without its slots still leaves her a usable step', async ({
    page,
  }) => {
    await stubCutter(page, { succeeds: false });
    await page.route('**/api/pawn-base**', (route) =>
      route.fulfill({ json: { card: 'data:image/png;base64,' + PNG_BYTES.toString('base64') } })
    );
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await toPawnStep(page);

    await expect(page.getByTestId('pawn-grid')).toBeVisible();
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });
    // The photo is still drawn, and the step still advances.
    await expect(page.locator('.pawn-slot[data-idx="0"]')).toHaveClass(/is-filled/);
    await expect(page.locator('.pawn-slot[data-idx="0"] .pawn-tile image')).toHaveCount(1);
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    expect(errors, 'a partial card must not throw').toEqual([]);
  });

  // THE SLOTS ARE THE PRINTED CARD'S. The step asks the generator for its card
  // once — every disc bare, for the design alone — and paints into each empty slot
  // the Dugri pawn the deck deals there, across the WHOLE deck: with eight players
  // and two photos the first card's empty slots take pawns 1 and 2, and the second
  // card starts at pawn 3, as build.card_photo_plan prints it.
  test('empty slots show the pawns the deck deals there, from one card asked for once', async ({
    page,
  }) => {
    await stubCutter(page, { succeeds: false });
    const pawnSvg = (fill) =>
      'data:image/svg+xml;base64,' +
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`
      ).toString('base64');
    const fallbacks = ['#a00', '#0a0', '#00a', '#aa0'].map(pawnSvg);
    const asked = [];
    await page.route('**/api/pawn-base**', (route) => {
      asked.push(new URL(route.request().url()).search);
      return route.fulfill({
        json: {
          card: 'data:image/png;base64,' + PNG_BYTES.toString('base64'),
          slots: [
            { n: 1, x: 0.178, y: 0.279, w: 0.295, h: 0.212 },
            { n: 2, x: 0.527, y: 0.279, w: 0.295, h: 0.212 },
            { n: 3, x: 0.178, y: 0.529, w: 0.295, h: 0.212 },
            { n: 4, x: 0.527, y: 0.529, w: 0.295, h: 0.212 },
          ],
          viewBox: [0, 0, 223.92, 312],
          filter: '',
          fallbacks,
        },
      });
    });
    await toPawnStep(page);
    await openPawnCount(page);
    await page.getByTestId('pawn-count-8').click();
    for (const i of [0, 1]) {
      await page
        .getByTestId('pawn-input-' + i)
        .setInputFiles({ name: `p${i}.png`, mimeType: 'image/png', buffer: PNG_BYTES });
    }
    const pawnIn = (idx) => page.locator(`.pawn-slot[data-idx="${idx}"] image[data-pawn-fallback]`);
    // Card one: her two photos, then pawns 1 and 2.
    await expect(pawnIn(2)).toHaveAttribute('href', fallbacks[0]);
    await expect(pawnIn(3)).toHaveAttribute('href', fallbacks[1]);
    await expect(pawnIn(0)).toHaveCount(0);
    // Card two carries on from pawn 3 — it does not start the set again.
    await expect(pawnIn(4)).toHaveAttribute('href', fallbacks[2]);
    await expect(pawnIn(5)).toHaveAttribute('href', fallbacks[3]);
    await expect(pawnIn(6)).toHaveAttribute('href', fallbacks[0]);

    // One card, for the design alone — not one per count, photo or card.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^\?theme=[^&]+$/);
  });

  // A PHOTO PICKED BEFORE THE CARD ARRIVES IS STILL FRAMED THE CARD'S WAY.
  //
  // The card is asked for on a debounce and then rendered by Chrome on the server,
  // so there is a real window — the first seconds of this step — in which a buyer
  // can choose a photo and the page does not yet know the generator's constants.
  // It prepared that photo with this module's defaults, which was all it had; what
  // was missing is that nothing asked again once the card landed. renderPawnSlot
  // repaints and the only other re-prepare is gated on an EMPTY slot, so the
  // default framing survived for the life of the page — on the step that exists to
  // show her what prints. Asserting the default here would have proved nothing
  // (0.9 is the default), so the card is stubbed with a fill it could not invent.
  test('a photo picked before the card lands is re-framed when it arrives', async ({ page }) => {
    await stubCutter(page, { succeeds: false });
    let releaseCard = () => {};
    const cardHeld = new Promise((resolve) => {
      releaseCard = resolve;
    });
    await page.route('**/api/pawn-base**', async (route) => {
      await cardHeld; // the buyer gets there first, as she can
      await route.fulfill({
        json: {
          card: 'data:image/png;base64,' + PNG_BYTES.toString('base64'),
          slots: [
            { n: 1, x: 0.178, y: 0.279, w: 0.295, h: 0.212 },
            { n: 2, x: 0.527, y: 0.279, w: 0.295, h: 0.212 },
            { n: 3, x: 0.178, y: 0.529, w: 0.295, h: 0.212 },
            { n: 4, x: 0.527, y: 0.529, w: 0.295, h: 0.212 },
          ],
          viewBox: [0, 0, 223.92, 312],
          filter: '',
          fallbacks: [],
          // BOTH tuned away from this module's defaults, or the test cannot tell
          // a page that re-framed from one that never asked again: at subject_y
          // 0.3 the re-prepared crop is the same crop, and the assertion below
          // would be measuring the default it was handed in the first place.
          disc_fill: 0.6,
          subject_y: 0.6,
        },
      });
    });

    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'tall.png', mimeType: 'image/png', buffer: TALL_PNG });
    // Drawn before the card exists, framed by this module's own head anchor:
    // build.plain_crop on a 4x12 photo at SUBJECT_Y 0.3. This is the window the
    // bug lived in, and the value it used to keep.
    const crop = slot0.locator('.pawn-tile svg[data-pawn-crop]');
    await expect(crop).toHaveAttribute('viewBox', '0 2 4 4');

    releaseCard();

    // …and once the card is here, the photo is framed by the CARD's anchor.
    //
    // The crop, not the disc: the circle is recomputed on every repaint, so it
    // followed the card whether or not the photo was ever re-prepared — measuring
    // it passed on the broken page and proved nothing. The crop is computed once,
    // when the photo is prepared, which is exactly what was never asked again.
    await expect(crop).toHaveAttribute('viewBox', '0 5 4 4', { timeout: 5000 });
  });

  test('selecting a file shows a small preview; removing it clears the slot', async ({ page }) => {
    await stubCutter(page, { succeeds: false });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await expect(slot0).not.toHaveClass(/is-filled/);

    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(slot0).toHaveClass(/is-filled/);
    // The photo is drawn as its pawn: an image inside the slot's tile.
    await expect(slot0.locator('.pawn-tile svg[data-pawn-crop] image')).toHaveCount(1);
    await expect(page.getByTestId('pawn-remove-0')).toBeVisible();

    // Removing clears the preview and the filled state.
    await page.getByTestId('pawn-remove-0').click();
    await expect(slot0).not.toHaveClass(/is-filled/);
    await expect(slot0.locator('.pawn-tile svg[data-pawn-crop]')).toHaveCount(0);
  });

  test('a rejected file (unsupported type) shows a clear inline message', async ({ page }) => {
    await stubCutter(page, { succeeds: false });
    await toPawnStep(page);
    const err = page.getByTestId('pawn-err');
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await expect(err).toBeHidden();

    // A non-image file is rejected with a message (not silently dropped).
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('nope') });
    await expect(err).toBeVisible();
    await expect(err).toContainText('נתמך');
    await expect(slot0).not.toHaveClass(/is-filled/);

    // A valid pick clears the message and fills the slot.
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(err).toBeHidden();
    await expect(slot0).toHaveClass(/is-filled/);
  });

  test('a selected photo is uploaded after the collection is created, then redirects', async ({
    page,
  }) => {
    const pawns = capturePawns(page);
    await stubCreate(page);
    await stubCutter(page, { succeeds: false });

    await toPawnStep(page);
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(page.locator('.pawn-slot[data-idx="0"]')).toHaveClass(/is-filled/);

    await page.getByTestId('next-btn').click(); // -> details
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'a@b.com');
    await page.fill('#ownerPhone', '0521234567');
    // The orderer's name is required on this step now ("make it must to write") —
    // without it the create button never enables. The rule itself is tested in
    // order-buyer-details.spec.js; here it is just part of getting to an order.
    await page.fill('#buyerNameInput', 'דנה כהן');
    await page.getByTestId('next-btn').click(); // create + upload + redirect

    await page.waitForURL(/collect\.html\?c=test-col&k=test-tok/);
    // The pawn upload fired against the owner-token-gated route.
    expect(pawns.called).toBe(true);
    expect(pawns.url).toContain('/api/collections/test-col/pawns');
    expect(pawns.url).toContain('k=test-tok');
  });

  test('skipping (no photos) completes the order WITHOUT calling the pawns route', async ({
    page,
  }) => {
    const pawns = capturePawns(page);
    await stubCreate(page);

    await toPawnStep(page);
    await page.getByTestId('next-btn').click(); // skip -> details
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'a@b.com');
    await page.fill('#ownerPhone', '0521234567');
    await page.fill('#buyerNameInput', 'דנה כהן'); // required, as above
    await page.getByTestId('next-btn').click(); // create + redirect

    await page.waitForURL(/collect\.html\?c=test-col&k=test-tok/);
    expect(pawns.called).toBe(false);
  });
});

// The photo card traces each sticker's white outline from the image's OWN alpha
// (docs/photo-card.md), so a photo that reaches the deck opaque prints as a white
// RECTANGLE. The cut happens here, on the buyer's device, and these cover the two
// outcomes that matter: the buyer sees the sticker before paying, and a cut we
// could not make degrades to the original with the miss recorded — never an error.
test.describe('pawn photos: the background cut', () => {
  test('shows the buyer the CUT sticker and sends it with the photo', async ({ page }) => {
    const pawns = capturePawns(page);
    await stubCreate(page);
    await stubCutter(page, { succeeds: true });

    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });

    // The slot switches to the cutout, drawn as the pawn it prints as.
    await expect(slot0).toHaveClass(/is-cut/);
    await expect(slot0).toHaveClass(/is-pawn/);
    await expect(slot0.locator('.pawn-tile svg[data-pawn-crop] image')).toHaveAttribute(
      'href',
      /^blob:/
    );

    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'a@b.com');
    await page.fill('#ownerPhone', '0521234567');
    await page.fill('#buyerNameInput', 'דנה כהן'); // required, as above
    await page.getByTestId('next-btn').click();
    await page.waitForURL(/collect\.html\?c=test-col&k=test-tok/);

    // The original AND its cutout travel together, paired by part name.
    expect(pawns.body).toContain('name="pawn0"');
    expect(pawns.body).toContain('name="cut:pawn0"');
    expect(pawns.body).not.toContain('name="cutfail"');
  });

  // A 4x4 cutout with a 2x2 opaque centre: small enough that the framing maths
  // can be checked exactly, shaped enough to have a subject at all (the 2x2
  // CUT_PNG above is all corner and nothing else, so there is nothing to frame).
  const FRAMEABLE_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGElEQVR4nGNgwAbuTJv2H4RBbCasKpABAAGBBhFm0xs/AAAAAElFTkSuQmCC';

  test('a cut sticker is shown as the PAWN — in the circle, framed like the print', async ({
    page,
  }) => {
    await stubCutter(page, { succeeds: true, png: FRAMEABLE_PNG });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });

    // Drawn as the pawn, through the photo card's own sticker markup…
    await expect(slot0).toHaveClass(/is-pawn/);
    await expect(slot0.locator('.pawn-tile use[filter]')).toHaveCount(1);
    // …and the "background removed" band is gone: the sticker says it, and the
    // band would sit across the bottom of the circle it is describing.
    await expect(page.getByTestId('pawn-status-0')).toBeHidden();

    // The FRAMING is the promise this preview makes, so it is asserted as the
    // generator's own crop window rather than as "something was set". For a 4x4
    // image whose subject is the middle 2x2, build.subject_reach clamps at the
    // box's corner (hypot(2,2)/2 = 1.4142); the disc is 0.9 of the square, so the
    // window is 2 * 1.4142 / 0.9 = 3.14 px wide about the centre — left 0.43,
    // right 3.57, which Python rounds to 0 and 4. Run build.subject_window on the
    // same alpha if this ever moves.
    await expect(slot0.locator('svg[data-pawn-crop]')).toHaveAttribute('viewBox', '0 0 4 4');
  });

  // A MOVE MUST NOT COST A PHOTO ITS PAWN. Closing the grid up moves each photo's
  // drawing with it — and one still being prepared is started again where it
  // lands — so the photo that moves up is drawn exactly as it was.
  test('a photo that moves up keeps its pawn, framed as it was', async ({ page }) => {
    await stubCutter(page, { succeeds: true, png: FRAMEABLE_PNG });
    await toPawnStep(page);
    for (const i of [0, 1]) {
      await page
        .getByTestId('pawn-input-' + i)
        .setInputFiles({ name: `p${i}.png`, mimeType: 'image/png', buffer: PNG_BYTES });
    }
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    const slot1 = page.locator('.pawn-slot[data-idx="1"]');
    await expect(slot1.locator('svg[data-pawn-crop]')).toHaveAttribute('viewBox', '0 0 4 4');

    // Dropping the first photo moves the second into slot 0.
    await slot0.locator('.pawn-remove').click();
    await expect(slot1).not.toHaveClass(/is-filled/);
    await expect(slot0).toHaveClass(/is-pawn/);
    await expect(slot0.locator('svg[data-pawn-crop]')).toHaveAttribute('viewBox', '0 0 4 4');
  });

  test('a cut with no subject in it is drawn on the plain square, as it prints', async ({
    page,
  }) => {
    // The transparent 2x2 has nothing to frame by. The printer does not refuse it:
    // it cuts the plain square and clips it round (build.plain_crop) — so the pawn
    // shows exactly that, rather than a thumbnail the card never prints.
    await stubCutter(page, { succeeds: true });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });

    await expect(slot0).toHaveClass(/is-cut/);
    await expect(slot0).toHaveClass(/is-pawn/);
    await expect(slot0.locator('svg[data-pawn-crop]')).toHaveAttribute('viewBox', '0 0 2 2');
  });

  test('a cut we cannot make keeps the ORIGINAL and records the miss', async ({ page }) => {
    const pawns = capturePawns(page);
    await stubCreate(page);
    await stubCutter(page, { succeeds: false });

    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });

    // The photo is still accepted — it is only the CUT that failed — and the step
    // stays usable (no error box, Next enabled).
    await expect(slot0).toHaveClass(/is-filled/);
    await expect(slot0).not.toHaveClass(/is-cut/);
    await expect(page.getByTestId('pawn-status-0')).toHaveText(
      'לא הוסר הרקע, עדיף תמונות פנים של בן אדם'
    );
    await expect(page.getByTestId('pawn-err')).toBeHidden();
    await expect(page.getByTestId('next-btn')).toBeEnabled();

    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'a@b.com');
    await page.fill('#ownerPhone', '0521234567');
    await page.fill('#buyerNameInput', 'דנה כהן'); // required, as above
    await page.getByTestId('next-btn').click();
    await page.waitForURL(/collect\.html\?c=test-col&k=test-tok/);

    // No cutout part, and the miss is named so the server records it and the
    // owner's orders table can flag it for a manual cut.
    expect(pawns.body).toContain('name="pawn0"');
    expect(pawns.body).not.toContain('name="cut:pawn0"');
    expect(pawns.body).toMatch(/name="cutfail"\r\n\r\npawn0/);
  });

  // A PHOTO THE PAGE CANNOT PREPARE IS STILL DRAWN. Preparing one is a decode, a
  // measurement and sometimes a re-encode; when that misses, the slot used to show
  // nothing at all — indistinguishable from a slot she never filled — while the
  // upload carried the photo and the deck printed it. The file itself is drawn
  // instead, on the plain square, which is the fork the generator takes too.
  test('a photo the page cannot prepare is still drawn, never an empty slot', async ({ page }) => {
    await stubCutter(page, { succeeds: true, png: FRAMEABLE_PNG });
    // MEASURING the photo fails — which is the step that actually has to fail for
    // this to be a test. Stubbing the canvas ENCODE looked right and proved
    // nothing: a cut with no bystander to erase never reaches the encoder at all
    // (decode returns the file's own URL), so the stub sat there unused and the
    // test passed on the happy path. It would have passed if the slot drew an
    // empty disc, which is the one outcome it exists to forbid.
    await page.addInitScript(() => {
      const realContext = window.HTMLCanvasElement.prototype.getContext;
      window.HTMLCanvasElement.prototype.getContext = function (...args) {
        const ctx = realContext.apply(this, args);
        if (ctx && ctx.getImageData) {
          ctx.getImageData = () => {
            throw new Error('measuring refused');
          };
        }
        return ctx;
      };
    });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });

    await expect(slot0).toHaveClass(/is-filled/);
    await expect(slot0.locator('.pawn-tile svg[data-pawn-crop] image')).toHaveCount(1);
  });

  test('re-picking a slot replaces the photo AND its cut', async ({ page }) => {
    // A bad cut is the one defect that survives to 104 printed cards, so the buyer
    // has to be able to retry the slot. The file input covers the whole slot, so
    // tapping a filled slot re-opens the picker.
    await stubCutter(page, { succeeds: 'after-1' });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(page.getByTestId('pawn-status-0')).toHaveText(
      'לא הוסר הרקע, עדיף תמונות פנים של בן אדם'
    );

    // Second pick, this time the cut succeeds: the slot must follow the NEW
    // photo's result rather than keeping the old one.
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(slot0).toHaveClass(/is-cut/);
    // …drawn as the pawn it now prints as — the sticker says the background is
    // gone, so the band that used to say it is not shown.
    await expect(slot0).toHaveClass(/is-pawn/);
    await expect(page.getByTestId('pawn-status-0')).toBeHidden();
  });

  test('the real segmenter loads from OUR origin — no CDN, no third-party call', async ({
    page,
  }) => {
    // No stub here: this is the one test that runs the shipped runtime. It proves
    // the vendored files are reachable and that loading them talks to nobody else.
    const vendor = [];
    const foreign = [];
    page.on('response', (r) => {
      const url = new URL(r.url());
      if (url.pathname.startsWith('/vendor/')) vendor.push([url.pathname, r.status()]);
      if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') foreign.push(url.href);
    });

    await toPawnStep(page);
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });

    // A 1x1 PNG has no person in it, so the cut legitimately misses — the point is
    // that it RAN: the wasm and the model were fetched, from us, and answered 200.
    await expect(page.getByTestId('pawn-status-0')).toHaveText(
      'לא הוסר הרקע, עדיף תמונות פנים של בן אדם',
      {
        timeout: 25000,
      }
    );
    const paths = vendor.map(([p]) => p);
    expect(paths).toContain('/vendor/mediapipe/vision_bundle.mjs');
    expect(paths).toContain('/vendor/mediapipe/vision_wasm_internal.wasm');
    expect(paths).toContain('/vendor/mediapipe/selfie_multiclass_256x256.tflite');
    expect(vendor.filter(([, s]) => s !== 200)).toEqual([]);
    expect(foreign).toEqual([]);
  });
});

test.describe('pawn photos: the helper copy', () => {
  // The step's two lines of helper copy — what the photos become, and that tapping
  // a photo replaces it — are the whole explanation of a feature the buyer meets
  // once. They used to render at 13.5px (the shared .wiz-sub, shrunk again by the
  // phone media queries) and 13px, the smallest text on the screen, and the owner
  // could not read them on her phone. 16px is the floor; anything that pushes them
  // back under it — a new .wiz-sub media override, a "tidy up" of this step's
  // style block — is the regression this pins. The smallest common phone width
  // (375px) is used because that is where the copy wraps most and the step is
  // tightest against the fixed Back/Next bar.
  test('the helper copy is readable on a phone and the step still fits', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await toPawnStep(page);
    await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));

    const copy = {
      sub: '[data-step="5"] .wiz-sub',
      hint: '[data-testid="pawn-hint"]',
      // The same floor covers the two lines added later — what arrives (the cut
      // line) and the tip — for the same reason: they are read once, on a phone.
      cut: '[data-testid="pawn-cut"]',
      tip: '[data-testid="pawn-tip"] p',
    };
    for (const [what, sel] of Object.entries(copy)) {
      const { size, lead } = await page
        .locator(sel)
        .first()
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          return { size: parseFloat(cs.fontSize), lead: parseFloat(cs.lineHeight) };
        });
      expect(size, `${what} font-size`).toBeGreaterThanOrEqual(16);
      // Bigger type on its old cramped leading reads no better, so hold the ratio.
      expect(lead / size, `${what} line-height ratio`).toBeGreaterThanOrEqual(1.4);
    }

    // Growing the copy must not push the step's last control behind the fixed bar.
    //
    // The page IS allowed to scroll here now — the slots became previews of the
    // printed pawn and the owner chose the size over the one-screen rule; see the
    // step-5 tests in wizard-noscroll.spec.js for that decision. What must not
    // change is that the buyer can still reach the control, so scroll the way she
    // would and then hold the same bar assertion.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const bar = document.querySelector('.wiz-bar').getBoundingClientRect();
          const skip = document.querySelector('[data-testid="pawn-skip"]').getBoundingClientRect();
          return Math.round(skip.bottom - bar.top);
        })
      )
      .toBeLessThanOrEqual(0);
  });

  // What the buyer RECEIVES, and the one job it leaves her. The step described how
  // the photos are cut but never what arrives: the pawns come printed and SHE cuts
  // them into circles. It is the one instruction on this step, so it is the one
  // line that is not muted grey.
  //
  // HOW MANY cards is deliberately NOT here: this node is the owner's to reword
  // ([data-edit]), and a count JS rewrote into it on every button press threw her
  // wording away. The number lives in the budget line, which JS owns.
  test('the step says the pawns arrive printed and the BUYER cuts the circles — in bold', async ({
    page,
  }) => {
    await toPawnStep(page);
    const cut = page.getByTestId('pawn-cut');
    await expect(cut).toBeVisible();
    // Addressed to her, in the second person — not "arrive already cut", which is
    // what an earlier draft said and nobody does.
    await expect(cut).toContainText('גוזרים');
    await expect(cut).toContainText('בעיגול');

    const { weight, colour, hintColour } = await cut.evaluate((el) => ({
      weight: getComputedStyle(el).fontWeight,
      colour: getComputedStyle(el).color,
      hintColour: getComputedStyle(document.querySelector('[data-testid="pawn-hint"]')).color,
    }));
    expect(Number(weight), 'the cut line must be bold').toBeGreaterThanOrEqual(600);
    // …and set in ink, not the muted grey the surrounding helper copy uses.
    expect(colour).not.toBe(hintColour);
  });

  // The buyer judges the cut from an on-device preview, which is the weakest link
  // in the chain — so the step has to say where the real background removal is
  // made, and what to do when the preview looks wrong. Both are one-line answers
  // to the two things she would otherwise message about.
  test('the tip names the print shop and the black-background fix', async ({ page }) => {
    await toPawnStep(page);
    const tip = page.getByTestId('pawn-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('בבית הדפוס');
    await expect(tip).toContainText('ChatGPT');
    await expect(tip).toContainText('רקע');
    await expect(tip).toContainText('שחור');

    // …and it must NOT promise that the print shop does the cutting. It doesn't —
    // the buyer does, and an earlier draft of this tip said otherwise. The claim
    // lives in one place (the bold line above the grid) and nowhere else.
    await expect(tip).not.toContainText('גזירה');
    await expect(tip).not.toContainText('גוזר');

    // It sits BELOW the grid: the advice is about a cut she has already looked at.
    // So does the cut line now — above the grid it alone pushed the photo slots
    // off a 375x667 phone once the player-count row arrived
    // (tests/e2e/wizard-noscroll.spec.js), and it reads no worse here.
    const order = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="pawn-grid"]').getBoundingClientRect();
      const t = document.querySelector('[data-testid="pawn-tip"]').getBoundingClientRect();
      const cut = document.querySelector('[data-testid="pawn-cut"]').getBoundingClientRect();
      return { tipBelowGrid: t.top >= grid.bottom, cutBelowGrid: cut.top >= grid.bottom };
    });
    expect(order).toEqual({ tipBelowGrid: true, cutBelowGrid: true });
  });

  // Every word on this step is the owner's to change without a deploy — the copy
  // she is most likely to reword is exactly this kind (a promise + a workaround).
  // Bold and the box are CSS, so an override can never strip them.
  test('both new lines are owner-editable, and an override keeps the styling', async ({ page }) => {
    await toPawnStep(page);
    for (const [testid, key] of [
      ['pawn-cut', 'options-photos-cut'],
      ['pawn-tip', 'options-photos-tip-shop'],
    ]) {
      const node =
        testid === 'pawn-cut'
          ? page.getByTestId(testid)
          : page.locator(`[data-testid="${testid}"] [data-edit="${key}"]`);
      await expect(node).toHaveAttribute('data-edit', key);
    }

    // Simulate what the editor does on load: replace textContent.
    const styled = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="pawn-cut"]');
      el.textContent = 'נוסח חדש של הבעלים';
      const cs = getComputedStyle(el);
      return { weight: Number(cs.fontWeight), text: el.textContent };
    });
    expect(styled.weight).toBeGreaterThanOrEqual(600);
    expect(styled.text).toBe('נוסח חדש של הבעלים');
  });
});

// HOW MANY PLAYERS — the control that trades word cards for pawn cards.
//
// The deck is always 104 cards. Four players fill one pawn card, and each pawn
// card costs a word card, which is four words. These drive the real control in a
// real browser; tests/unit/pawn-count.test.js holds its arithmetic against the
// server's.
test.describe('pawn photos: how many players', () => {
  const VISIBLE = '.pawn-slot:not([hidden])';

  test('opens on the standard deck — four players, four slots, 412 words', async ({ page }) => {
    await toPawnStep(page);
    await expect(page.getByTestId('pawn-count-4')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(VISIBLE)).toHaveCount(4);
    await expect(page.getByTestId('pawn-budget')).toContainText('עד 412 מילים');
  });

  test('every four players is one more pawn card, four words fewer', async ({ page }) => {
    await toPawnStep(page);
    for (const [players, cards, words] of [
      [8, 2, 408],
      [12, 3, 404],
      [16, 4, 400],
      [4, 1, 412],
    ]) {
      await openPawnCount(page);
      await page.getByTestId('pawn-count-' + players).click();
      await expect(page.locator(VISIBLE)).toHaveCount(players);
      const budget = page.getByTestId('pawn-budget');
      // How many photos she may send, how many cards she will be cutting, and
      // what it leaves for words — all three in the line JS owns, so none of them
      // can land in a node the content editor also writes.
      await expect(budget).toContainText('עד ' + players + ' תמונות');
      await expect(budget).toContainText(cards + (cards === 1 ? ' קלף חיילים' : ' קלפי חיילים'));
      await expect(budget).toContainText('עד ' + words + ' מילים');
    }
  });

  // THE OWNER'S WORDING IS NOT COLLATERAL. Both of this step's editable lines used
  // to be rewritten by renderPawnCount — on load AND on every count button press —
  // while js/editor.js applies her override once, on load. So the admin showed them
  // as editable, the edit saved, and the first tap of a count button replaced it
  // with the shipped default. Neither node is written by JS any more; this is what
  // holds that.
  test('a count button never overwrites the owner-edited copy', async ({ page }) => {
    await toPawnStep(page);
    const OWN = { title: 'הכותרת של הבעלים', cut: 'הנוסח של הבעלים' };
    // Exactly what the content editor does when the overrides land.
    await page.evaluate((own) => {
      document.querySelector('[data-edit="options-photos-title"]').textContent = own.title;
      document.querySelector('[data-testid="pawn-cut"]').textContent = own.cut;
    }, OWN);

    await openPawnCount(page);
    for (const n of [12, 16, 4, 8]) await page.getByTestId('pawn-count-' + n).click();

    await expect(page.locator('[data-edit="options-photos-title"]')).toHaveText(OWN.title);
    await expect(page.getByTestId('pawn-cut')).toHaveText(OWN.cut);
    // …and the count still changed, so this is not passing on a dead control.
    await expect(page.locator(VISIBLE)).toHaveCount(8);
    await expect(page.getByTestId('pawn-budget')).toContainText('עד 408 מילים');
  });

  // NOTHING IS STRANDED IN A SLOT SHE CANNOT SEE. The photos are uploaded as the
  // first N slots, so a photo left behind a hidden slot is a photo that leaves with
  // the order unmentioned: fill slots 5-8 of an eight-player deck, drop back to
  // four, and four finished cutouts went nowhere with nothing said. They move to
  // the front instead.
  test('a photo survives a trip down and back up, and moves to the front', async ({ page }) => {
    await stubCutter(page, { succeeds: false });
    await toPawnStep(page);
    await openPawnCount(page);
    await page.getByTestId('pawn-count-8').click();
    await page
      .getByTestId('pawn-input-5')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });
    // It lands at the front of the grid, not in the slot she happened to tap —
    // otherwise the deck's "first four photos are card one" is a lie about a grid
    // full of holes.
    await expect(page.locator('.pawn-slot[data-idx="0"]')).toHaveClass(/is-filled/);
    await expect(page.locator('.pawn-slot[data-idx="5"]')).not.toHaveClass(/is-filled/);

    // …so dropping to four keeps it, on screen and inside the deck.
    await openPawnCount(page);
    await page.getByTestId('pawn-count-4').click();
    await expect(page.locator('.pawn-slot[data-idx="0"]')).toHaveClass(/is-filled/);
    await expect(page.locator('.pawn-slot[data-idx="0"]')).toBeVisible();
    await expect(page.getByTestId('pawn-over')).toBeHidden();

    await openPawnCount(page);
    await page.getByTestId('pawn-count-8').click();
    await expect(page.locator('.pawn-slot[data-idx="0"]')).toHaveClass(/is-filled/);
  });

  // MORE PHOTOS THAN PAWNS — said out loud, because only the first N are printed.
  test('photos past the count stay on screen and are announced', async ({ page }) => {
    await stubCutter(page, { succeeds: false });
    await toPawnStep(page);
    await openPawnCount(page);
    await page.getByTestId('pawn-count-8').click();
    for (const i of [0, 1, 2, 3, 4, 5]) {
      await page
        .getByTestId('pawn-input-' + i)
        .setInputFiles({ name: 'p' + i + '.png', mimeType: 'image/png', buffer: PNG_BYTES });
    }
    await expect(page.getByTestId('pawn-over')).toBeHidden();

    // Six photos on a four-player deck: two do not fit.
    await openPawnCount(page);
    await page.getByTestId('pawn-count-4').click();
    const over = page.getByTestId('pawn-over');
    await expect(over).toBeVisible();
    await expect(over).toContainText('2 תמונות');
    // Both are still ON SCREEN, marked — hiding them is how they used to vanish.
    await expect(page.locator('.pawn-slot[data-idx="4"]')).toBeVisible();
    await expect(page.locator('.pawn-slot[data-idx="5"]')).toBeVisible();
    await expect(page.locator('.pawn-slot.is-over')).toHaveCount(2);

    // Removing one takes the count down with it; making room clears the line.
    await openPawnCount(page);
    await page.getByTestId('pawn-count-8').click();
    await expect(over).toBeHidden();
    await expect(page.locator('.pawn-slot.is-over')).toHaveCount(0);
  });

  // IT SURVIVES A RELOAD, like every other choice on this page. Nothing after the
  // pawns step shows the count, so a buyer who reloads on the contact step — an
  // iOS webview, back-forward restore, the link she is sharing — used to submit
  // `players: 4` having chosen 16, with no cue at all.
  test('the count survives a reload and the Back button', async ({ page }) => {
    await toPawnStep(page);
    await openPawnCount(page);
    await page.getByTestId('pawn-count-16').click();
    await expect(page.locator(VISIBLE)).toHaveCount(16);

    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('step-4')).toBeVisible();

    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await expect(page.getByTestId('pawn-count-16')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(VISIBLE)).toHaveCount(16);
    await expect(page.getByTestId('pawn-budget')).toContainText('עד 400 מילים');
  });

  // SIX FACES, SIX CUTOUTS, AND NOT ONE OF THEM STORED.
  //
  // The wizard posted every picked photo in ONE multipart body and never looked at
  // the answer: the route refused anything over four with a 400, `await fetch`
  // resolved on it exactly as on a 200, and the page redirected to her collection
  // as if it had worked. Measured on the branch this fixes: pick 16 players, upload
  // 6 → `400 too many images (max 4)`, `pawn_images: []`, and a collection page
  // with no photos and nothing to read.
  //
  // Two halves, one test each: the body is chunked so it is never refused, and a
  // refusal that does happen reaches her.
  async function fillSlots(page, n) {
    for (let i = 0; i < n; i++) {
      await page.getByTestId('pawn-input-' + i).setInputFiles({
        name: 'p' + i + '.png',
        mimeType: 'image/png',
        // Distinct bytes: content-addressed paths would otherwise de-dupe to one.
        buffer: Buffer.concat([PNG_BYTES, Buffer.from('slot' + i)]),
      });
    }
  }

  async function throughContact(page) {
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'a@b.com');
    await page.fill('#ownerPhone', '0521234567');
    await page.fill('#buyerNameInput', 'דנה כהן');
    await page.getByTestId('next-btn').click();
  }

  test('a big batch of photos goes up in requests the server will accept', async ({ page }) => {
    await stubCutter(page, { succeeds: true });
    await stubCreate(page);
    const batches = [];
    let stored = 0;
    await page.route('**/api/collections/*/pawns*', (route) => {
      const buf = route.request().postDataBuffer();
      const body = buf ? buf.toString('latin1') : '';
      const n = (body.match(/name="pawn\d+"/g) || []).length;
      batches.push(n);
      stored += n;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          pawn_images: Array.from({ length: stored }, (_, i) => '/content-uploads/' + i + '.png'),
          skipped: [],
        }),
      });
    });

    await toPawnStep(page);
    await openPawnCount(page);
    await page.getByTestId('pawn-count-16').click();
    await fillSlots(page, 6);
    await throughContact(page);
    await page.waitForURL(/collect\.html\?c=test-col/);

    // Never more than the route's per-request cap in one body — and all six sent.
    expect(batches).toEqual([4, 2]);
    // Nothing was lost, so nothing is reported on the way in.
    expect(new URL(page.url()).searchParams.get('photos_lost')).toBe(null);
  });

  test('a refused upload reaches the buyer instead of a redirect that pretends', async ({
    page,
  }) => {
    await stubCutter(page, { succeeds: true });
    await stubCreate(page);
    // Exactly what the route answered before the cap followed the player count.
    await page.route('**/api/collections/*/pawns*', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'too many images (max 4)' }),
      })
    );

    await toPawnStep(page);
    await fillSlots(page, 3);
    await throughContact(page);
    await page.waitForURL(/collect\.html\?c=test-col/);
    // The order still exists and she still lands on her page — the photos are a
    // nice-to-have and were never allowed to block checkout. What changed is that
    // the page is TOLD, so it can say so and offer her the re-upload.
    expect(new URL(page.url()).searchParams.get('photos_lost')).toBe('3');
  });

  test('the count travels with the order', async ({ page }) => {
    // It is set BEFORE any word is collected, so her ceiling is right from the
    // first word rather than moved under her later.
    await stubCreate(page);
    let body = null;
    await page.route('**/api/collections', async (route) => {
      body = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'test-col', owner_token: 'test-tok' }),
      });
    });
    await toPawnStep(page);
    await openPawnCount(page);
    await page.getByTestId('pawn-count-12').click();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'a@b.com');
    await page.fill('#ownerPhone', '0521234567');
    await page.fill('#buyerNameInput', 'דנה כהן');
    await page.getByTestId('next-btn').click();
    await page.waitForURL(/collect\.html\?c=test-col&k=test-tok/);
    expect(body).toMatchObject({ players: 12 });
  });

  // …AND THE BUYER WHO NEVER OPENS IT ORDERS EXACTLY WHAT SHE USED TO.
  //
  // The count went behind a disclosure to take a DECISION off the main path, not
  // to change the outcome of not making it. This is the test that says so, and it
  // asserts the number in the SUBMITTED BODY rather than anything about the
  // control: a check on what the page looks like would pass just as happily if the
  // default never reached the order at all.
  test('a buyer who never opens the disclosure still orders the standard deck', async ({
    page,
  }) => {
    await stubCreate(page);
    let body = null;
    await page.route('**/api/collections', async (route) => {
      body = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'test-col', owner_token: 'test-tok' }),
      });
    });
    await toPawnStep(page);
    // Nothing is pressed here on purpose — no toggle, no count. This is the whole
    // point of the test, so it must stay the only path through it.
    await expect(page.getByTestId('pawn-count-panel')).toBeHidden();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'a@b.com');
    await page.fill('#ownerPhone', '0521234567');
    await page.fill('#buyerNameInput', 'דנה כהן');
    await page.getByTestId('next-btn').click();
    await page.waitForURL(/collect\.html\?c=test-col&k=test-tok/);

    // The standard deck, unchanged, in the order itself.
    expect(body).toMatchObject({ players: 4 });
  });

  // An untouched control also leaves no trace in the url, so a link she shares
  // while still in the wizard stays as short as it was before this existed.
  test('an untouched count leaves the wizard url clean', async ({ page }) => {
    await stubCreate(page);
    await toPawnStep(page);
    expect(new URL(page.url()).searchParams.has('players')).toBe(false);
    // …and once she does choose, it is carried — so the absence above is the
    // control staying quiet, not the url having stopped working.
    await openPawnCount(page);
    await page.getByTestId('pawn-count-12').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('players')).toBe('12');
  });
});
