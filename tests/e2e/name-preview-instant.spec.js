import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// Owner decision: the step-3 name preview no longer reveals the INSTANT in-browser
// approximation (the recoloured product artwork with the typed name overlaid in a
// plain display font — it read as an unfinished black name slapped on the card).
// Instead the LOADING card holds until the EXACT server render (POST /api/preview)
// arrives, then that is revealed. This proves the guarantees of that decision:
//   (a) while the server render is in flight the LOADING card shows — never the
//       instant approximation, and never the honoree name on the card;
//   (b) the exact PNG swaps in once the server responds, and the create gate opens
//       THEN (not off an instant draw);
//   (c) a failing / 429 server render is NOT swallowed by an instant card anymore —
//       after the auto-retry it settles on the graceful fallback (name + retry) and
//       opens the gate, so the buyer is never stuck on the spinner forever;
//   (d) the instant approximation layer stays hidden throughout, even after the
//       exact PNG lands.
// The instant-draw code is retained but gated off (REVEAL_INSTANT_PREVIEW = false).

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

test.describe('(a) the loading card holds while the server render is pending', () => {
  test('a slow server render shows the loading card, NOT the instant approximation or the name', async ({
    page,
  }) => {
    // The server render hangs (never fulfilled): the loading card must carry the UI,
    // and the honoree name must NOT appear on the card in the interim.
    await page.route('**/api/preview', async () => {
      /* never resolves */
    });
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    // the card-shaped loading indicator (spinner skeleton) is on screen…
    await expect(page.getByTestId('name-preview-loading')).toBeVisible();
    await expect(page.getByTestId('name-preview-loading-card')).toBeVisible();
    // …the instant approximation is NEVER revealed…
    await expect(page.getByTestId('name-preview-instant-card')).toBeHidden();
    // …and the honoree name is nowhere on the card (no overlay, no fallback name).
    await expect(page.locator('#namePreviewImgs .npi-name').first()).toHaveText('');
    await expect(page.locator('#npfName')).not.toHaveText('Shira');
    // the create gate stays CLOSED until the exact render (or the backstop) lands.
    await expect(page.getByTestId('next-btn')).toBeDisabled();
  });
});

test.describe('(b) the exact server PNG reveals and opens the gate', () => {
  test('loading card first, then the server render swaps in and enables Next', async ({ page }) => {
    let release;
    const pending = new Promise((r) => (release = r));
    await page.route('**/api/preview', async (route) => {
      await pending;
      await route.fulfill({ status: 200, contentType: 'application/json', body: previewBody });
    });
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    // loading first — the server render is held, so the gate is still closed…
    await expect(page.getByTestId('name-preview-loading')).toBeVisible();
    await expect(page.getByTestId('name-preview-card')).toBeHidden();
    await expect(page.getByTestId('next-btn')).toBeDisabled();

    // …then the exact PNG swaps in, the loading card clears, and the gate opens.
    release();
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(page.getByTestId('name-preview-card')).toBeVisible();
    await expect(page.getByTestId('name-preview-loading')).toBeHidden();
    await expect(page.getByTestId('next-btn')).toBeEnabled();
  });
});

test.describe('(c) a failing / 429 server render settles on the graceful fallback', () => {
  for (const status of [500, 429]) {
    test(`a ${status} response ends on the fallback + retry and opens the gate (never stuck)`, async ({
      page,
    }) => {
      await page.route('**/api/preview', (route) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: '{"error":"nope"}',
        })
      );
      await toNameStep(page);
      await page.getByTestId('honoree-input').fill('Shira');

      // after the auto-retry both attempts fail → the graceful fallback (name in a
      // script font + manual retry) is the terminal state, and the gate opens.
      await expect(page.getByTestId('name-preview-fallback')).toBeVisible({ timeout: 8000 });
      await expect(page.getByTestId('name-preview-retry')).toBeVisible();
      await expect(page.locator('#npfName')).toHaveText('Shira');
      await expect(page.getByTestId('next-btn')).toBeEnabled({ timeout: 8000 });
      // the instant approximation is never revealed at any point.
      await expect(page.getByTestId('name-preview-instant-card')).toBeHidden();
    });
  }
});

test.describe('(d) the instant approximation layer stays hidden even after the render lands', () => {
  test('the exact PNG is authoritative; the instant card never shows', async ({ page }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    await toNameStep(page);
    await page.getByTestId('honoree-input').fill('Shira');

    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(page.getByTestId('name-preview-card')).toBeVisible();
    // the instant layer was never revealed, and its name overlay stays empty.
    await expect(page.getByTestId('name-preview-instant-card')).toBeHidden();
    await expect(page.locator('#namePreviewImgs [data-np-instant="card"] .npi-name')).toHaveText(
      ''
    );
  });
});

// ---- reconciliation: one monotonic previewSeq tags every name/param change; the
// (debounced) server render honours it, so a superseded in-flight render can never
// swap its stale card in, and an edit re-gates until the NEW render lands. ----
test.describe('server-render reconciliation', () => {
  test('(#1) the gate re-closes on a name edit until the new render lands', async ({ page }) => {
    // Name A's render succeeds (gate opens); after editing to B, B's render hangs →
    // the gate MUST re-close (Next disabled), not stay open on A's stale latch.
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

    // name A: server render lands → gate opens
    await page.fill('#honoreeInput', 'David');
    await expect(next).toBeEnabled({ timeout: 6000 });

    // edit to B: B's render hangs → gate must RE-CLOSE and stay closed
    await page.fill('#honoreeInput', 'Sarah');
    await expect(next).toBeDisabled();
    await page.waitForTimeout(700);
    await expect(next).toBeDisabled();
  });

  test('(#2) a superseded server render never overwrites the newer exact card', async ({
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
});
