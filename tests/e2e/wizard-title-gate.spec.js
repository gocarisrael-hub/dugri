import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// The order wizard's TITLE step (step 3), and the one rule left on it:
//
//   The create/next button is GATED on the live preview. The instant in-browser
//   approximation is no longer revealed (owner decision), so the gate opens when
//   the EXACT server render lands (or its graceful fallback settles, or the 20s
//   backstop fires) — NOT off an instant draw. A typed title is never permanently
//   stuck behind a slow or failing render.
//
// The other half of this file used to cover the honoree NAME: single word, in the
// design's language, English design rejects Hebrew and vice versa. There is no
// name any more — "no name no gender only free text title" — and a title is free
// text, so those rules do not have a smaller version that survives. What replaced
// them is at the bottom: the title is required, and the step says so.

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

// Declare a design's extra fields the way the OWNER does — through the live
// GET /api/design-names feed the admin drives. `marriage` (סנטוריני) ships as a
// ONE-PERSON deck now, so a couple deck has to be asked for; the wizard decides
// couple mode from these FIELDS, never from the theme's name.
test.describe('create-button preview gate (step 3)', () => {
  test('the gate opens when the exact server render lands, not while it is pending', async ({
    page,
  }) => {
    // Hold the server render: while it is pending the loading card shows and the
    // gate stays CLOSED (no instant draw opens it anymore). Releasing the render
    // swaps the exact PNG in and opens the gate.
    let releasePreview;
    const pending = new Promise((r) => (releasePreview = r));
    await page.route('**/api/preview', async (route) => {
      await pending;
      await route.fulfill({ status: 200, contentType: 'application/json', body: previewBody });
    });

    await page.goto('/options.html?step=3'); // default design = bachelorette (english)
    await expect(page.getByTestId('step-3')).toBeVisible();

    const next = page.getByTestId('next-btn');
    // A single valid English name → the loading card shows; with the server render
    // still pending the gate is CLOSED and the instant approximation stays hidden.
    await page.fill('#customTitleInput', 'Shira');
    await expect(page.getByTestId('name-preview-loading')).toBeVisible();
    await expect(page.getByTestId('name-preview-instant-card')).toBeHidden();
    await expect(next).toBeDisabled();

    // Release the server render → the exact PNG swaps in and the gate opens.
    releasePreview();
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(next).toBeEnabled();
  });

  test('a FAILED server render opens the gate via the graceful fallback (never stuck)', async ({
    page,
  }) => {
    // The Python render is unavailable → /api/preview always 500s. After the auto-
    // retry the graceful fallback (name + manual retry) settles on screen and the
    // gate opens — the buyer is never permanently stuck on the loading spinner.
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
    );
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();

    await page.fill('#customTitleInput', 'Shira');
    // the graceful fallback becomes the terminal state and the gate opens…
    await expect(page.getByTestId('name-preview-fallback')).toBeVisible({ timeout: 8000 });
    await expect(page.getByTestId('next-btn')).toBeEnabled({ timeout: 8000 });
    // …and the instant approximation was never revealed.
    await expect(page.getByTestId('name-preview-instant-card')).toBeHidden();
  });

  test('editing to a new title re-gates until the new render lands', async ({ page }) => {
    // Hold the 2nd+ server render forever: editing to a new valid name must RE-CLOSE
    // the gate (the loading card returns) and keep it closed until a render lands —
    // it must never inherit the previous name's open latch.
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
    await page.fill('#customTitleInput', 'David');
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(next).toBeEnabled();

    // edit to name B → B's server render hangs → the loading card returns and the
    // gate RE-CLOSES, staying disabled while the render is pending.
    await page.fill('#customTitleInput', 'Sarah');
    await expect(page.getByTestId('name-preview-loading')).toBeVisible();
    await expect(next).toBeDisabled();
    await page.waitForTimeout(700);
    await expect(next).toBeDisabled();
  });
});

test.describe('the title is required, and the step says why', () => {
  test('an empty title explains the disabled Next', async ({ page }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();

    // There is no static hint on this step, so an empty box must SAY why the
    // button is dead rather than leaving a silent disabled control.
    const err = page.getByTestId('custom-title-err');
    const next = page.getByTestId('next-btn');
    await expect(err).toBeVisible();
    await expect(err).toContainText('כותרת');
    await expect(next).toBeDisabled();

    // One error target, and it stays UNTAGGED so the live rewrite (empty / emoji)
    // never fights an owner content-edit override.
    await expect(err).toHaveCount(1);
    await expect(err).not.toHaveAttribute('data-edit', /.*/);

    // Any text clears it — including everything the old name rule refused.
    await page.fill('#customTitleInput', 'ליאת חוגגת 40');
    await expect(err).toBeHidden();
    await expect(next).toBeEnabled();

    // …and clearing it again brings the explanation back.
    await page.fill('#customTitleInput', '   ');
    await expect(err).toBeVisible();
    await expect(next).toBeDisabled();
  });

  test('creating from the details step with no title bounces back to step 3', async ({ page }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    // Deep-link straight to the details step without ever typing a title, then
    // fill valid contact so the create button enables.
    await page.goto('/options.html?step=4');
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.getByTestId('owner-email').fill('x@example.com');
    await page.getByTestId('owner-phone').fill('0521234567');
    // The orderer's name is required on this step too, and an empty one holds the
    // create button on its own — which would make this test pass for the wrong
    // reason, never reaching the missing-title bounce it is here to prove.
    await page.getByTestId('buyer-name-input').fill('דנה כהן');
    const create = page.getByTestId('next-btn');
    await expect(create).toBeEnabled();

    // With no title there is nothing to print, so create must bounce BACK to the
    // title step rather than dead-end on the details step.
    await create.click();
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('step-4')).toBeHidden();
  });
});
