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
  await page.fill('#honoreeInput', 'Shira');
  await page.getByTestId('gender-female').check();
  await page.getByTestId('next-btn').click();
  await expect(page.getByTestId('step-pawns')).toBeVisible();
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

  test('selecting a file shows a small preview; removing it clears the slot', async ({ page }) => {
    await stubCutter(page, { succeeds: false });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await expect(slot0).not.toHaveClass(/is-filled/);

    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(slot0).toHaveClass(/is-filled/);
    await expect(slot0.locator('.pawn-thumb')).toBeVisible();
    await expect(page.getByTestId('pawn-remove-0')).toBeVisible();

    // Removing clears the preview and the filled state.
    await page.getByTestId('pawn-remove-0').click();
    await expect(slot0).not.toHaveClass(/is-filled/);
    await expect(slot0.locator('.pawn-thumb')).toBeHidden();
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

    // The slot switches to the cutout presentation and says so.
    await expect(slot0).toHaveClass(/is-cut/);
    await expect(page.getByTestId('pawn-status-0')).toHaveText('הרקע הוסר');
    // What it shows is the CUTOUT blob, not the original object URL.
    const shown = await slot0.locator('.pawn-thumb').getAttribute('src');
    expect(shown).toMatch(/^blob:/);

    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'a@b.com');
    await page.fill('#ownerPhone', '0521234567');
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

    // The slot stops being a thumbnail: the card's paper, the dashed cut-line
    // the buyer scissors along, and the photo placed inside it.
    await expect(slot0).toHaveClass(/is-pawn/);
    await expect(slot0.locator('.pawn-cut-line')).toHaveCount(1);
    // …and the "background removed" band is gone: the sticker says it, and the
    // band would sit across the bottom of the circle it is describing.
    await expect(page.getByTestId('pawn-status-0')).toBeHidden();

    // The FRAMING is the promise this preview makes, so it is asserted as a
    // number rather than as "something was set". For a 4x4 image whose subject
    // is the middle 2x2, the subject's reach is sqrt(0.5) px, the disc radius is
    // 45% of the slot, so the image is drawn at 4 * 45/sqrt(0.5) = 254.56% with
    // its top-left at 50 - 2 * 45/sqrt(0.5) = -77.28%. Those are the same
    // numbers generator/build.py arrives at for the same alpha.
    const style = await slot0.locator('.pawn-thumb').evaluate((el) => ({
      width: parseFloat(el.style.width),
      left: parseFloat(el.style.left),
      top: parseFloat(el.style.top),
    }));
    expect(style.width).toBeCloseTo(254.56, 1);
    expect(style.left).toBeCloseTo(-77.28, 1);
    expect(style.top).toBeCloseTo(-77.28, 1);
  });

  test('a cut with nothing measurable in it stays a plain thumbnail', async ({ page }) => {
    // The transparent 2x2: a cutout exists, but there is no subject to frame. The
    // slot must NOT dress up as a pawn — a circle whose contents were placed by
    // guesswork is a promise we cannot keep.
    await stubCutter(page, { succeeds: true });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });

    await expect(slot0).toHaveClass(/is-cut/);
    await expect(slot0).not.toHaveClass(/is-pawn/);
    await expect(slot0.locator('.pawn-cut-line')).toHaveCount(0);
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
    await expect(page.getByTestId('pawn-status-0')).toHaveText('נסיר את הרקע ידנית');
    await expect(page.getByTestId('pawn-err')).toBeHidden();
    await expect(page.getByTestId('next-btn')).toBeEnabled();

    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'a@b.com');
    await page.fill('#ownerPhone', '0521234567');
    await page.getByTestId('next-btn').click();
    await page.waitForURL(/collect\.html\?c=test-col&k=test-tok/);

    // No cutout part, and the miss is named so the server records it and the
    // owner's orders table can flag it for a manual cut.
    expect(pawns.body).toContain('name="pawn0"');
    expect(pawns.body).not.toContain('name="cut:pawn0"');
    expect(pawns.body).toMatch(/name="cutfail"\r\n\r\npawn0/);
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
    await expect(page.getByTestId('pawn-status-0')).toHaveText('נסיר את הרקע ידנית');

    // Second pick, this time the cut succeeds: the slot must follow the NEW
    // photo's result rather than keeping the old one.
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(slot0).toHaveClass(/is-cut/);
    await expect(page.getByTestId('pawn-status-0')).toHaveText('הרקע הוסר');
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
    await expect(page.getByTestId('pawn-status-0')).toHaveText('נסיר את הרקע ידנית', {
      timeout: 25000,
    });
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

  // What the buyer RECEIVES, said once and said in weight. The step described how
  // the photos are cut but never what arrives: the pawns come printed on a single
  // card, already cut into circles. It is the one promise on this step, so it is
  // the one line that is not muted grey.
  test('the step says the pawns arrive on one card, cut into circles — in bold', async ({
    page,
  }) => {
    await toPawnStep(page);
    const cut = page.getByTestId('pawn-cut');
    await expect(cut).toBeVisible();
    await expect(cut).toContainText('קלף אחד');
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
  // in the chain — so the step has to say where the real one is made, and what to
  // do when the preview looks wrong. Both are one-line answers to the two things
  // she would otherwise message about.
  test('the tip names the print shop and the black-background fix', async ({ page }) => {
    await toPawnStep(page);
    const tip = page.getByTestId('pawn-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('בבית הדפוס');
    await expect(tip).toContainText('ChatGPT');
    await expect(tip).toContainText('רקע שחור');

    // It sits BELOW the grid: the advice is about a cut she has already looked at.
    const order = await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="pawn-grid"]').getBoundingClientRect();
      const t = document.querySelector('[data-testid="pawn-tip"]').getBoundingClientRect();
      const cut = document.querySelector('[data-testid="pawn-cut"]').getBoundingClientRect();
      return { tipBelowGrid: t.top >= grid.bottom, cutAboveGrid: cut.bottom <= grid.top };
    });
    expect(order).toEqual({ tipBelowGrid: true, cutAboveGrid: true });
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
