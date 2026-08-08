import { test, expect } from '@playwright/test';

// The 4-step order explainer (site/js/start-explainer.js): a FULL-PAGE briefing
// that precedes the order wizard. It must
//   - open instead of navigating, from every CTA that enters the wizard,
//   - never block the purchase: continue carries the trigger's own href, query
//     params (?design=…&step=2) included,
//   - close by X / Escape / backdrop and hand focus back to the trigger,
//   - trap focus and lock background scroll while open,
//   - and fit a phone, where the continue CTA must stay reachable.
//
// The continue CTA is rendered TWICE — above the steps and after them. Both are the
// same button: same handler, same live href. Every "does continue work" assertion
// below runs against BOTH so they can never drift apart.

const OVERLAY = 'start-explainer';
const CLOSE = 'start-explainer-close';
const CONTINUE = 'start-explainer-continue'; // the top copy
const CONTINUE_BOTTOM = 'start-explainer-continue-bottom';
const BOTH_CONTINUE = [CONTINUE, CONTINUE_BOTTOM];

// Assert the exact URL the explainer HANDS OFF to, captured from the navigation
// request itself. Asserting page.url() afterwards would race the wizard, which
// normalises its own query on arrival (…&step=2 becomes …&step=3&plan=…&color=… as
// soon as it restores state) — the handoff is what this feature owns.
async function continueTo(page, expectedSearch, testid = CONTINUE) {
  const target = page.getByTestId(testid);
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

  // Each copy is tested on its own: both must carry the live href and both must hand
  // the SAME query off to the wizard. A regression that wires only one would pass a
  // single-button test.
  for (const which of BOTH_CONTINUE) {
    test(`continue (${which}) enters the wizard with the design preselection intact`, async ({
      page,
    }) => {
      await page.getByTestId('pdp-buy').click();
      const go = page.getByTestId(which);
      // The trigger's LIVE href (design + step) is what the button carries.
      await expect(go).toHaveAttribute('href', 'options.html?design=bachelorette&step=2');
      await continueTo(page, '?design=bachelorette&step=2', which);
    });
  }

  test('there are exactly two continue buttons and they are identical in job', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
    const both = page.locator('[data-sx-continue]');
    await expect(both).toHaveCount(2);

    // Same destination, same label, same editable key — one button shown twice.
    const shape = await both.evaluateAll((els) =>
      els.map((e) => ({
        href: e.getAttribute('href'),
        text: e.textContent.trim(),
        key: e.getAttribute('data-edit'),
        place: e.getAttribute('data-sx-place'),
      }))
    );
    expect(shape[0].href).toBe(shape[1].href);
    expect(shape[0].text).toBe(shape[1].text);
    expect(shape[0].key).toBe(shape[1].key);
    // …and only their placement tag differs, which is what analytics reports.
    expect(shape.map((s) => s.place)).toEqual(['top', 'bottom']);
  });

  // The owner asked for a CTA at the TOP (act without reading) AND one at the bottom
  // (act after reading). Pinned in DOM order AND geometry so a later refactor cannot
  // quietly drop or move either.
  test('one continue comes BEFORE the four steps and one AFTER, in the DOM and on screen', async ({
    page,
  }) => {
    await page.getByTestId('pdp-buy').click();
    const overlay = page.getByTestId(OVERLAY);
    await expect(overlay).toBeVisible();

    // DOM order: title → top CTA → steps → bottom CTA.
    const order = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="start-explainer"]');
      const nodes = [...root.querySelectorAll('*')];
      const steps = [...root.querySelectorAll('[data-testid="start-explainer-step"]')];
      return {
        title: nodes.indexOf(root.querySelector('#sxTitle')),
        top: nodes.indexOf(root.querySelector('[data-testid="start-explainer-continue"]')),
        bottom: nodes.indexOf(
          root.querySelector('[data-testid="start-explainer-continue-bottom"]')
        ),
        firstStep: nodes.indexOf(steps[0]),
        lastStep: nodes.indexOf(steps[steps.length - 1]),
      };
    });
    expect(order.title).toBeGreaterThan(-1);
    expect(order.top).toBeGreaterThan(order.title);
    expect(order.top).toBeLessThan(order.firstStep);
    expect(order.bottom).toBeGreaterThan(order.lastStep);

    // Geometry: top CTA between the title and the first step, on the first screen
    // with no scrolling; bottom CTA below the last step.
    const topBox = await page.getByTestId(CONTINUE).boundingBox();
    const bottomBox = await page.getByTestId(CONTINUE_BOTTOM).boundingBox();
    const titleBox = await page.locator('#sxTitle').boundingBox();
    const steps = page.getByTestId('start-explainer-step');
    const firstStepBox = await steps.first().boundingBox();
    const lastStepBox = await steps.last().boundingBox();

    expect(topBox.y).toBeGreaterThan(titleBox.y);
    expect(topBox.y).toBeLessThan(firstStepBox.y);
    expect(topBox.y + topBox.height).toBeLessThanOrEqual(page.viewportSize().height);
    expect(await page.evaluate(() => document.getElementById('startExplainer').scrollTop)).toBe(0);

    expect(bottomBox.y).toBeGreaterThan(lastStepBox.y);
  });

  test('the CTA and the X are separate, non-overlapping targets', async ({ page }) => {
    await page.getByTestId('pdp-buy').click();
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

  test('focus is trapped inside the overlay and cycles through BOTH continue buttons', async ({
    page,
  }) => {
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
    // and both continue buttons.
    const seen = new Set();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const w = await where();
      expect(w.inside, `focus escaped after ${i + 1} tab(s)`).toBe(true);
      if (w.testid) seen.add(w.testid);
    }
    expect([...seen]).toEqual(expect.arrayContaining([CLOSE, CONTINUE, CONTINUE_BOTTOM]));

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
    // Both copies carry the bare wizard link here (no design to preselect).
    for (const which of BOTH_CONTINUE) {
      await expect(page.getByTestId(which)).toHaveAttribute('href', 'options.html');
    }
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

  test('the sheet scrolls internally and the continue CTA is reachable', async ({ page }) => {
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

    const vp = page.viewportSize();
    const box = await overlay.boundingBox();
    // Full-bleed on the phone too, and no horizontal overflow.
    expect(box.width).toBeLessThanOrEqual(vp.width + 1);
    const overflowsX = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    expect(overflowsX).toBe(false);

    // The CTA is on the first screen with NO scrolling at all — that is the point
    // of moving it above the steps. Assert it before touching the scroll position.
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

    // …and the sheet still scrolls internally for the steps below it.
    const scrollable = await page.evaluate(() => {
      const o = document.getElementById('startExplainer');
      return o.scrollHeight > o.clientHeight;
    });
    expect(scrollable, 'the sheet should scroll internally on a phone').toBe(true);

    // The whole reason for the second copy: a phone reader who scrolls the briefing
    // to the end must still have a button in view, not have to scroll back up.
    await page.getByTestId(CONTINUE_BOTTOM).scrollIntoViewIfNeeded();
    const endBox = await page.getByTestId(CONTINUE_BOTTOM).boundingBox();
    expect(endBox.y).toBeGreaterThanOrEqual(0);
    expect(endBox.y + endBox.height).toBeLessThanOrEqual(vp.height + 1);
    const lastStepBox = await page.getByTestId('start-explainer-step').last().boundingBox();
    expect(endBox.y, 'the bottom CTA sits after the last step').toBeGreaterThan(lastStepBox.y);

    await continueTo(page, '?design=bachelorette&step=2', CONTINUE_BOTTOM);
  });
});
