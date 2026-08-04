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

// Stub + record the pawn-upload call.
function capturePawns(page) {
  const captured = { called: false, url: '' };
  page.route('**/api/collections/*/pawns*', (route) => {
    captured.called = true;
    captured.url = route.request().url();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, pawn_images: ['/content-uploads/abc.png'] }),
    });
  });
  return captured;
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

  // ---- automatic background removal -------------------------------------
  // The card traces each sticker's white outline from the image's OWN alpha, so an
  // uncut photo prints as a white rectangle. The buyer therefore has to SEE the cut
  // here, while a re-upload is still one tap away.

  // A 4x4 transparent RGBA PNG standing in for what the server cuts.
  const CUT_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+' +
    'AAAAFUlEQVR4nGNgwAb+gxGmKBZBBgYGAIa9A/0e+NXIAAAAAElFTkSuQmCC';

  // Stub the cutout endpoint with a given JSON reply, and count the calls.
  function stubCutout(page, body) {
    const calls = { n: 0 };
    page.route('**/api/pawn-cutout', (route) => {
      calls.n++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
    return calls;
  }

  test('a picked photo is replaced by its background-removed cutout', async ({ page }) => {
    const calls = stubCutout(page, { ok: true, cutout: CUT_DATA_URL });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');

    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });

    await expect(slot0).toHaveClass(/is-cut/);
    await expect(slot0.locator('.pawn-thumb')).toHaveAttribute('src', CUT_DATA_URL);
    await expect(page.getByTestId('pawn-status-0')).toHaveText('הרקע הוסר');
    expect(calls.n).toBe(1);
    // Only the slot that was filled is touched.
    await expect(page.locator('.pawn-slot[data-idx="1"]')).not.toHaveClass(/is-cut/);
  });

  test('re-uploading a slot re-cuts it and never leaves the old cut behind', async ({ page }) => {
    let replies = 0;
    await page.route('**/api/pawn-cutout', (route) => {
      replies++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          replies === 1 ? { ok: true, cutout: CUT_DATA_URL } : { ok: false, reason: 'failed' }
        ),
      });
    });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');

    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(slot0).toHaveClass(/is-cut/);

    // Tapping the slot re-opens its picker — this is the per-slot re-upload.
    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(slot0).not.toHaveClass(/is-cut/);
    await expect(page.getByTestId('pawn-status-0')).toHaveText('נסיר את הרקע ידנית');
    expect(replies).toBe(2);
  });

  test('a failed cut still keeps the photo — the order is never blocked on it', async ({
    page,
  }) => {
    stubCutout(page, { ok: false, reason: 'failed' });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');

    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });

    await expect(slot0).toHaveClass(/is-filled/);
    await expect(slot0).not.toHaveClass(/is-cut/);
    await expect(page.getByTestId('pawn-status-0')).toBeVisible();
    await expect(page.getByTestId('next-btn')).toBeEnabled();
  });

  test('with background removal unconfigured the step looks exactly as it did before', async ({
    page,
  }) => {
    stubCutout(page, { ok: false, reason: 'unconfigured' });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');

    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });

    await expect(slot0).toHaveClass(/is-filled/);
    await expect(slot0).not.toHaveClass(/is-cut/);
    // No status badge at all — we don't promise something we aren't doing.
    await expect(page.getByTestId('pawn-status-0')).toBeHidden();
  });

  test('removing a slot drops its cutout too', async ({ page }) => {
    stubCutout(page, { ok: true, cutout: CUT_DATA_URL });
    await toPawnStep(page);
    const slot0 = page.locator('.pawn-slot[data-idx="0"]');

    await page
      .getByTestId('pawn-input-0')
      .setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await expect(slot0).toHaveClass(/is-cut/);

    await page.getByTestId('pawn-remove-0').click();
    await expect(slot0).not.toHaveClass(/is-filled/);
    await expect(slot0).not.toHaveClass(/is-cut/);
    await expect(page.getByTestId('pawn-status-0')).toBeHidden();
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
