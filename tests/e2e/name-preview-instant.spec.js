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

  test('shows during the INITIAL (uncached) instant draw too — no blank box with no affordance', async ({
    page,
  }) => {
    // Delay the product-SVG fetch so the instant draw itself is slow on first entry.
    // The refining indicator must show during that draw (not only during the server
    // fetch), so the buyer never faces a blank box with no loading affordance.
    await page.route('**/assets/designs/**/front.svg', async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.route('**/api/preview', async () => {}); // hold the server too
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    await page.getByTestId('honoree-input').fill('Shira');

    // while the instant draw is still fetching its artwork, the affordance is up
    await expect(page.getByTestId('name-preview-refining')).toBeVisible();
  });
});

// ---- reconciliation between the non-debounced instant draw and the debounced,
// cached server render (the core of the code-review fixes). One monotonic
// previewSeq tags every name/param change; both draws honour it. ----
test.describe('instant/server reconciliation', () => {
  test('(#1) the gate re-closes on a name edit — never inherits the previous name state', async ({
    page,
  }) => {
    // Force the INSTANT draw to always fail (block the product SVG) so only the
    // SERVER render can open the gate. Name A's render succeeds (gate opens); after
    // editing to B, B's render hangs → the gate MUST re-close (Next disabled), not
    // stay open from A's now-stale previewShown latch.
    await page.route('**/assets/designs/**/front.svg', (route) => route.abort());
    let calls = 0;
    await page.route('**/api/preview', async (route) => {
      calls += 1;
      if (calls >= 2) {
        await new Promise(() => {}); // B's render hangs forever
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: previewBody });
    });
    await page.goto('/options.html?step=3'); // bachelorette (english)
    await expect(page.getByTestId('step-3')).toBeVisible();
    const next = page.getByTestId('next-btn');

    // name A: instant fails, server succeeds → gate opens
    await page.fill('#honoreeInput', 'David');
    await expect(next).toBeEnabled({ timeout: 6000 });

    // edit to B: instant fails again, B's server hangs → gate must RE-CLOSE
    await page.fill('#honoreeInput', 'Sarah');
    await expect(next).toBeDisabled();
    await page.waitForTimeout(700);
    await expect(next).toBeDisabled();
  });

  test('(#2) a superseded server render never overwrites the newer instant/exact card', async ({
    page,
  }) => {
    // Distinct card PNGs per name; name A's response is DELAYED so it returns AFTER
    // name B has superseded it. The stale A render must be rejected by the seq guard
    // and never swap its card over B.
    const CARD_A =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const CARD_B =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await page.route('**/api/preview', async (route) => {
      const body = route.request().postDataJSON() || {};
      const isA = body.name === 'Aaa';
      if (isA) await new Promise((r) => setTimeout(r, 1500)); // delay A so B supersedes it
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          card: isA ? CARD_A : CARD_B,
          back: null,
          board: null,
          warning: null,
          word_font: null,
          word_font_options: [],
        }),
      });
    });
    await toNameStep(page);

    // type A and wait past the 450ms debounce so A's server request actually fires
    await page.getByTestId('honoree-input').fill('Aaa');
    await page.waitForTimeout(650);
    // now type B — bumps the seq; B's response returns fast
    await page.getByTestId('honoree-input').fill('Bbb');
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', CARD_B);

    // wait long enough for A's DELAYED response to arrive and be (correctly) ignored
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', CARD_B);
  });

  test('(#3) a slow instant draw does not clobber an exact PNG that already swapped in', async ({
    page,
  }) => {
    // Delay the product-SVG fetch so the instant draw resolves AFTER the (fast)
    // server render has already swapped the exact PNG in. The late instant draw must
    // NOT re-hide the exact PNG (serverShown guard).
    await page.route('**/assets/designs/**/front.svg', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    await page.fill('#honoreeInput', 'Shira');

    // the server render swaps in fast, before the delayed SVG resolves
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(page.getByTestId('name-preview-card')).toBeVisible();
    await expect(page.getByTestId('name-preview-instant-card')).toBeHidden();

    // wait past the SVG delay → the instant draw resolves but must not re-show
    await page.waitForTimeout(1800);
    await expect(page.getByTestId('name-preview-card')).toBeVisible();
    await expect(page.getByTestId('name-preview-instant-card')).toBeHidden();
  });

  test('(#4) the instant draw uses the ORIGINAL palette (matches the colour-agnostic server)', async ({
    page,
  }) => {
    // bachelorette's first anchor (site/js/designs.generated.js). applyOriginal sets
    // the instant layer's --c0 to this verbatim — NOT a colour derived from a picked
    // slider colour — because the server preview render is colour-agnostic, so both
    // instant and exact show the same (original) colours and nothing vanishes on swap.
    const ORIGINAL_C0 = '#1e263b';
    await page.route('**/api/preview', async () => {}); // hold the server; inspect the instant draw only
    await page.goto('/options.html?plan=base');
    await expect(page.getByTestId('step-1')).toBeVisible();
    await page.getByTestId('design-0').click();
    await page.getByTestId('next-btn').click(); // -> step 2 (colour)
    // pick a non-original slider colour
    await page.getByTestId('color-3').click();
    await expect(page.getByTestId('color-3')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('next-btn').click(); // -> step 3 (name)
    await page.getByTestId('honoree-input').fill('Shira');
    await expect(page.getByTestId('name-preview-instant-card')).toBeVisible();

    // the instant card is recoloured to the design's ORIGINAL palette, not the pick
    const c0 = await page
      .locator('[data-np-instant="card"]')
      .evaluate((el) => el.style.getPropertyValue('--c0').trim());
    expect(c0.toLowerCase()).toBe(ORIGINAL_C0);
  });
});
