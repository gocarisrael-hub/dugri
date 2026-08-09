import { test, expect } from '@playwright/test';

// The 4-step order explainer (site/js/start-explainer.js): a FULL-PAGE briefing
// that precedes the order wizard. It must
//   - open instead of navigating, from every CTA that enters the wizard,
//   - never block the purchase: continue carries the trigger's own href, query
//     params (?design=…&step=2) included,
//   - close by X / Escape / backdrop and hand focus back to the trigger,
//   - trap focus and lock background scroll while open,
//   - and fit a phone in ONE PAGE, with the continue CTA at the foot of it.
//
// One page, one button (owner's call). The briefing used to scroll and carried a
// second copy of the CTA above the steps; both the copy and the scroll are gone, and
// the tests below pin that — a returning top CTA, or a sheet that needs scrolling to
// reach the button, is a regression.

const OVERLAY = 'start-explainer';
const CLOSE = 'start-explainer-close';
const CONTINUE = 'start-explainer-continue';

// The sheet enters with a 9px translateY (keyframes sx-rise). A transform on the
// scroll container's child counts toward its SCROLLABLE OVERFLOW, so measuring
// height mid-animation reports up to 9px that no reader ever sees — which reads
// exactly like a briefing that doesn't fit. Every height assertion waits this out
// first. Nothing else needs it: positions settle to the same place either way.
async function animationsSettled(page) {
  await page.waitForFunction(() => {
    const inner = document.querySelector('.sx-inner');
    if (!inner || !inner.getAnimations) return true;
    return inner.getAnimations().every((a) => a.playState !== 'running');
  });
}

// Assert the exact URL the explainer HANDS OFF to, captured from the navigation
// request itself. Asserting page.url() afterwards would race the wizard, which
// normalises its own query on arrival (…&step=2 becomes …&step=3&plan=…&color=… as
// soon as it restores state) — the handoff is what this feature owns.
async function continueTo(page, expectedSearch) {
  const target = page.getByTestId(CONTINUE);
  await target.scrollIntoViewIfNeeded();
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.isNavigationRequest() && r.url().includes('options.html')),
    target.click(),
  ]);
  expect(new URL(req.url()).search).toBe(expectedSearch);
}

test.describe('the 4-step explainer on the product page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    // product.js rewrites the CTA once ?design resolves — wait for the real href.
    await expect
      .poll(() => page.getByTestId('pdp-buy').getAttribute('href'))
      .toBe('options.html?design=bachelorette&step=2');
  });

  test('the buy CTA is renamed and opens the explainer instead of navigating', async ({ page }) => {
    const buy = page.getByTestId('pdp-buy');
    await expect(buy).toHaveText('מתחילים לבנות את המשחק ›');
    // The old wording is gone from the page entirely.
    await expect(page.locator('body')).not.toContainText('קנו עכשיו');

    await expect(page.getByTestId(OVERLAY)).toHaveCount(0); // not built until asked for
    await buy.click();

    const overlay = page.getByTestId(OVERLAY);
    await expect(overlay).toBeVisible();
    // It intercepted the click: still on the product page.
    await expect(page).toHaveURL(/product\.html\?design=bachelorette/);
    await expect(overlay).toHaveAttribute('role', 'dialog');
    await expect(overlay).toHaveAttribute('aria-modal', 'true');
    await expect(overlay).toHaveAttribute('aria-labelledby', 'sxTitle');
  });

  test('it covers the whole viewport, not a small centred modal', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
    const overlay = page.getByTestId(OVERLAY);
    await expect(overlay).toBeVisible();

    const box = await overlay.boundingBox();
    const vp = page.viewportSize();
    expect(box.width).toBeGreaterThanOrEqual(vp.width - 1);
    expect(box.height).toBeGreaterThanOrEqual(vp.height - 1);
    expect(box.x).toBeLessThanOrEqual(1);
    expect(box.y).toBeLessThanOrEqual(1);
  });

  test('all four stages are explained, in order, with her content', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
    const steps = page.getByTestId('start-explainer-step');
    await expect(steps).toHaveCount(4);

    await expect(steps.nth(0)).toContainText('התאמה אישית');
    // The soft-launch aside lives on step 1.
    await expect(steps.nth(0)).toContainText('הרצה');
    await expect(steps.nth(0)).toContainText('וואטסאפ');
    await expect(steps.nth(1)).toContainText('4 תמונות');
    await expect(steps.nth(1)).toContainText('פיונים');
    await expect(steps.nth(2)).toContainText('פרטי קשר');
    await expect(steps.nth(2)).toContainText('להתחיל את המסיבה לפני שהיא התחילה');
    await expect(steps.nth(3)).toContainText('אוספים מילים');

    // Step 4's WhatsApp link is the site's one number.
    const wa = page.getByTestId('start-explainer-wa');
    await expect(wa).toHaveAttribute('href', 'https://wa.me/972546577715');

    // Brand rule: never the trademarked word.
    await expect(page.getByTestId(OVERLAY)).not.toContainText('אליאס');
  });

  test('continue enters the wizard with the design preselection intact', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
    const go = page.getByTestId(CONTINUE);
    // The trigger's LIVE href (design + step) is what the button carries.
    await expect(go).toHaveAttribute('href', 'options.html?design=bachelorette&step=2');
    await continueTo(page, '?design=bachelorette&step=2');
  });

  test('there is exactly ONE continue button, and no top copy', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
    await expect(page.locator('[data-sx-continue]')).toHaveCount(1);
    // The old top copy and the placement tag that told the two apart are both gone.
    await expect(page.getByTestId('start-explainer-continue-bottom')).toHaveCount(0);
    await expect(page.locator('[data-sx-place]')).toHaveCount(0);
  });

  // "One pager, button only at the bottom" (owner's call). Pinned in DOM order AND in
  // geometry: the CTA is the last block on the sheet, it is on the FIRST screen with
  // no scrolling, and nothing is hidden below the fold.
  test('the whole briefing is one page, with the CTA last and in view', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
    const overlay = page.getByTestId(OVERLAY);
    await expect(overlay).toBeVisible();
    await animationsSettled(page);

    // DOM order: title → steps → CTA, with nothing after it.
    const order = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="start-explainer"]');
      const nodes = [...root.querySelectorAll('*')];
      const steps = [...root.querySelectorAll('[data-testid="start-explainer-step"]')];
      const cta = root.querySelector('[data-sx-continue]');
      return {
        title: nodes.indexOf(root.querySelector('#sxTitle')),
        cta: nodes.indexOf(cta),
        firstStep: nodes.indexOf(steps[0]),
        lastStep: nodes.indexOf(steps[steps.length - 1]),
        ctaIsLastBlock: root.querySelector('.sx-inner').lastElementChild.contains(cta),
      };
    });
    expect(order.title).toBeGreaterThan(-1);
    expect(order.firstStep).toBeGreaterThan(order.title);
    expect(order.cta).toBeGreaterThan(order.lastStep);
    expect(order.ctaIsLastBlock).toBe(true);

    // Geometry: the button is on screen the moment the sheet opens, with nobody
    // scrolling — that is what "one pager" means here.
    const ctaBox = await page.getByTestId(CONTINUE).boundingBox();
    const lastStepBox = await page.getByTestId('start-explainer-step').last().boundingBox();
    expect(ctaBox.y).toBeGreaterThan(lastStepBox.y);
    expect(ctaBox.y + ctaBox.height).toBeLessThanOrEqual(page.viewportSize().height);
    expect(await page.evaluate(() => document.getElementById('startExplainer').scrollTop)).toBe(0);
  });

  // Read the sheet's fit + the CTA's position at an arbitrary viewport. Playwright's
  // device presets only carry the URL-BAR-VISIBLE height (iPhone 14 is 390x664 even
  // though the screen is 390x844), so pinning the layout to the project viewport
  // alone tests one narrow band and misses the phone as it is actually held.
  async function measureAt(page, width, height) {
    await page.setViewportSize({ width, height });
    await page.getByTestId('pdp-buy').click();
    await expect(page.getByTestId(OVERLAY)).toBeVisible();
    await animationsSettled(page);
    return page.evaluate(() => {
      const o = document.getElementById('startExplainer');
      const cta = o.querySelector('.sx-go').getBoundingClientRect();
      return {
        need: o.scrollHeight,
        have: o.clientHeight,
        ctaTop: Math.round(cta.top),
        ctaBottom: Math.round(cta.bottom),
        vh: window.innerHeight,
        scrollTop: o.scrollTop,
      };
    });
  }

  // THE hard guarantee. One CTA at the foot is only safe if it is never below the
  // fold, so this sweeps the shapes that used to break it — a phone at its real
  // full height, a small legacy phone, landscape, and a short desktop window — and
  // demands the button be fully visible on open at every one. `position:sticky`
  // on .sx-cta is what holds this up where the briefing itself cannot fit.
  const VIEWPORTS = [
    [390, 844, 'iPhone 14, URL bar collapsed'],
    [393, 852, 'iPhone 15'],
    [412, 915, 'Pixel 7'],
    [360, 780, 'Galaxy'],
    [320, 568, 'iPhone SE (1st gen)'],
    [375, 667, 'iPhone SE (2nd gen)'],
    [844, 390, 'phone in landscape'],
    [1280, 400, 'short desktop window'],
    [1280, 720, 'laptop'],
  ];
  for (const [w, h, label] of VIEWPORTS) {
    test(`the continue button is fully on screen at ${w}x${h} (${label})`, async ({ page }) => {
      const m = await measureAt(page, w, h);
      expect(m.scrollTop, 'the sheet opens at the top').toBe(0);
      expect(m.ctaTop, `CTA top is above the viewport at ${w}x${h}`).toBeGreaterThanOrEqual(-1);
      expect(
        m.ctaBottom,
        `CTA bottom is ${m.ctaBottom - m.vh}px below the fold at ${w}x${h}`
      ).toBeLessThanOrEqual(m.vh + 1);
    });
  }

  // …and the one-page promise itself, on the screens it is made for: a modern phone
  // held upright, and any desktop. The short/legacy/landscape sizes above are
  // deliberately absent — this much Hebrew cannot be set readably in 400px of
  // height, and the sticky CTA is what covers them instead.
  const ONE_PAGE = [
    [390, 844, 'iPhone 14, URL bar collapsed'],
    [393, 852, 'iPhone 15'],
    [412, 915, 'Pixel 7'],
    [1280, 720, 'laptop'],
    [1440, 900, 'desktop'],
  ];
  for (const [w, h, label] of ONE_PAGE) {
    test(`the whole briefing fits one screen at ${w}x${h} (${label})`, async ({ page }) => {
      const m = await measureAt(page, w, h);
      // 2px of slack absorbs sub-pixel rounding on the step borders.
      expect(
        m.need,
        `the briefing needs ${m.need}px but the screen has ${m.have}px at ${w}x${h}`
      ).toBeLessThanOrEqual(m.have + 2);
    });
  }

  // The safety valve, asserted rather than assumed: where the briefing genuinely
  // cannot fit, the overlay DOES scroll (overflow-y:auto is doing its job) and the
  // pinned CTA rides above that scroll instead of scrolling away with the steps.
  test('where it cannot fit, the sheet scrolls and the CTA stays pinned', async ({ page }) => {
    const m = await measureAt(page, 844, 390);
    expect(m.need, 'landscape should overflow — this test is pointless if it fits').toBeGreaterThan(
      m.have
    );
    expect(m.ctaBottom).toBeLessThanOrEqual(m.vh + 1);

    // Scroll to the very end: the button is still there, not left behind at the foot
    // of a long sheet.
    await page.evaluate(() => {
      const o = document.getElementById('startExplainer');
      o.scrollTop = o.scrollHeight;
    });
    const after = await page.evaluate(() => {
      const o = document.getElementById('startExplainer');
      const cta = o.querySelector('.sx-go').getBoundingClientRect();
      return { top: Math.round(cta.top), bottom: Math.round(cta.bottom), vh: window.innerHeight };
    });
    expect(after.top).toBeGreaterThanOrEqual(-1);
    expect(after.bottom).toBeLessThanOrEqual(after.vh + 1);
  });

  test('the CTA and the X are separate, non-overlapping targets', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
    // Each boundingBox() below is its own round-trip, so mid-animation the first box
    // is read 9px lower than the last — which fabricates an overlap that never
    // renders. Settle first, then measure them all against the same frame.
    await animationsSettled(page);
    const x = await page.getByTestId(CLOSE).boundingBox();
    const cta = await page.getByTestId(CONTINUE).boundingBox();
    const title = await page.locator('#sxTitle').boundingBox();

    const overlaps = (a, b) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    expect(overlaps(x, cta), 'the X overlaps the continue CTA').toBe(false);
    expect(overlaps(x, title), 'the X overlaps the title').toBe(false);
    expect(overlaps(cta, title), 'the CTA overlaps the title').toBe(false);
    // The X is up in its own corner, well clear of the CTA (the whole head sits
    // between them) — not a crowded two-button row on a phone.
    expect(cta.y).toBeGreaterThan(x.y + x.height);
  });

  test('the X closes it and returns focus to the trigger', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
    await expect(page.getByTestId(OVERLAY)).toBeVisible();
    // Focus moved into the overlay on open.
    await expect(page.getByTestId(CLOSE)).toBeFocused();

    await page.getByTestId(CLOSE).click();
    await expect(page.getByTestId(OVERLAY)).toBeHidden();
    await expect(page.getByTestId('pdp-buy')).toBeFocused();
    await expect(page).toHaveURL(/product\.html/); // never navigated
  });

  test('Escape closes it and returns focus to the trigger', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
    await expect(page.getByTestId(OVERLAY)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(OVERLAY)).toBeHidden();
    await expect(page.getByTestId('pdp-buy')).toBeFocused();
  });

  test('background scroll is locked while open and released on close', async ({ page }) => {
    const locked = () =>
      page.evaluate(() => document.documentElement.classList.contains('sx-locked'));
    await page.getByTestId('pdp-buy').click();
    await expect(page.getByTestId(OVERLAY)).toBeVisible();
    expect(await locked()).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(OVERLAY)).toBeHidden();
    expect(await locked()).toBe(false);
  });

  test('focus is trapped inside the overlay and cycles through its controls', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
    // Focus still lands on the X on open — the sheet announces itself before the
    // reader is handed the primary action.
    await expect(page.getByTestId(CLOSE)).toBeFocused();

    const where = () =>
      page.evaluate(() => {
        const overlay = document.querySelector('[data-testid="start-explainer"]');
        const el = document.activeElement;
        return {
          inside: !!(overlay && el && overlay.contains(el)),
          testid: el ? el.getAttribute('data-testid') : null,
        };
      });

    // Tab all the way round. Focus never escapes, and one full cycle visits the X
    // and the continue button.
    const seen = new Set();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const w = await where();
      expect(w.inside, `focus escaped after ${i + 1} tab(s)`).toBe(true);
      if (w.testid) seen.add(w.testid);
    }
    expect([...seen]).toEqual(expect.arrayContaining([CLOSE, CONTINUE]));

    // Shift+Tab stays inside too.
    await page.keyboard.press('Shift+Tab');
    expect((await where()).inside).toBe(true);
  });

  test('a modified click is left to the browser (open in a new tab still works)', async ({
    page,
  }) => {
    // Ctrl/⌘-click must NOT be swallowed by the explainer.
    const opened = await page.evaluate(() => {
      const a = document.querySelector('[data-testid="pdp-buy"]');
      const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
      a.dispatchEvent(ev);
      return {
        prevented: ev.defaultPrevented,
        overlay: !!document.querySelector('[data-testid="start-explainer"].is-open'),
      };
    });
    expect(opened.prevented).toBe(false);
    expect(opened.overlay).toBe(false);
  });
});

test.describe('the explainer guards the other wizard entrances', () => {
  test("the homepage menu's order link opens it and continues to the bare wizard", async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.getByTestId('nav-toggle').click();
    await page.getByTestId('nav-order-flow').click();

    await expect(page.getByTestId(OVERLAY)).toBeVisible();
    await expect(page).toHaveURL(/index\.html/);
    // The bare wizard link here — there is no design to preselect.
    await expect(page.getByTestId(CONTINUE)).toHaveAttribute('href', 'options.html');
    await continueTo(page, '');
  });

  test('CTAs that only reach the SHOP are left alone (no briefing there)', async ({ page }) => {
    await page.goto('/index.html');
    // The header's order-now goes to products.html — the gallery, not the wizard.
    await page.getByTestId('order-now').click();
    await expect(page).toHaveURL(/products\.html/);
    await expect(page.getByTestId(OVERLAY)).toHaveCount(0);
  });
});

test.describe('the explainer on a phone', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'iPhone 14', 'phone-only layout check runs once');
  });

  test('the whole briefing fits one phone screen, CTA included', async ({ page }) => {
    await page.goto('/product.html?design=bachelorette');
    // Wait for product.js to stamp the design onto the CTA before opening — the
    // explainer reads the trigger's href at open time, so clicking earlier would
    // legitimately carry the not-yet-resolved bare `options.html`.
    await expect
      .poll(() => page.getByTestId('pdp-buy').getAttribute('href'))
      .toBe('options.html?design=bachelorette&step=2');
    await page.getByTestId('pdp-buy').click();
    const overlay = page.getByTestId(OVERLAY);
    await expect(overlay).toBeVisible();
    await animationsSettled(page);

    const vp = page.viewportSize();
    const box = await overlay.boundingBox();
    // Full-bleed on the phone too, and no horizontal overflow.
    expect(box.width).toBeLessThanOrEqual(vp.width + 1);
    const overflowsX = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(overflowsX).toBe(false);

    // The CTA is on the first screen with NO scrolling at all — on a phone, which is
    // the screen the one-page fit has to survive. Assert it before touching scroll.
    const go = page.getByTestId(CONTINUE);
    const goBox = await go.boundingBox();
    expect(goBox.y).toBeGreaterThanOrEqual(0);
    expect(goBox.y + goBox.height).toBeLessThanOrEqual(vp.height + 1);
    // It is also the element that actually receives the tap at that point (nothing
    // is layered over it) …
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return !!(el && el.closest('[data-testid="start-explainer-continue"]'));
      },
      [goBox.x + goBox.width / 2, goBox.y + goBox.height / 2]
    );
    expect(hit, 'something is layered over the continue CTA').toBe(true);

    // …and there is nothing to scroll TO: the whole briefing FITS the phone. This is
    // the assertion the dvh type scale exists for — if the four steps ever outgrow
    // the screen again it fails here, not on the owner's phone.
    const fit = await page.evaluate(() => {
      const o = document.getElementById('startExplainer');
      return { scrollHeight: o.scrollHeight, clientHeight: o.clientHeight };
    });
    expect(
      fit.scrollHeight,
      `the briefing must fit one phone screen (needs ${fit.scrollHeight}px, has ${fit.clientHeight}px)`
    ).toBeLessThanOrEqual(fit.clientHeight + 2);

    // All four steps are on that one screen too — fitting by pushing step 4 under the
    // fold would satisfy the height check without satisfying the ask.
    const lastStepBox = await page.getByTestId('start-explainer-step').last().boundingBox();
    expect(lastStepBox.y + lastStepBox.height).toBeLessThanOrEqual(vp.height + 1);
    expect(goBox.y, 'the CTA sits after the last step').toBeGreaterThan(lastStepBox.y);

    await continueTo(page, '?design=bachelorette&step=2');
  });
});
