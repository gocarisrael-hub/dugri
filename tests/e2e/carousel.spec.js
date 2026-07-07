import { test, expect } from '@playwright/test';

// The shared carousel engine (site/js/carousel.js) must satisfy two guarantees the
// unit tests can't cover (jsdom has no layout / scroll):
//   1. Advancing is PASSIVE — it scrolls only the track horizontally and never
//      moves the page's vertical scroll (the old scrollIntoView yanked the window
//      back up to the hero whenever autoplay fired after the user scrolled down).
//   2. Every carousel is ENDLESS — clones wrap the real set so last→first is a
//      seamless forward hop, and next() past the end returns to the first slide
//      with the first dot lit.

// Wait until the endless-loop clones have been injected into `selector`'s track.
async function waitForLoop(page, selector) {
  await page.waitForFunction(
    (sel) => {
      const track = document.querySelector(sel);
      return !!track && track.querySelector('[data-carousel-clone]') !== null;
    },
    selector,
    { timeout: 10_000 }
  );
}

test.describe('carousel — passive advance (never scrolls the page)', () => {
  test('advancing the hero leaves window.scrollY untouched', async ({ page }) => {
    await page.goto('/index.html');
    await waitForLoop(page, '.hero-track');

    // Stop autoplay so only our explicit advances move the carousel.
    await page.evaluate(() => document.querySelector('.hero-track').__carousel.pause());

    // Scroll the PAGE down, away from the hero. behavior:'instant' overrides the
    // page's `html { scroll-behavior: smooth }` so scrollY settles synchronously.
    await page.evaluate(() => window.scrollTo({ top: 500, left: 0, behavior: 'instant' }));
    await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 5000 });
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);

    // Advance via the API (arrows/dots/autoplay all funnel through goTo→advanceTo)
    // and via an in-page dot click. We click in-page (element.click()) rather than
    // via Playwright, whose auto-scroll-into-view would itself move the page and
    // mask the very thing under test.
    await page.evaluate(() => {
      const api = document.querySelector('.hero-track').__carousel;
      api.next();
      api.next();
      api.goTo(0);
      document.querySelector('.hero-dots .carousel-dot:last-child').click(); // dot → goTo(last)
    });
    await page.waitForTimeout(600); // let any (horizontal) smooth scroll settle

    const after = await page.evaluate(() => window.scrollY);
    expect(after).toBe(before); // the page never moved vertically
  });
});

test.describe('carousel — endless loop', () => {
  test('the hero wraps: next() past the last slide returns to the first (dot 0)', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await waitForLoop(page, '.hero-track');

    const settled = await page.evaluate(() => {
      const track = document.querySelector('.hero-track');
      const api = track.__carousel;
      api.pause();
      // Count the REAL slides (exclude the injected clones).
      const real = track.querySelectorAll('.hero-slide:not([data-carousel-clone])').length;
      api.goTo(0, false);
      for (let i = 0; i < real; i++) api.next(); // step through the whole set + one wrap
      return { current: api.current(), real };
    });

    expect(settled.real).toBe(3);
    expect(settled.current).toBe(0); // wrapped back to the start

    // The first dot is the active one.
    const dots = page.locator('.hero-dots .carousel-dot');
    await expect(dots.first()).toHaveAttribute('aria-current', 'true');
  });

  test('the reviews slideshow wraps too (prev from the first goes to the last)', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await waitForLoop(page, '#reviewsTrack');

    const result = await page.evaluate(() => {
      const api = document.querySelector('#reviewsTrack').__carousel;
      api.pause();
      api.goTo(0, false);
      const total = document.querySelectorAll(
        '#reviewsTrack .review:not([data-carousel-clone])'
      ).length;
      api.prev(); // 0 → wrap to the last review
      return { current: api.current(), last: total - 1 };
    });

    expect(result.current).toBe(result.last);
  });

  test('a scroller rail is made endless (clones injected around the real cards)', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await waitForLoop(page, '#productsTrack');

    const counts = await page.evaluate(() => {
      const track = document.querySelector('#productsTrack');
      return {
        real: track.querySelectorAll('.home-prod-card:not([data-carousel-clone])').length,
        clones: track.querySelectorAll('.home-prod-card[data-carousel-clone]').length,
      };
    });

    expect(counts.real).toBe(7);
    // Clones on BOTH sides — at least one full extra set so the drag never hits a wall.
    expect(counts.clones).toBeGreaterThanOrEqual(counts.real);
  });
});
