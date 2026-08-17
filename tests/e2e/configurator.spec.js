import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// ---- fixed-colour designs --------------------------------------------------
// `recolor:'fixed'` (a design whose baked-in art can't be recoloured) hides the
// whole swatch picker and shows the "colours are fixed" note instead. The only
// built-in that was ever fixed — neon / "טיימס סקוור" — was RETIRED, so no shipped
// design exercises the branch any more. Rather than drop the coverage, these tests
// inject a fixed design by rewriting the generated manifest ON THE WIRE: japanese
// is served back as anchors:[] + recolor:'fixed'. Fails loudly if the manifest
// shape changes so the patch can never silently become a no-op.
const FIXED_ID = 'japanese';
const FIXED_ACCENT = '#d42a2a';
async function stubFixedDesign(page) {
  // The module may be served under a content-hashed name (/js/designs.generated.<hash>.js
  // via the import map — server/asset-hashing.js), so match both the logical and hashed url.
  await page.route(/\/js\/designs\.generated(?:\.[0-9a-f]{8})?\.js(?:\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    const patched = body.replace(
      /japanese: \{\s*anchors: \[[^\]]*\],\s*hasRaster: (true|false),\s*recolor: 'slider',/,
      "japanese: { anchors: [], hasRaster: $1, recolor: 'fixed',"
    );
    if (patched === body) throw new Error('manifest shape changed — fixed-design stub is a no-op');
    return route.fulfill({ contentType: 'application/javascript', body: patched });
  });
}

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// Order wizard e2e: a single page with four stepped screens (design ->
// color + add-ons -> name -> contact). Steps show/hide via JS; Back/Next +
// ?step=N drive navigation. Runs on every configured project (desktop + mobile).

// A 1x1 transparent PNG data URL used as the fake rendered preview image.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// The create button is gated on the name step until the live name-preview shows.
// Stub /api/preview so the real (Python) render isn't needed and the gate opens
// deterministically — the same technique name-preview.spec.js uses.
// Pin /api/pricing to the launch defaults. The store price is a GLOBAL,
// owner-editable setting on the shared e2e server, and admin-pricing.spec edits
// it for real while this file runs — a live read here is a coin flip between 199
// and whatever that spec has stored at that instant. Stubbing keeps the pill's
// assertion about the pill (does it render the price it was given) instead of
// about another spec's timing.
async function stubPricing(page, now = 199, was = 239) {
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        store: { now, was },
        // Sale mode ON: these specs assert the struck was-price, which
        // css/tokens.css hides unless /api/pricing reports a live sale.
        sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
        versions: {
          pdf: { enabled: false, price: 79 },
          pickup: { enabled: true, price: 199 },
          delivery: { enabled: false, price: 199 },
          custom: { enabled: false, price: 599 },
        },
      }),
    })
  );
}

async function mockPreview(page) {
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      }),
    })
  );
}

test.describe('order wizard', () => {
  test('preview + design + color recolor work across the first steps', async ({ page }) => {
    await stubPricing(page);
    await page.goto('/options.html?plan=base');

    // Step 1 is the design step: preview visible, plan price reflects base.
    await expect(page.getByTestId('preview')).toBeVisible();
    // The pill sources the store price from /api/pricing (pinned to 199 above).
    await expect(page.getByTestId('plan-price')).toHaveText('199');
    await expect(page.getByTestId('step-1')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('1');
    // On the first step Back is not hidden: it's a "return to store" control
    // (label "חזרה לחנות") that navigates to products.html. Next reads "הבא".
    await expect(page.getByTestId('back-btn')).not.toHaveClass(/is-hidden/);
    await expect(page.getByTestId('back-btn')).toHaveText('חזרה לחנות');
    await expect(page.getByTestId('next-btn')).toHaveText('הבא');

    const designs = page.getByTestId('design-list').locator('.design');
    await expect(designs.nth(1)).toBeVisible();
    const frontPanel = page.getByTestId('preview-front');
    // The tabbed preview shows the design's PICTURE, not an inlined SVG (see
    // previewPicture in js/design-images.js). The palette is still applied to the
    // panel ELEMENT — that is what the fullscreen overlay clones and what the
    // colour-step carousel's artwork inherits — so the --cN plumbing is read off
    // the panel here, and the artwork recolour itself is asserted on the carousel
    // that still inlines SVG (below).
    await expect(frontPanel.locator('img')).toBeVisible();

    // Helper: read --c0 of the front preview panel.
    const readC0 = async () =>
      frontPanel.evaluate((el) => getComputedStyle(el).getPropertyValue('--c0').trim());
    const before = await readC0();

    // Pick the second design on step 1.
    await page.getByTestId('design-1').click();
    await expect(page.getByTestId('design-1')).toHaveAttribute('aria-pressed', 'true');

    // Capture the board face's ORIGINAL --c0 on the design step (tabs are shown
    // here) so the recolor check below can prove it CHANGED after the swatch pick.
    const boardPanel = page.getByTestId('preview-board');
    const readBoardC0 = async () =>
      boardPanel.evaluate((el) => getComputedStyle(el).getPropertyValue('--c0').trim());
    await page.getByTestId('tab-board').click();
    await expect(boardPanel).toHaveAttribute('data-active', 'true');
    const boardBefore = await readBoardC0();
    expect(boardBefore.length).toBeGreaterThan(0);
    // Restore the front face before advancing (the front recolor is read below).
    await page.getByTestId('tab-front').click();

    // Advance to the color step; Back is now available.
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('back-btn')).not.toHaveClass(/is-hidden/);

    // The colour step's carousel inlines the tokenized SVG precisely so the picked
    // colour can be SEEN — reading a panel custom property alone would only prove
    // the plumbing, not that anything on screen changed colour. Snapshot the live
    // artwork's --c0 before the pick.
    const ccArt = page.locator('.cc-slide svg').first();
    await expect(ccArt).toBeVisible();
    const readCcC0 = () =>
      ccArt.evaluate((el) => getComputedStyle(el).getPropertyValue('--c0').trim());
    const ccBefore = await readCcC0();
    expect(ccBefore).toMatch(/^#[0-9a-f]{6}$/i);

    const colors = page.getByTestId('color-list').locator('.swatch');
    await expect(colors.first()).toBeVisible();
    const swatchCount = await colors.count();
    const colorIdx = swatchCount > 1 ? 1 : 0;
    await page.getByTestId('color-' + colorIdx).click();
    await expect(page.getByTestId('color-' + colorIdx)).toHaveAttribute('aria-pressed', 'true');

    // The front preview's --c0 changed from its initial value.
    await expect.poll(async () => readC0()).not.toBe(before);
    // …and so did the artwork the shopper is actually looking at.
    await expect.poll(readCcC0).not.toBe(ccBefore);

    // Selection + step are persisted to the URL (asserted on the colour step).
    expect(page.url()).toContain('plan=base');
    expect(page.url()).toContain('step=2');

    // The board preview recolors too (the preview is live on the early steps).
    // The face tabs are hidden ON the colour step (its swipe carousel replaces
    // them — see options-color-step-tabs.spec.js), so step back to the design
    // step where the tabs are shown and switch to the board face there; the
    // picked colour persists across the nav. Assert the board --c0 actually
    // CHANGED from its pre-pick value (not merely that some --c0 exists).
    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('step-1')).toBeVisible();
    await page.getByTestId('tab-board').click();
    await expect(boardPanel).toHaveAttribute('data-active', 'true');
    await expect.poll(async () => readBoardC0()).not.toBe(boardBefore);
  });

  // The inlined artwork paints its designed background through
  // fill="var(--cN)" presentation attributes, which some engines (older iOS
  // Safari, the Instagram in-app browser) refuse to substitute — so paintSvg()
  // re-drives the fill via a CSS rule carrying the ORIGINAL anchor as the var()
  // fallback. That mechanism now lives ONLY on the colour step's carousel: the
  // tabbed preview above it shows the design's picture (a raster carries its own
  // background and cannot lose it this way). So this covers the carousel, which
  // is where an inlined SVG is still on screen and still recolourable.
  test('the inlined artwork paints its original background (never transparent/black)', async ({
    page,
  }) => {
    await page.goto('/options.html?step=2');

    // Computed fill of the largest painted element in the slide's SVG — the
    // card's designed background. (Elements inside <defs>/<clipPath> are not
    // rendered.) `strip` first removes the live --cN palette from every ancestor,
    // which is how the var()-fallback guard below is exercised.
    const bgFill = async (nth, strip = false) =>
      page
        .locator('.cc-slide svg')
        .nth(nth)
        .evaluate((svg, doStrip) => {
          if (doStrip) {
            for (let n = svg; n; n = n.parentElement) {
              if (n.style) for (let i = 0; i < 8; i++) n.style.removeProperty('--c' + i);
            }
          }
          let best = null;
          let bestArea = -1;
          for (const el of svg.querySelectorAll('path,rect,circle,polygon')) {
            if (el.closest('defs') || el.closest('clipPath') || el.closest('mask')) continue;
            const cs = getComputedStyle(el);
            if (cs.fill === 'none') continue;
            let area = 0;
            try {
              const b = el.getBBox();
              area = b.width * b.height;
            } catch {
              /* not measurable */
            }
            if (area > bestArea) {
              bestArea = area;
              best = cs.fill;
            }
          }
          return best;
        }, strip);

    // A real, visible paint: not missing, not fully transparent, and not the
    // black/unpainted state you get when a var() background fails to resolve.
    const isPainted = (fill) =>
      typeof fill === 'string' &&
      fill !== '' &&
      fill !== 'none' &&
      !/rgba\([^)]*,\s*0\s*\)/.test(fill) &&
      fill !== 'rgb(0, 0, 0)' &&
      fill !== 'transparent';

    // The carousel inlines every view eagerly, so slide 0 is the card and slide 1
    // its back — both on screen without a swipe.
    await expect(page.locator('.cc-slide svg').first()).toBeVisible();
    const frontOrig = await bgFill(0);
    expect(isPainted(frontOrig), `front original background fill: ${frontOrig}`).toBe(true);
    const backOrig = await bgFill(1);
    expect(isPainted(backOrig), `back original background fill: ${backOrig}`).toBe(true);

    // Regression guard for the fix: the background is driven via a CSS `fill`
    // rule whose var() carries the design's ORIGINAL anchor as a fallback, so
    // even if the live --cN palette is missing (e.g. an engine that can't resolve
    // var() in SVG presentation attributes) the original background still paints.
    const frontFallback = await bgFill(0, true);
    expect(isPainted(frontFallback), `front fallback background fill: ${frontFallback}`).toBe(true);
  });

  test('defaults advance through design and color + add-ons', async ({ page }) => {
    await page.goto('/options.html');
    for (const s of [1, 2]) {
      await expect(page.getByTestId('step-' + s)).toBeVisible();
      await expect(page.getByTestId('next-btn')).toBeEnabled();
      await page.getByTestId('next-btn').click();
    }
    // Lands on the name step.
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('3');
  });

  // The plan pill sources the store price from the owner-editable /api/pricing
  // (same shared helper as the storefront), so an admin-set price shows in the
  // wizard too — never a stale hardcoded number.
  test('plan pill reflects an admin-set store price (now + struck was)', async ({ page }) => {
    await page.route('**/api/pricing', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          store: { now: 259, was: 299 },
          // Sale mode ON: these specs assert the struck was-price, which
          // css/tokens.css hides unless /api/pricing reports a live sale.
          sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה' },
          versions: {
            pdf: { enabled: false, price: 79 },
            pickup: { enabled: true, price: 259 },
            delivery: { enabled: false, price: 199 },
            custom: { enabled: false, price: 599 },
          },
        }),
      })
    );
    await page.goto('/options.html?plan=base');
    await expect(page.getByTestId('plan-price')).toHaveText('259');
    await expect(page.locator('#planWas')).toHaveText('299 ₪');
  });

  // Buy-now deep-link (#8a): the product page links every design to
  // options.html?design=<id>&step=2 — the merged colour + add-ons step.
  test('?design=<id>&step=2 preselects the design and jumps to the colour + add-ons step', async ({
    page,
  }) => {
    await page.goto('/options.html?design=birthday&step=2');
    // Landed straight on the colour + add-ons step (design-picking step skipped).
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('2');
    // The requested design is the selected one (birthday = design-2).
    await expect(page.locator('.design[data-design-id="birthday"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // A slider design keeps the colour picker on this step, and the merged step
    // also shows the chasers add-on below it.
    await expect(page.getByTestId('color-list')).toBeVisible();
    await expect(page.getByTestId('chasers-card')).toBeVisible();
  });

  test('step 1 back button returns to the store (products.html)', async ({ page }) => {
    await page.goto('/options.html?plan=base');
    await expect(page.getByTestId('step-1')).toBeVisible();
    // Visible return-to-store control on the first step.
    const backBtn = page.getByTestId('back-btn');
    await expect(backBtn).not.toHaveClass(/is-hidden/);
    await expect(backBtn).toHaveText('חזרה לחנות');
    await backBtn.click();
    await page.waitForURL(/products\.html/);
  });

  test('a fixed-colour design deep-linked to step=2 hides the colour picker but still shows chasers', async ({
    page,
  }) => {
    await stubFixedDesign(page);
    await page.goto(`/options.html?design=${FIXED_ID}&step=2`);
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('2');
    await expect(page.locator(`.design[data-design-id="${FIXED_ID}"]`)).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // fixed-colour: the swatch picker is hidden and the fixed note shows…
    await expect(page.getByTestId('color-list')).toBeHidden();
    await expect(page.getByTestId('raster-note')).toBeVisible();
    // …but the chasers add-on (merged into this step) is still offered.
    await expect(page.getByTestId('chasers-card')).toBeVisible();
    // Stepping Back reaches the design step.
    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('step-1')).toBeVisible();
  });

  test('the RETIRED neon design is gone: no tile, and ?design=neon does not select it', async ({
    page,
  }) => {
    await page.goto('/options.html?design=neon&step=2');
    // no picker tile for it…
    await expect(page.locator('.design[data-design-id="neon"]')).toHaveCount(0);
    // …and the unknown id falls back to a real design rather than selecting nothing
    await expect(page.locator('.design[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.locator('.design[aria-pressed="true"]')).not.toHaveAttribute(
      'data-design-id',
      'neon'
    );
  });

  test('step 3 blocks Next until a title is entered', async ({ page }) => {
    await mockPreview(page);
    await page.goto('/options.html?step=3'); // deep-link straight to the title step
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('next-btn')).toBeDisabled();
    await expect(page.getByTestId('step-3')).toContainText('יודפס על הקלפים');
    await page.fill('#customTitleInput', 'ליאת חוגגת 40');
    await expect(page.getByTestId('next-btn')).toBeEnabled();
  });

  // THE TITLE IS FREE TEXT. It used to be a NAME — one word, letters plus hyphen
  // and apostrophe only, in the language the design demanded — because the theme
  // composed a title around it. The owner removed all of that ("no name no gender
  // only free text title"), so everything that name validation rejected is now
  // perfectly ordinary: digits, spaces, punctuation, either script, two lines.
  // The ONLY thing that still blocks is an emoji, and it blocks for a reason that
  // has nothing to do with names — no card font can draw it.
  test('step 3 accepts any text as a title, and blocks only on an emoji', async ({ page }) => {
    await mockPreview(page);
    await page.goto('/options.html?step=3');
    await expect(page.getByTestId('step-3')).toBeVisible();
    const next = page.getByTestId('next-btn');

    // Every shape the old name rule refused — on an ENGLISH design, which used to
    // refuse Hebrew outright.
    for (const title of [
      'Hadar123',
      'Hadar@',
      'Anne Marie',
      'הדר',
      'ליאת חוגגת 40',
      'החגיגה של\nשירה',
    ]) {
      await page.fill('#customTitleInput', title);
      await expect(next).toBeEnabled();
    }

    // The one refusal left, and it names the character to remove.
    await page.fill('#customTitleInput', 'ליאת חוגגת 40 🎉');
    await expect(page.getByTestId('custom-title-err')).toBeVisible();
    await expect(page.getByTestId('custom-title-err')).toContainText('🎉');
    await expect(next).toBeDisabled();

    // Drop it and the step continues normally.
    await page.fill('#customTitleInput', 'ליאת חוגגת 40');
    await expect(page.getByTestId('custom-title-err')).toBeHidden();
    await expect(next).toBeEnabled();
    await next.click();
    // optional pawn-photos step sits between the title and details steps
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
  });

  test('step 4 validates email + phone, then creates the collection', async ({ page }) => {
    await mockPreview(page);
    await page.goto('/options.html?step=3');
    await page.fill('#customTitleInput', 'Shira');
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();

    // The preview collapses to a summary chip on the contact step.
    await expect(page.getByTestId('continue-summary')).toBeVisible();
    await expect(page.getByTestId('continue-summary')).toContainText('עיצוב');

    // Final button is "צרו את המשחק" and starts disabled (no contact yet).
    const create = page.getByTestId('next-btn');
    await expect(create).toHaveText('צרו את המשחק');
    await expect(create).toBeDisabled();

    // Bad email -> inline email error, still disabled.
    await page.fill('#ownerEmail', 'not-an-email');
    await expect(page.getByTestId('email-err')).toBeVisible();
    await expect(create).toBeDisabled();

    // Valid email, bad phone -> phone error.
    await page.fill('#ownerEmail', 'owner@example.com');
    await expect(page.getByTestId('email-err')).toBeHidden();
    await page.fill('#ownerPhone', '12345');
    await expect(page.getByTestId('phone-err')).toBeVisible();
    await expect(create).toBeDisabled();

    // Valid email + valid IL mobile, and the button is STILL held — the orderer's
    // name is required on this step too now ("make it must to write"), and this
    // test would otherwise read as "the phone was the last thing missing".
    await page.fill('#ownerPhone', '0521234567');
    await expect(page.getByTestId('phone-err')).toBeHidden();
    await expect(create).toBeDisabled();

    // …and with the name, the step is complete: enabled, creates, redirects. The
    // name gate itself is tested in order-buyer-details.spec.js.
    await page.fill('#buyerNameInput', 'דנה כהן');
    await expect(create).toBeEnabled();
    await create.click();
    await page.waitForURL(/collect\.html\?c=.+&k=.+/);
    await expect(page.locator('#title')).toContainText('Shira');
  });

  // Phone validation (#9): iPhone/browser autofill produces shapes like
  // "+972 54-657-7715" or a bare "546577715". These must be accepted (normalized
  // to a local 05X number), not rejected for a missing leading 0.
  test('accepts iPhone-autofill phone formats (+972, spaces/dashes, no leading 0)', async ({
    page,
  }) => {
    await mockPreview(page);
    await page.goto('/options.html?step=3');
    await page.fill('#customTitleInput', 'Shira');
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-pawns')).toBeVisible();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-4')).toBeVisible();
    await page.fill('#ownerEmail', 'owner@example.com');
    // Everything else the step requires, so the only thing the loop below can be
    // measuring is the phone shape (the orderer's name is required now too, and
    // an empty one would hold the button on every iteration).
    await page.fill('#buyerNameInput', 'דנה כהן');

    const create = page.getByTestId('next-btn');
    for (const phone of ['+972 54-657-7715', '+972546577715', '546577715', '054-657-7715']) {
      await page.fill('#ownerPhone', phone);
      await expect(page.getByTestId('phone-err'), phone).toBeHidden();
      await expect(create, phone).toBeEnabled();
    }
  });

  test('Back returns to a prior step and progress reflects position', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.getByTestId('step-now')).toHaveText('1');
    await page.getByTestId('next-btn').click();
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-3')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('3');

    await page.getByTestId('back-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('step-now')).toHaveText('2');
  });

  test('browser Back/Forward walks the wizard via history', async ({ page }) => {
    await page.goto('/options.html');
    await page.getByTestId('next-btn').click(); // -> 2
    await page.getByTestId('next-btn').click(); // -> 3
    await expect(page.getByTestId('step-3')).toBeVisible();

    await page.goBack();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page).toHaveURL(/step=2/);

    await page.goBack();
    await expect(page.getByTestId('step-1')).toBeVisible();

    await page.goForward();
    await expect(page.getByTestId('step-2')).toBeVisible();
  });

  test('chasers add-on toggles in step 2, persists to the URL and survives reload', async ({
    page,
  }) => {
    await page.goto('/options.html');
    await page.getByTestId('next-btn').click(); // -> 2 (colour + add-ons)

    const toggle = page.getByTestId('chasers-toggle');
    const card = page.getByTestId('chasers-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText("הוסיפו צ'ייסרים למשחק");
    await expect(card).toContainText('נכלל בחינם');

    // default OFF
    await expect(toggle).not.toBeChecked();
    expect(page.url()).not.toContain('chasers=');

    // turn it on -> &chasers=1 lands in the URL and the card highlights
    await toggle.check();
    await expect(toggle).toBeChecked();
    await expect.poll(() => page.url()).toContain('chasers=1');
    await expect(card).toHaveClass(/is-on/);

    // survives a reload: restored to step 2 with the add-on on
    await page.reload();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('chasers-toggle')).toBeChecked();

    // turning it off removes the param again
    await page.getByTestId('chasers-toggle').uncheck();
    await expect.poll(() => page.url()).not.toContain('chasers=1');
  });

  test('a slider theme keeps the colour picker and shows no fixed-photo note', async ({ page }) => {
    await page.goto('/options.html');
    // the default design (bachelorette) is a slider whose board embeds a photo.
    await page.getByTestId('next-btn').click(); // -> colour step
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('color-list')).toBeVisible();
    // No caption is shown when picking a colour for a recolourable design.
    await expect(page.getByTestId('raster-note')).toBeHidden();
  });

  test('a FIXED design: the colour picker is hidden and a "colours are fixed" note shows', async ({
    page,
  }) => {
    await stubFixedDesign(page);
    await page.goto('/options.html');
    const fixedTile = page.locator(`.design[data-design-id="${FIXED_ID}"]`);
    await expect(fixedTile).toBeVisible();
    await fixedTile.click();

    await expect(page.getByTestId('preview-front').locator('img').first()).toBeVisible();

    // On the colour step the swatch picker is hidden and a fixed-colour note shows.
    await page.getByTestId('next-btn').click();
    await expect(page.getByTestId('step-2')).toBeVisible();
    await expect(page.getByTestId('color-list')).toBeHidden();
    await expect(page.getByTestId('raster-note')).toBeVisible();
    await expect(page.getByTestId('raster-note')).toContainText('קבוע');
    // …and there is no swatch to press, so nothing can recolour it.
    await expect(page.locator('.swatch').first()).toBeHidden();
  });

  test('selecting a FIXED design after a slider switches the page accent to it (not stale)', async ({
    page,
  }) => {
    await stubFixedDesign(page);
    await page.goto('/options.html');
    const accent = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
      );

    // Pick a slider design + a vivid main colour so the page accent turns that colour.
    // (The preview-stage BACKGROUND deliberately stays neutral and never follows the
    // picked colour — the design's background is part of its identity.)
    await page.locator('.design[data-design-id="bachelorette"]').click();
    await page.getByTestId('next-btn').click(); // colour step
    await page.getByTestId('color-1').click(); // some slider colour
    const sliderAccent = await accent();
    expect(sliderAccent).toMatch(/^#|rgb/);

    // Now switch to the fixed design. Its OWN accent must take over — not the stale
    // slider tint (the regression: empty anchors made recolor() bail before the
    // page theme was set).
    await page.getByTestId('back-btn').click();
    await page.locator(`.design[data-design-id="${FIXED_ID}"]`).click();
    await expect.poll(accent).not.toBe(sliderAccent);
    // and it matches the design's manifest accent
    expect((await accent()).toLowerCase()).toBe(FIXED_ACCENT);
  });

  test('picking a colour does NOT tint the preview stage background (stays the original)', async ({
    page,
  }) => {
    await page.goto('/options.html');
    await page.locator('.design[data-design-id="bachelorette"]').click();
    await page.getByTestId('next-btn').click(); // colour step
    await page.getByTestId('color-1').click(); // a vivid slider colour

    // The stage no longer uses a colour-following --cfg-bg — it stays var(--bg). The
    // var must be unset so the background behind the product reads as its original.
    const cfgBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--cfg-bg').trim()
    );
    expect(cfgBg).toBe('');
  });

  test('design tiles use lightweight <img> thumbnails, not inlined full-page SVGs', async ({
    page,
  }) => {
    await page.goto('/options.html?step=1');
    await expect(page.locator('.design').first()).toBeVisible();
    const c = await page.evaluate(() => ({
      tiles: document.querySelectorAll('.design').length,
      imgs: document.querySelectorAll('.design .thumb img').length,
      svgs: document.querySelectorAll('.design .thumb svg').length,
    }));
    expect(c.tiles).toBeGreaterThan(0);
    // every tile is a small raster thumbnail; none inline a heavy full-page SVG.
    expect(c.imgs).toBe(c.tiles);
    expect(c.svgs).toBe(0);
    await expect(page.locator('.design .thumb img').first()).toHaveAttribute(
      'src',
      /thumb-front\.webp$/
    );
  });

  test('a fast design A→B switch never lets A stale-write into the shared preview', async ({
    page,
  }) => {
    // DELAY design A (marriage) so its picture arrives only AFTER we have switched
    // to B. A slow picture landing on the wrong design is exactly the hazard
    // renderEpoch exists for.
    await page.route('**/assets/designs/marriage/gallery-front.webp', async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.fallback();
    });
    await page.goto('/options.html?step=1');
    await expect(page.getByTestId('preview-front').locator('img')).toBeVisible();

    // Click A (marriage, slow) then immediately B (birthday, fast).
    await page.locator('.design[data-design-id="marriage"]').click();
    await page.locator('.design[data-design-id="birthday"]').click();

    // Wait well past A's delay so its late load has fired.
    await page.waitForTimeout(1100);

    // The panel must show B (birthday), NOT A's late artwork.
    const shown = await page.locator('[data-panel="front"] img').getAttribute('src');
    expect(shown).toBe('assets/designs/birthday/gallery-front.webp');
    await expect(page.locator('.design[data-design-id="birthday"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});
