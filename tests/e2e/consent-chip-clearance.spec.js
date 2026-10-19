import { test, expect } from '@playwright/test';

// The one-time cookie chip (js/consent.js, #cookieNotice) sits in the bottom-left corner for ~6 seconds on a visitor's first
// page. On a page with an action bar fixed to the bottom of the screen that corner is the bar's, and on the order wizard at
// 390 px the chip lay right over "הבא": a first-time buyer tapped the chip, not Next. The chip now stands above any short bar
// fixed to the bottom under it, so every control in that bar stays tappable while it shows.
//
// "Tappable" is measured the way a tap lands: the element at the control's own centre must be the control (or inside it).

const centreHit = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top) return 'nothing';
    if (el === top || el.contains(top)) return 'self';
    return top.closest('#cookieNotice')
      ? 'cookie chip'
      : top.tagName + (top.id ? '#' + top.id : '');
  }, selector);

const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const width of [390, 360]) {
  test(`order wizard at ${width}px: Next is tappable while the cookie chip shows`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/options.html');
    const chip = page.locator('#cookieNotice');
    await expect(chip, 'no cookie chip: this test would prove nothing').toBeVisible();
    const next = page.getByTestId('next-btn');
    await expect(next).toBeVisible();
    // The bar is drawn by the wizard after the chip; the chip follows it within a moment.
    await expect.poll(() => centreHit(page, '#nextBtn')).toBe('self');
    await expect
      .poll(async () => overlaps(await chip.boundingBox(), await next.boundingBox()))
      .toBe(false);
    // …and the chip is still a working control of its own.
    expect(await centreHit(page, '#cookieNotice button')).toBe('self');
    // Not floating mid-screen: it stands just above the bar. Read as one settled state, polled: the
    // chip is re-placed on a timer, so a single read can land between the bar appearing and the chip
    // catching up to it.
    const wizBar = page.locator('.wiz-bar');
    await expect(async () => {
      const bar = await wizBar.boundingBox();
      const c = await chip.boundingBox();
      expect(c.y + c.height).toBeLessThanOrEqual(bar.y);
      expect(bar.y - (c.y + c.height)).toBeLessThanOrEqual(24);
    }).toPass({ timeout: 5000 });
    // It gets there in one jump. A slide from the corner spends its frames lying across the bar's top
    // edge, which is the overlap this exists to end.
    expect(await chip.evaluate((el) => getComputedStyle(el).transitionProperty)).not.toMatch(
      /bottom|all/
    );
  });
}

// A page with no bottom bar keeps the chip in its corner, at the foot of the screen.
test('with no bar under it, the chip stays in its corner', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/terms.html');
  const chip = page.locator('#cookieNotice');
  await expect(chip).toBeVisible();
  const c = await chip.boundingBox();
  expect(800 - (c.y + c.height)).toBeLessThanOrEqual(16);
});
