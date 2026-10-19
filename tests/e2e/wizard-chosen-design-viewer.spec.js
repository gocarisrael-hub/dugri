import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';
import { previewRedesign } from './helpers/redesign.js';

// The chosen design's pictures on the title step open full size (the owner, 2026-10-19). A tap on any picture opens
// the wizard's photo viewer (#deckView, the one the deck row uses) on THAT picture, with every picture of the design
// to move through: arrows on a desktop, a swipe or the keyboard anywhere, Esc or ✕ to close. Redesign mode only, like
// the box itself.

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

// the picture on screen is the one whose dot is current
const current = (page) =>
  page
    .locator('#deckViewDots .carousel-dot')
    .evaluateAll((dots) => dots.findIndex((d) => d.getAttribute('aria-current') === 'true'));

test('a tap on the 2nd picture opens the viewer on it; next goes to the 3rd; Esc closes', async ({
  page,
}) => {
  await previewRedesign(page);
  await page.goto('/options.html?design=japanese&step=3');
  await expect(page.getByTestId('chosen-design')).toBeVisible();
  const thumbs = page.getByTestId('chosen-design-pic');
  await expect(thumbs.nth(1)).toBeVisible();
  const thumbSrcs = await thumbs
    .locator('img')
    .evaluateAll((imgs) => imgs.map((i) => new URL(i.src).pathname));

  await thumbs.nth(1).click();
  const viewer = page.getByTestId('deck-view');
  await expect(viewer).toBeVisible();
  await expect(viewer).toHaveAttribute('aria-label', /טוקיו/);

  // every picture of the design, not only the ones in the box, and in the same order
  const slides = page.locator('#deckViewTrack img');
  const viewSrcs = await slides.evaluateAll((imgs) => imgs.map((i) => new URL(i.src).pathname));
  expect(viewSrcs.length).toBeGreaterThanOrEqual(3);
  expect(viewSrcs.length).toBeGreaterThanOrEqual(thumbSrcs.length);
  expect(viewSrcs.slice(0, thumbSrcs.length)).toEqual(thumbSrcs);

  // it opens on picture 2, with the focus on the close button
  await expect.poll(() => current(page)).toBe(1);
  await expect(page.getByTestId('deck-view-close')).toBeFocused();

  // next: the arrow on a desktop (a phone has none, and uses the keyboard's visual mapping here: left is next in RTL)
  const next = page.getByTestId('deck-view-next');
  if (await next.isVisible()) await next.click();
  else await page.keyboard.press('ArrowLeft');
  await expect.poll(() => current(page)).toBe(2);

  // the focus stays inside while it is open
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await viewer.evaluate((v) => v.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  // and goes back to the picture that opened it
  await expect(thumbs.nth(1)).toBeFocused();
});

test('on a desktop the arrows step both ways and ✕ closes', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the arrows are a desktop control; a phone swipes');
  await previewRedesign(page);
  await page.goto('/options.html?design=japanese&step=3');
  await page.getByTestId('chosen-design-pic').first().click();
  await expect(page.getByTestId('deck-view')).toBeVisible();
  await expect.poll(() => current(page)).toBe(0);
  const prev = page.getByTestId('deck-view-prev');
  const next = page.getByTestId('deck-view-next');
  await expect(prev).toHaveAccessibleName('התמונה הקודמת');
  await expect(next).toHaveAccessibleName('התמונה הבאה');
  // RTL: the next picture is to the left
  const [pb, nb] = [await prev.boundingBox(), await next.boundingBox()];
  expect(nb.x).toBeLessThan(pb.x);
  await next.click();
  await expect.poll(() => current(page)).toBe(1);
  await prev.click();
  await expect.poll(() => current(page)).toBe(0);
  await page.getByTestId('deck-view-close').click();
  await expect(page.getByTestId('deck-view')).toBeHidden();
});

test('the live site keeps the deck viewer without arrows', async ({ page }) => {
  await page.goto('/options.html?design=japanese&step=3');
  await expect(page.getByTestId('chosen-design')).toBeHidden();
  await expect(page.getByTestId('deck-view-next')).toBeHidden();
  await expect(page.getByTestId('deck-view-prev')).toBeHidden();
});
