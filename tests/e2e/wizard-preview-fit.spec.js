import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';

// The e2e server defaults every buyer-wizard feature flag OFF; this spec relies
// on the (now gated) wizard features, so stub GET /api/features to ALL_ON — the
// pre-flag behaviour. Declared first so the route is registered before any
// navigation in this file's other hooks/tests.
test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// Regression cover for the FULL 8-card deck preview, after the "bigger preview
// box" change. Invariants:
//  1. The live sheet is the DOMINANT focal element: it fills the preview card's
//     width (no longer a height-shrunk sliver) on desktop AND phone.
//  2. Box size now takes priority over strict no-scroll where they conflict, so a
//     wide/short viewport MAY scroll — but the fixed Back/Next bar must ALWAYS
//     stay reachable (the portrait-phone no-scroll guarantee still lives in
//     wizard-noscroll.spec.js, which forces a tall 390x844 viewport).
//  3. Every present product tab (front / back / board) renders a LANDSCAPE A4
//     page (~1.414:1) at a readable size; a board-less theme (kids) has no board
//     tab but its front/back preview still enlarges.

const LAPTOP = { width: 1366, height: 768 };
const LANDSCAPE = { width: 960, height: 480 };
const DESKTOP_MID = { width: 1440, height: 900 };

// The box is prioritised over strict no-scroll, so these wide/short viewports MAY
// scroll now. The invariant that must actually hold — and that a real regression
// (content overflowing and covering Next) would break — is that the Next button
// is HITTABLE: within the viewport AND the topmost element at its centre (not
// covered by overflowing content or a stray overlay). This is a meaningful check,
// unlike asserting a position:fixed bar's own rect is on-screen (always true).
async function assertNextHittable(page) {
  await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));
  const hit = await page.evaluate(() => {
    const btn = document.getElementById('nextBtn');
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(r.top + r.height / 2)
    );
    return {
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight + 1,
      hitsButton: !!(el && (el === btn || btn.contains(el))),
    };
  });
  expect(hit.inViewport).toBe(true);
  expect(hit.hitsButton).toBe(true);
}

test.describe('order wizard keeps Next hittable on wide/short screens', () => {
  // viewport-specific layout checks — run once, on a single project.
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'Desktop Chrome',
      'viewport-specific layout checks run once'
    );
  });

  for (const [label, viewport] of [
    ['laptop', LAPTOP],
    ['landscape', LANDSCAPE],
    ['mid-height desktop', DESKTOP_MID],
  ]) {
    test.describe(`on a ${label} screen`, () => {
      for (const step of [1, 2, 3, 4]) {
        test(`step ${step}: Next is not covered and stays clickable`, async ({ page }) => {
          await page.setViewportSize(viewport);
          await page.goto('/options.html?step=' + step);
          await expect(page.getByTestId('step-' + step)).toBeVisible();
          await assertNextHittable(page);
        });
      }
    });

    test(`on a ${label} screen: clicking Next actually advances the wizard`, async ({ page }) => {
      // The real behavioural check — Next isn't just present/uncovered, it works
      // and moves the wizard forward through the preview-heavy steps.
      await page.setViewportSize(viewport);
      await page.goto('/options.html?step=1');
      await expect(page.getByTestId('step-1')).toBeVisible();
      await page.getByTestId('next-btn').click();
      await expect(page.getByTestId('step-2')).toBeVisible();
      await page.getByTestId('next-btn').click();
      await expect(page.getByTestId('step-3')).toBeVisible();
    });
  }
});

test.describe('every product tab is a readable landscape page', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== 'Desktop Chrome',
      'viewport-specific layout checks run once'
    );
  });

  // measure the active panel's svg against its stage.
  async function measureActive(page, panel) {
    return page.evaluate((p) => {
      const stage = document.querySelector('.preview-stage').getBoundingClientRect();
      const svg = document.querySelector(`[data-panel="${p}"] svg`).getBoundingClientRect();
      return {
        ratio: svg.width / svg.height,
        widthFraction: svg.width / stage.width,
        heightFits: svg.height <= stage.height + 2,
      };
    }, panel);
  }

  for (const tab of ['front', 'back', 'board']) {
    test(`the ${tab} tab shows a landscape svg filling most of the stage`, async ({ page }) => {
      await page.setViewportSize(LAPTOP);
      await page.goto('/options.html?step=1');
      await expect(page.getByTestId('preview-front').locator('svg')).toBeVisible();

      await page.getByTestId('tab-' + tab).click();
      const p = page.getByTestId('preview-' + tab);
      await expect(p).toHaveAttribute('data-active', 'true');
      await expect(p.locator('svg')).toBeVisible();

      const m = await measureActive(page, tab);
      // landscape (clearly wider than tall) — a crushed/portrait page would be < 1.
      expect(m.ratio).toBeGreaterThan(1.15);
      // fills most of the stage width, so the 8 cards stay readable...
      expect(m.widthFraction).toBeGreaterThan(0.6);
      // ...and is contained within the stage height (not clipped/overflowing).
      expect(m.heightFits).toBe(true);
    });
  }

  test('a board-less theme (kids) has no board tab, but front/back still work', async ({
    page,
  }) => {
    await page.setViewportSize(LAPTOP);
    await page.goto('/options.html?step=1');
    await page.locator('.design[data-design-id="kids"]').click();

    await expect(page.getByTestId('tab-board')).toBeHidden();
    await expect(page.getByTestId('tab-front')).toBeVisible();
    await expect(page.getByTestId('tab-back')).toBeVisible();

    await expect(page.getByTestId('preview-front').locator('svg')).toBeVisible();
    await page.getByTestId('tab-back').click();
    await expect(page.getByTestId('preview-back')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('preview-back').locator('svg')).toBeVisible();
  });
});

// ---- the preview fills the card width on a PHONE (iPhone 14) ----
test.describe('the live sheet fills the card width on a phone', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name === 'Desktop Chrome', 'phone width-fill check');
  });

  async function sheetMetrics(page) {
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));
    return page.evaluate(() => {
      const svg = document.querySelector('.preview-panel[data-active="true"] svg');
      const card = document.getElementById('previewCard');
      const cs = getComputedStyle(card);
      const inner = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const w = svg.getBoundingClientRect().width;
      return { w, inner, ratio: +(w / inner).toFixed(3), vw: window.innerWidth };
    });
  }

  test('the sheet fills ~all of the card width and spans most of the screen', async ({ page }) => {
    await page.goto('/options.html');
    const m = await sheetMetrics(page);
    // fills nearly the whole card (edge-to-edge), not a height-shrunk sliver
    expect(m.ratio).toBeGreaterThanOrEqual(0.9);
    // and is the dominant focal element: ~0.85+ of the phone's width
    expect(m.w / m.vw).toBeGreaterThanOrEqual(0.85);
  });

  test('kids has no board tab, and its preview still fills the width', async ({ page }) => {
    await page.goto('/options.html?design=kids');
    await expect(page.getByTestId('tab-board')).toBeHidden();
    const m = await sheetMetrics(page);
    expect(m.ratio).toBeGreaterThanOrEqual(0.9);
  });

  // Regression: the preview must RESERVE its box up-front so it doesn't reflow the
  // heading/tiles below when the (lazy, multi-MB) SVG lands. We block the SVG so
  // the panel stays empty, read its reserved height, then compare it to the final
  // rendered height — they must match (no jump).
  test('the preview reserves its box (no reflow when the SVG loads)', async ({ page }) => {
    await page.goto('/options.html');
    await expect(page.locator('.preview-panel[data-active="true"] svg')).toBeVisible();
    await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));
    const loaded = await page.evaluate(() =>
      Math.round(
        document.querySelector('.preview-panel[data-active="true"]').getBoundingClientRect().height
      )
    );

    // now block the deck SVGs so the active panel stays empty on a fresh load…
    await page.route('**/designs/**/*.svg', (r) => r.abort());
    await page.goto('/options.html');
    await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));
    const reserved = await page.evaluate(() =>
      Math.round(
        document.querySelector('.preview-panel[data-active="true"]').getBoundingClientRect().height
      )
    );

    // …the empty slot already occupies a real landscape box (not ~0)…
    expect(reserved).toBeGreaterThan(120);
    // …and it matches the final height, so nothing shifts when the SVG lands.
    expect(Math.abs(reserved - loaded)).toBeLessThanOrEqual(24);
  });
});
