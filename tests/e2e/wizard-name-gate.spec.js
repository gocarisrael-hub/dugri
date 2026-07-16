import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// Two order-wizard rules on the name step (step 4):
//  1. The create/next button is GATED on the live name-preview — but the preview
//     now draws an INSTANT in-browser card the moment a valid name is entered, so
//     the gate opens immediately WITHOUT waiting on the (slow/failable) server
//     render. A valid name is never stuck behind the network.
//  2. The honoree name must be a SINGLE word in the design's LANGUAGE — an English
//     design rejects a Hebrew name and a name with a space, a Hebrew design rejects
//     a Latin name — each with a clear inline error that blocks advancing.

// A 1x1 transparent PNG used as the fake rendered preview image.
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

test.describe('create-button preview gate (step 4)', () => {
  test('the INSTANT draw opens the gate immediately — no wait on the server render', async ({
    page,
  }) => {
    // Hold the server render indefinitely: the gate must open anyway, driven by the
    // instant in-browser card. The exact PNG then swaps in only once we release it.
    let releasePreview;
    const pending = new Promise((r) => (releasePreview = r));
    await page.route('**/api/preview', async (route) => {
      await pending;
      await route.fulfill({ status: 200, contentType: 'application/json', body: previewBody });
    });

    await page.goto('/options.html?step=3'); // default design = bachelorette (english)
    await expect(page.getByTestId('step-3')).toBeVisible();

    const next = page.getByTestId('next-btn');
    // A single valid English name → the instant card draws immediately and opens
    // the gate, even though the server render is still pending.
    await page.fill('#honoreeInput', 'Shira');
    await expect(page.getByTestId('name-err')).toBeHidden();
    await expect(page.getByTestId('name-preview-instant-card')).toBeVisible();
    await expect(next).toBeEnabled();

    // Release the server render → the exact PNG swaps in over the instant card.
    releasePreview();
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(next).toBeEnabled();
  });

  test('a FAILED server render never blocks the button (instant card carries it)', async ({
    page,
  }) => {
    // The Python render is unavailable → /api/preview always 500s. The instant card
    // still shows and the gate opens — the failure is invisible, no error UI.
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
    );
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();

    await page.fill('#honoreeInput', 'Shira');
    // the instant card is on screen and the button becomes enabled…
    await expect(page.getByTestId('name-preview-instant-card')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('next-btn')).toBeEnabled({ timeout: 5000 });
    // …and NO error fallback is shown (the instant draw covers the failure).
    await expect(page.getByTestId('name-preview-fallback')).toBeHidden();
  });

  test('editing to a new valid name keeps the gate open via the instant draw', async ({ page }) => {
    // Hold the 2nd+ server render forever: editing to a new valid name must keep the
    // button enabled (the instant card redraws immediately), never re-gating on the
    // pending network render.
    let calls = 0;
    const second = new Promise(() => {}); // never resolves
    await page.route('**/api/preview', async (route) => {
      calls += 1;
      if (calls >= 2) await second; // 2nd render hangs
      await route.fulfill({ status: 200, contentType: 'application/json', body: previewBody });
    });

    await page.goto('/options.html?step=3'); // bachelorette (english)
    await expect(page.getByTestId('step-3')).toBeVisible();
    const next = page.getByTestId('next-btn');

    // name A → exact render swaps in, gate open
    await page.fill('#honoreeInput', 'David');
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(next).toBeEnabled();

    // edit to name B → the instant card redraws with B; the button STAYS enabled
    // even though B's server render never resolves.
    await page.fill('#honoreeInput', 'Sarah');
    await expect(page.getByTestId('name-preview-instant-card')).toBeVisible();
    await expect(next).toBeEnabled();
    await page.waitForTimeout(700);
    await expect(next).toBeEnabled();
  });
});

test.describe('name language + single-word rules block Next', () => {
  test('an ENGLISH design rejects a Hebrew name and a spaced name, accepts a single English word', async ({
    page,
  }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    await page.goto('/options.html?step=3'); // bachelorette = english
    await expect(page.getByTestId('step-3')).toBeVisible();
    const next = page.getByTestId('next-btn');
    const err = page.getByTestId('name-err');

    // Hebrew name on an English design → language error + blocked.
    await page.fill('#honoreeInput', 'שירה');
    await expect(err).toBeVisible();
    await expect(err).toContainText('אנגלית');
    await expect(next).toBeDisabled();

    // A space (two words) → single-word format error + blocked.
    await page.fill('#honoreeInput', 'Anne Marie');
    await expect(err).toBeVisible();
    await expect(next).toBeDisabled();

    // A single English word → accepted (error clears; the gate opens via preview).
    await page.fill('#honoreeInput', 'Shira');
    await expect(err).toBeHidden();
    await expect(next).toBeEnabled();
  });

  test('a HEBREW design rejects a Latin name with a Hebrew-language hint', async ({ page }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    // kids = birthday-boys-basketball (hebrew). Deep-link straight to the name step.
    await page.goto('/options.html?design=kids&step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    const err = page.getByTestId('name-err');

    // An English name on a Hebrew design → language error + blocked.
    await page.fill('#honoreeInput', 'Shira');
    await expect(err).toBeVisible();
    await expect(err).toContainText('עברית');
    await expect(page.getByTestId('next-btn')).toBeDisabled();

    // A Hebrew name clears the name error (age is still required to advance).
    await page.fill('#honoreeInput', 'שירה');
    await expect(err).toBeHidden();
  });

  test('creating from the details step with no name bounces back to the name step (step 3)', async ({
    page,
  }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    // Deep-link straight to the details step (now step 4) without ever entering a
    // honoree name, then fill valid contact so the create button enables.
    await page.goto('/options.html?step=4');
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.getByTestId('owner-email').fill('x@example.com');
    await page.getByTestId('owner-phone').fill('0521234567');
    const create = page.getByTestId('next-btn');
    await expect(create).toBeEnabled();

    // With no name, createCollection must bounce BACK to the name step (step 3),
    // not dead-end on the details step (the pre-fix goStep(4) was a no-op there).
    await create.click();
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('step-4')).toBeHidden();
  });

  test('the empty-name error explains the disabled Next, and the error target is not owner-editable', async ({
    page,
  }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    await page.goto('/options.html?step=3'); // bachelorette (english)
    await expect(page.getByTestId('step-3')).toBeVisible();

    // With the static hint removed, the empty state must SURFACE a clear message so
    // the buyer understands why Next is disabled (not a silent dead button).
    const err = page.getByTestId('name-err');
    const next = page.getByTestId('next-btn');
    await expect(err).toBeVisible();
    await expect(err).toContainText('שם בעל/ת השמחה');
    await expect(next).toBeDisabled();

    // There is exactly one error target and it stays UNTAGGED so the live rewrite
    // (empty / format / language) never fights an owner-edit override.
    await expect(err).toHaveCount(1);
    await expect(err).not.toHaveAttribute('data-edit', /.*/);

    // Validation is unchanged: a spaced name errors + blocks, a single word clears.
    await page.fill('#honoreeInput', 'Anne Marie');
    await expect(err).toBeVisible();
    await expect(next).toBeDisabled();
    await page.fill('#honoreeInput', 'Shira');
    await expect(err).toBeHidden();
    await expect(next).toBeEnabled();

    // On a couple (anniversary) design the single-name error stays hidden (the two
    // partner fields are the ask). The partner ERROR spans are NOT tagged editable.
    await page.goto('/options.html?design=marriage&step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('name-err')).toBeHidden();
    await expect(page.getByTestId('extra-name1-err')).not.toHaveAttribute('data-edit', /.*/);
    await expect(page.getByTestId('extra-name2-err')).not.toHaveAttribute('data-edit', /.*/);
    // partner validation still fires on an invalid name
    await page.getByTestId('extra-name1').fill('David');
    await expect(page.getByTestId('extra-name1-err')).toBeVisible();
    await expect(page.getByTestId('next-btn')).toBeDisabled();
  });

  test('a couple (anniversary) design shows an inline error for an invalid partner name', async ({
    page,
  }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    // marriage = anniversary (hebrew, couple): the two partner-name fields replace
    // the single honoree box and must each be a single Hebrew word.
    await page.goto('/options.html?design=marriage&step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    const next = page.getByTestId('next-btn');
    const name1Err = page.getByTestId('extra-name1-err');

    // English partner name on a Hebrew couple design → inline error + blocked
    // (previously this failed silently with a dead, unexplained Next button).
    await page.getByTestId('extra-name1').fill('David');
    await expect(name1Err).toBeVisible();
    await expect(next).toBeDisabled();

    // a single Hebrew word clears that field's error
    await page.getByTestId('extra-name1').fill('דנה');
    await expect(name1Err).toBeHidden();
  });
});
