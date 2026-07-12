import { test, expect } from '@playwright/test';

// Two order-wizard rules on the name step (step 4):
//  1. The create/next button is GATED on the live name-preview: it stays disabled
//     until the preview has rendered on screen (or a 20s backstop elapses), so the
//     game is never created before the customer has seen a preview.
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
  test('the button stays disabled until the name-preview renders, then unlocks', async ({
    page,
  }) => {
    // Hold the preview response until we release it, so we can observe the button
    // gated while the preview is pending and unlocking once it renders.
    let releasePreview;
    const pending = new Promise((r) => (releasePreview = r));
    await page.route('**/api/preview', async (route) => {
      await pending;
      await route.fulfill({ status: 200, contentType: 'application/json', body: previewBody });
    });

    await page.goto('/options.html?step=3'); // default design = bachelorette (english)
    await expect(page.getByTestId('step-3')).toBeVisible();

    const next = page.getByTestId('next-btn');
    // A single valid English name → fields are valid, but the preview hasn't shown
    // yet, so the button is held disabled purely by the gate.
    await page.fill('#honoreeInput', 'Shira');
    await expect(page.getByTestId('name-err')).toBeHidden();
    await expect(next).toBeDisabled();
    // give the debounced request time to fire and sit pending — still gated.
    await page.waitForTimeout(700);
    await expect(next).toBeDisabled();

    // Release the preview → the card renders and the gate opens.
    releasePreview();
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(next).toBeEnabled();
  });

  test('a FAILED preview still unlocks the button (never permanently stuck)', async ({ page }) => {
    // The Python render is unavailable → /api/preview always 500s. The UI settles
    // on its graceful fallback, and the gate opens so a valid client isn't stuck.
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
    );
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();

    await page.fill('#honoreeInput', 'Shira');
    // the graceful fallback shows the name, and the button becomes enabled.
    await expect(page.getByTestId('name-preview-fallback')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('next-btn')).toBeEnabled({ timeout: 5000 });
  });

  test('editing the name after a preview RE-CLOSES the gate until the new preview renders', async ({
    page,
  }) => {
    // Hold the 2nd+ preview so we can observe the gate re-close after a name edit
    // (the create button must not stay unlocked from the previous name's preview).
    let calls = 0;
    let releaseSecond;
    const second = new Promise((r) => (releaseSecond = r));
    await page.route('**/api/preview', async (route) => {
      calls += 1;
      if (calls >= 2) await second;
      await route.fulfill({ status: 200, contentType: 'application/json', body: previewBody });
    });

    await page.goto('/options.html?step=3'); // bachelorette (english)
    await expect(page.getByTestId('step-3')).toBeVisible();
    const next = page.getByTestId('next-btn');

    // name A renders → gate opens
    await page.fill('#honoreeInput', 'David');
    await expect(page.getByTestId('name-preview-card')).toHaveAttribute('src', /^data:image\/png/);
    await expect(next).toBeEnabled();

    // edit to name B → gate must re-close while B's preview is pending
    await page.fill('#honoreeInput', 'Sarah');
    await expect(next).toBeDisabled();
    await page.waitForTimeout(700); // debounce fired, request held → still gated
    await expect(next).toBeDisabled();

    // B's preview renders → gate re-opens
    releaseSecond();
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

  test('the default name-format hints are owner-editable (data-edit) without breaking validation (I4c)', async ({
    page,
  }) => {
    await page.route('**/api/preview', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: previewBody })
    );
    await page.goto('/options.html?step=3'); // bachelorette (english)
    await expect(page.getByTestId('step-3')).toBeVisible();

    // A SEPARATE always-visible hint carries the editable key — NOT #nameErr, whose
    // textContent refreshNameError() rewrites live (tagging it would fight the JS).
    const hint = page.getByTestId('name-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute('data-edit', 'options-name-hint');
    // The JS-driven error target stays untagged so the sync/override never fights it.
    await expect(page.getByTestId('name-err')).toHaveCount(1);
    await expect(page.getByTestId('name-err')).not.toHaveAttribute('data-edit', /.*/);

    // Validation is unchanged: a spaced name errors + blocks, a single word clears.
    const err = page.getByTestId('name-err');
    const next = page.getByTestId('next-btn');
    await page.fill('#honoreeInput', 'Anne Marie');
    await expect(err).toBeVisible();
    await expect(next).toBeDisabled();
    await page.fill('#honoreeInput', 'Shira');
    await expect(err).toBeHidden();
    await expect(next).toBeEnabled();

    // The two partner-hint spans (couple design) carry their editable keys too; the
    // JS only toggles their `hidden`, never their text, so tagging them is safe.
    await page.goto('/options.html?design=marriage&step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('extra-name1-err')).toHaveAttribute(
      'data-edit',
      'options-name1-hint'
    );
    await expect(page.getByTestId('extra-name2-err')).toHaveAttribute(
      'data-edit',
      'options-name2-hint'
    );
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
