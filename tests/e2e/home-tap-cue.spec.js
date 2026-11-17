import { test, expect } from '@playwright/test';

// The cue that the design cards open (the owner: people did not see that a card shows the whole game): handwriting beside
// the middle card with an arrow curving down onto it, no box. What these pin:
// - it shows with the owner's words at phone and desktop width, on the home (new.html), an occasion page and a company page,
//   which all render the same strip; it stays on screen, ends above the middle card, and touches neither a card nor one of
//   the owner's placed decorations (.pl);
// - tapping it opens the design in the middle of the strip and sends design_open for that design, exactly as a card tap
//   does (same name, same single parameter: the before/after open rate compares the two);
// - tapping a card still opens it and sends the same event;
// - under reduced motion it opens the first design of the still grid.

const CUE = 'לחצו עליי';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

const opens = (page) =>
  page.evaluate(() =>
    window.dataLayer
      .filter((a) => a[0] === 'event' && a[1] === 'design_open')
      .map((a) => ({ ...a[2] }))
  );

// the real tile nearest the strip's middle, the way a person sees it
const middleId = (page) =>
  page.locator('#strip').evaluate((s) => {
    const r = s.getBoundingClientRect(),
      mid = r.left + r.width / 2;
    let best = null,
      bd = Infinity;
    for (const el of s.querySelectorAll('.dz')) {
      const b = el.getBoundingClientRect(),
        d = Math.abs(b.left + b.width / 2 - mid);
      if (d < bd) [best, bd] = [el, d];
    }
    return best.dataset.k;
  });

const SIZES = [
  ['phone', 390, 844],
  ['desktop', 1440, 900],
];

for (const path of ['/new.html', '/mesibat-ravakot', '/asakim'])
  for (const [name, width, height] of SIZES)
    test(`${path} (${name}): the cue shows and opens the middle design with design_open`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.goto(path);
      await page.waitForLoadState('load');
      const cue = page.locator('#tapCue');
      await expect(cue).toBeVisible();
      await expect(cue).toHaveText(CUE);
      // inside the page, above the middle card, clear of every card and every placed decoration
      const box = await cue.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      const hits = await page.evaluate(() => {
        const parts = [...document.querySelectorAll('#tapCue .tap-txt, #tapCue .tap-arrow')].map(
          (e) => e.getBoundingClientRect()
        );
        const meet = (a, b) =>
          a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const others = [
          ...[...document.querySelectorAll('#strip .dz img')].map((e) => ['card', e]),
          ...[...document.querySelectorAll('#order .pl')].map((e) => ['decoration', e]),
        ];
        return others
          .filter(([, e]) => getComputedStyle(e).display !== 'none' && e.getClientRects().length)
          .filter(([, e]) => parts.some((p) => meet(p, e.getBoundingClientRect())))
          .map(([kind, e]) => kind + ' ' + (e.closest('.dz')?.dataset.k || e.dataset.kind));
      });
      expect(hits).toEqual([]);
      await cue.scrollIntoViewIfNeeded();
      const id = await middleId(page);
      await cue.click();
      await expect(page.locator('#flood')).toHaveAttribute('open', '');
      await expect(page.locator('#tableau .fr')).toBeVisible();
      // the same event a card tap sends (an occasion page adds its occasion to every event)
      const got = await opens(page);
      expect(got).toHaveLength(1);
      expect(got[0].design).toBe(id);
    });

test('a card tap still opens its design and sends the same design_open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/new.html');
  await page.waitForLoadState('load');
  const tile = page.locator('#strip .dz:not([aria-hidden])[data-k="bachelorette"]');
  await tile.evaluate((b) => b.click());
  await expect(page.locator('#flood')).toHaveAttribute('open', '');
  expect(await opens(page)).toEqual([{ design: 'bachelorette' }]);
  // closing gives focus back to the card, and the cue opens again with one more event
  await page.locator('#floodX').click();
  await expect(page.locator('#flood')).not.toHaveAttribute('open', '');
  await page.locator('#tapCue').click();
  await expect(page.locator('#flood')).toHaveAttribute('open', '');
  expect(await opens(page)).toHaveLength(2);
});

test('under reduced motion the cue opens the first design of the still grid', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/new.html');
  await page.waitForLoadState('load');
  const first = await page.locator('#strip .dz').first().getAttribute('data-k');
  await page.locator('#tapCue').click();
  await expect(page.locator('#flood')).toHaveAttribute('open', '');
  expect(await opens(page)).toEqual([{ design: first }]);
  // the close returns focus to that tile
  await page.keyboard.press('Escape');
  await expect(page.locator(`#strip .dz[data-k="${first}"]`)).toBeFocused();
});
