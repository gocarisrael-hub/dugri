import { test, expect } from '@playwright/test';

// new.html's reviews section: the disco ball sits just left of its heading (the owner's ask, 2026-10-20), and nothing decorative sits
// under the reviews row, where a lone + read as a control.

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

for (const width of [360, 390, 1440]) {
  test(`the reviews marks at ${width}: the disco ball beside the heading, nothing under the row`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/new.html');
    await page.locator('#recs .pl').first().waitFor({ state: 'attached' });
    const m = await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#h-recs'));
      const h = range.getBoundingClientRect(),
        row = document.querySelector('#row').getBoundingClientRect();
      const marks = [...document.querySelectorAll('#recs .pl')]
        .filter((e) => getComputedStyle(e).display !== 'none')
        .map((e) => ({
          disco: !!e.querySelector('clipPath[id^="i27"]'),
          b: e.getBoundingClientRect().toJSON(),
        }));
      return { h: h.toJSON(), row: row.toJSON(), marks };
    });
    const disco = m.marks.find((x) => x.disco);
    expect(disco, 'the disco ball is placed').toBeTruthy();
    // left of the heading, not over it, and close: within 40 px
    const gap = m.h.left - disco.b.right;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(40);
    // level with it
    expect(Math.abs(disco.b.top + disco.b.height / 2 - (m.h.top + m.h.height / 2))).toBeLessThan(
      m.h.height
    );
    // inside the page
    expect(disco.b.left).toBeGreaterThanOrEqual(0);
    // on a phone, nothing below the row
    if (width < 900) expect(m.marks.filter((x) => x.b.top >= m.row.bottom)).toEqual([]);
  });
}
