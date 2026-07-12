import { test, expect } from '@playwright/test';

// The colour step (step 2) carries a swipeable front / back / board preview of
// the CURRENT design in the CURRENT colour, built on the shared carousel engine
// (js/carousel.js) — the same slideshow-with-dots as the rest of the site. These
// checks are deterministic: they read the carousel's own dot state + the inlined
// SVGs, never sampling a scroll/animation mid-flight.

// Target a view's slide (the carousel runs loop-free, so there are no clones —
// the :not([data-carousel-clone]) guard just keeps this robust either way).
const slideFor = (view) =>
  `#colorCarouselTrack .cc-slide[data-view="${view}"]:not([data-carousel-clone])`;

test.describe('colour step: front / back / board preview carousel', () => {
  test('renders three views with dots; a slide is filled at load and a dot navigates', async ({
    page,
  }) => {
    await page.goto('/options.html?step=2');
    await expect(page.getByTestId('color-carousel')).toBeVisible();

    // the front view is present and FILLED with its inlined SVG at load (no blank
    // slot — the eager, box-reserved slides don't let the carousel park on empty).
    await expect(page.locator(slideFor('front')).locator('svg')).toBeVisible();

    // one dot per view (front / back / board), the first active on load
    const dots = page.locator('#colorCarouselDots .carousel-dot');
    await expect(dots).toHaveCount(3);
    await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true');

    // every view's real slide carries its rendered SVG (in the DOM, not just the
    // one on screen — the whole carousel is built up front)
    await expect(page.locator(slideFor('back')).locator('svg')).toHaveCount(1);
    await expect(page.locator(slideFor('board')).locator('svg')).toHaveCount(1);

    // navigating with a dot moves the active view (deterministic: the dot's
    // aria-current, which goTo() sets synchronously — no timing sample)
    await dots.nth(2).click();
    await expect.poll(() => dots.nth(2).getAttribute('aria-current')).toBe('true');
    await expect(dots.nth(0)).not.toHaveAttribute('aria-current', 'true');
  });

  test('the carousel reflects the picked colour (updates live)', async ({ page }) => {
    await page.goto('/options.html?design=birthday&step=2');
    const track = page.locator('#colorCarouselTrack');
    await expect(page.locator(slideFor('front')).locator('svg')).toBeVisible();

    const c0 = () => track.evaluate((el) => getComputedStyle(el).getPropertyValue('--c0').trim());
    const before = await c0();
    expect(before).toMatch(/^#[0-9a-f]{6}$/i);

    // picking a swatch repaints the carousel's palette immediately
    await page.getByTestId('color-3').click();
    await expect.poll(c0).not.toBe(before);
  });

  test('a board-less design (kids) degrades to front + back only', async ({ page }) => {
    await page.goto('/options.html?design=kids&step=2');
    await expect(page.getByTestId('color-carousel')).toBeVisible();

    // two dots, no board slide at all (never a blank/broken third view)
    await expect(page.locator('#colorCarouselDots .carousel-dot')).toHaveCount(2);
    await expect(page.locator(slideFor('front')).locator('svg')).toBeVisible();
    await expect(page.locator(slideFor('back')).locator('svg')).toHaveCount(1);
    await expect(page.locator(slideFor('board'))).toHaveCount(0);
  });

  test('a fixed-colour design (neon) still shows the carousel in its baked colours', async ({
    page,
  }) => {
    await page.goto('/options.html?design=neon&step=2');
    await expect(page.getByTestId('color-carousel')).toBeVisible();
    // a fixed design hides the swatch picker, but the preview carousel still renders
    await expect(page.getByTestId('color-list')).toBeHidden();
    await expect(page.locator(slideFor('front')).locator('svg')).toBeVisible();
  });
});
