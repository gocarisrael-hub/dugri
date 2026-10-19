import { test, expect } from '@playwright/test';

// new.html, the owner's 2026-10-19 round:
// - the swipe hint has ONE arrow, drawn (a glyph arrow mirrors in RTL), at the left end of the line and pointing left;
// - the business WhatsApp button reads "לפניות עסקיות בוואטסאפ" on one line, inside the page, at 320 and 390;
// - the tapped view's box list names the pawn card.

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

test('the swipe hint: one drawn arrow at the left end, pointing left', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/new.html');
  const hint = page.locator('.strip-hint');
  await hint.scrollIntoViewIfNeeded();
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('החליקו');
  expect(await hint.textContent()).not.toMatch(/[←→‹›<>]/);
  const arrow = hint.locator('svg');
  await expect(arrow).toHaveCount(1);
  const a = await arrow.boundingBox(),
    t = await hint.locator('span').boundingBox();
  // left of the word, on its line
  expect(a.x + a.width).toBeLessThanOrEqual(t.x + 1);
  expect(Math.abs(a.y + a.height / 2 - (t.y + t.height / 2))).toBeLessThan(6);
  // its head is drawn at the left (x=5 of 24) and nothing mirrors it
  await expect(arrow.locator('path')).toHaveAttribute('d', 'M19 12H5M11 6l-6 6 6 6');
  expect(await arrow.evaluate((e) => getComputedStyle(e).transform)).toBe('none');
  expect(await hint.evaluate((e) => getComputedStyle(e).transform)).toBe('none');
});

for (const width of [320, 390]) {
  test(`the business WhatsApp button fits on one line at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/new.html');
    const label = page.locator('[data-edit="new-biz-wa"]');
    await label.scrollIntoViewIfNeeded();
    await expect(label).toHaveText('לפניות עסקיות בוואטסאפ');
    const pill = label.locator('xpath=..');
    const fit = await pill.evaluate((p) => {
      const s = p.querySelector('[data-edit="new-biz-wa"]'),
        r = p.getBoundingClientRect(),
        lines = s.getClientRects().length,
        lh =
          parseFloat(getComputedStyle(s).lineHeight) ||
          parseFloat(getComputedStyle(s).fontSize) * 1.3;
      return {
        lines,
        oneLine: s.getBoundingClientRect().height < lh * 1.5,
        clipped: p.scrollWidth > p.clientWidth + 1,
        inPage: r.left >= 0 && r.right <= document.documentElement.clientWidth,
      };
    });
    expect(fit).toEqual({ lines: 1, oneLine: true, clipped: false, inPage: true });
  });
}

test('the tapped view lists the pawn card in the box', async ({ page }) => {
  await page.goto('/new.html');
  await expect(page.locator('[data-edit="new-view-inbox-3"]')).toHaveText(
    'קלף חיילי משחק עם הפרצופים שלכם',
    { useInnerText: true }
  );
});
