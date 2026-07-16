import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The step-3 name preview draws an INSTANT in-browser card the moment a valid name
// is entered — the recolored product artwork with the typed name overlaid — and
// swaps the EXACT server PNG in on top when POST /api/preview eventually returns.
// This proves the four guarantees of that design:
//   (a) the card + name appear (and Next enables) IMMEDIATELY, even when the server
//       render is slow or failing — never a wait on the network;
//   (b) the exact PNG swaps in once the server responds;
//   (c) a failing / 429 server render leaves the instant card intact, no broken UI;
//   (d) a "refining…" indicator shows while the server render is in flight, and
//       clears once it settles.

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const previewBody = JSON.stringify({
  card: PNG,
  back: PNG,
  board: PNG,
  warning: null,
  word_font: null,
  word_font_options: [],
});

// design-0 = bachelorette → theme "bachelorette" (english, no extra fields).
async function toNameStep(page) {
  await page.goto('/options.html?plan=base');
  await expect(page.getByTestId('step-1')).toBeVisible();
  await page.getByTestId('design-0').click();
  await page.getByTestId('next-btn').click(); // -> step 2
  await page.getByTestId('next-btn').click(); // -> step 3 (name)
  await expect(page.getByTestId('step-3')).toBeVisible();
}

const cardInstantName = (page) =>
  page.locator('#namePreviewImgs [data-np-instant="card"] .npi-name');

test.describe('(a) instant card appears without waiting on /api/preview', () => {
  test('a slow server render does not delay the card, the name, or Next', async ({ page }) => {
    // The server render hangs (never fulfilled) — the instant draw must carry the UI.
    await page.route('**/api/preview', async () => {
      /* never resolves */
    });
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    // instant card + overlaid name appear fast (well within the default 5s budget)
    await expect(page.getByTestId('name-preview-instant-card')).toBeVisible();
    await expect(cardInstantName(page)).toHaveText('Shira');
    // and the create gate opens off the instant draw, with no server response
    await expect(page.getByTestId('next-btn')).toBeEnabled();
  });

  test('the instant card carries the RIGHT artwork (an inlined, recolored SVG)', async ({
    page,
  }) => {
    await page.route('**/api/preview', async () => {});
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    // the instant layer inlines the design's product SVG (cropped to one card),
    // recoloured via the live --cN palette — not a raster or a blank placeholder.
    const art = page.locator('#namePreviewImgs [data-np-instant="card"] .npi-art svg');
    await expect(art).toBeVisible();
  });
});

test.describe('(b) the exact server PNG swaps in when it returns', () => {
  test('the instant card is replaced by the server render', async ({ page }) => {
    let release;
    const pending = new Promise((r) => (release = r));
    await page.route('**/api/preview', async (route) => {
      await pending;
      await route.fulfill({ status: 200, contentType: 'application/json', body: previewBody });
    });
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    // instant first…
    await expect(page.getByTestId('name-preview-instant-card')).toBeVisible();
    await expect(page.getByTestId('name-preview-card')).toBeHidden();

    // …then the exact PNG swaps in and the instant layer hides.
    release();
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(page.getByTestId('name-preview-card')).toBeVisible();
    await expect(page.getByTestId('name-preview-instant-card')).toBeHidden();
  });
});

test.describe('(c) a failing / 429 server render leaves the instant card intact', () => {
  for (const status of [500, 429]) {
    test(`a ${status} response keeps the instant card and shows no error UI`, async ({ page }) => {
      await page.route('**/api/preview', (route) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: '{"error":"nope"}',
        })
      );
      await toNameStep(page);
      await page.getByTestId('honoree-input').fill('Shira');

      await expect(page.getByTestId('name-preview-instant-card')).toBeVisible();
      await expect(cardInstantName(page)).toHaveText('Shira');
      // no fallback, no stuck loader, and the refining bar clears
      await expect(page.getByTestId('name-preview-fallback')).toBeHidden();
      await expect(page.getByTestId('name-preview-loading')).toBeHidden();
      await expect(page.getByTestId('name-preview-refining')).toBeHidden({ timeout: 5000 });
      await expect(page.getByTestId('next-btn')).toBeEnabled();
    });
  }
});

test.describe('(d) the refining indicator', () => {
  test('shows while the server render is in flight and clears after it lands', async ({ page }) => {
    let release;
    const pending = new Promise((r) => (release = r));
    await page.route('**/api/preview', async (route) => {
      await pending;
      await route.fulfill({ status: 200, contentType: 'application/json', body: previewBody });
    });
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    // instant card up, server render pending → the refining indicator is visible
    await expect(page.getByTestId('name-preview-instant-card')).toBeVisible();
    await expect(page.getByTestId('name-preview-refining')).toBeVisible();

    // server render lands → the indicator clears
    release();
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(page.getByTestId('name-preview-refining')).toBeHidden();
  });
});
