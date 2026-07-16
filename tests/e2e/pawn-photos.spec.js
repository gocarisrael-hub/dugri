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
