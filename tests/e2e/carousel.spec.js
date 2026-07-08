import { test, expect } from '@playwright/test';

// The shared carousel engine (site/js/carousel.js) has three surfaces the unit
// tests can't cover (jsdom has no layout / scroll):
//   1. The HERO is a 'fade' cross-fade slideshow: stacked slides fade opacity in
//      place — NO horizontal scroll, NO cloned full-bleed photos (both repaint the
//      large image on iOS, which is what flickered on auto-advance). Exactly one
//      slide is visible at a time; it auto-advances and wraps last→first.
//   2. A 'scroller'/'slideshow' carousel with loop:true is ENDLESS: clones wrap
//      the real set so it wraps seamlessly in BOTH directions (hero uses fade so it
//      wraps WITHOUT clones; the reviews slideshow and the home product rail wrap
//      WITH clones).
//   3. A loop:false / unset carousel (the PDP photo gallery) is NEVER cloned.

// Wait until a carousel has been initialised on `selector`'s track.
async function waitForCarousel(page, selector) {
  await page.waitForFunction(
    (sel) => {
      const track = document.querySelector(sel);
      return !!track && !!track.__carousel;
    },
    selector,
    { timeout: 10_000 }
  );
}

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

test.describe('carousel — hero cross-fade (no scroll, no clones)', () => {
  test('exactly ONE hero slide is visible (opacity 1) at a time', async ({ page }) => {
    await page.goto('/index.html');
    await waitForCarousel(page, '.hero-track');

    const counts = await page.evaluate(() => {
      const track = document.querySelector('.hero-track');
      const slides = Array.from(track.querySelectorAll('.hero-slide'));
      const visible = () =>
        slides.filter((s) => Math.round(parseFloat(getComputedStyle(s).opacity)) === 1).length;
      const api = track.__carousel;
      api.pause();
      api.goTo(0, false);
      const atStart = visible();
      api.goTo(2, false); // jump to the last slide
      const atLast = visible();
      return { atStart, atLast, total: slides.length };
    });

    expect(counts.total).toBe(3);
    expect(counts.atStart).toBe(1); // one visible slide, not all three
    expect(counts.atLast).toBe(1);
  });

  test('the hero injects NO clones (fade cross-fades in place)', async ({ page }) => {
    await page.goto('/index.html');
    await waitForCarousel(page, '.hero-track');
    // No clones now or ever — give any stray ResizeObserver pass a moment to (not) fire.
    await page.waitForTimeout(300);
    await expect(page.locator('.hero-track [data-carousel-clone]')).toHaveCount(0);
    await expect(page.locator('.hero-slide')).toHaveCount(3); // only the real slides
  });

  test('the hero auto-advances (the visible slide changes on its own)', async ({ page }) => {
    await page.goto('/index.html');
    await waitForCarousel(page, '.hero-track');

    // Restart autoplay from slide 0 with a short interval so the test is quick.
    await page.evaluate(() => {
      const api = document.querySelector('.hero-track').__carousel;
      api.pause();
      api.goTo(0, false);
      api.play();
    });
    const before = await page.evaluate(() =>
      document.querySelector('.hero-track').__carousel.current()
    );
    expect(before).toBe(0);

    // Wait for autoplay to move off slide 0 (interval is 6000ms in the page).
    await page.waitForFunction(
      () => document.querySelector('.hero-track').__carousel.current() !== 0,
      null,
      { timeout: 12_000 }
    );
    const after = await page.evaluate(() =>
      document.querySelector('.hero-track').__carousel.current()
    );
    expect(after).not.toBe(0);
  });

  test('the hero wraps: next() past the last slide returns to the first', async ({ page }) => {
    await page.goto('/index.html');
    await waitForCarousel(page, '.hero-track');

    const settled = await page.evaluate(() => {
      const track = document.querySelector('.hero-track');
      const api = track.__carousel;
      api.pause();
      const real = track.querySelectorAll('.hero-slide:not([data-carousel-clone])').length;
      api.goTo(0, false);
      for (let i = 0; i < real; i++) api.next(); // whole set + one wrap
      return { current: api.current(), real };
    });

    expect(settled.real).toBe(3);
    expect(settled.current).toBe(0); // wrapped back to the start
  });
});

test.describe('carousel — passive advance (never scrolls the page)', () => {
  test('advancing the hero leaves window.scrollY untouched', async ({ page }) => {
    await page.goto('/index.html');
    await waitForCarousel(page, '.hero-track');

    // Stop autoplay so only our explicit advances move the carousel.
    await page.evaluate(() => document.querySelector('.hero-track').__carousel.pause());

    // Scroll the PAGE down, away from the hero. behavior:'instant' overrides the
    // page's `html { scroll-behavior: smooth }` so scrollY settles synchronously.
    await page.evaluate(() => window.scrollTo({ top: 500, left: 0, behavior: 'instant' }));
    await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 5000 });
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);

    // Advance via the API. Fade mode only toggles opacity — it must never move the
    // page's vertical scroll (the old scrollIntoView yanked the window back up).
    await page.evaluate(() => {
      const api = document.querySelector('.hero-track').__carousel;
      api.next();
      api.next();
      api.goTo(0);
      api.goTo(2); // jump to the last slide
    });
    await page.waitForTimeout(600);

    const after = await page.evaluate(() => window.scrollY);
    expect(after).toBe(before); // the page never moved vertically
  });
});

test.describe('carousel — endless loops (with clones)', () => {
  test('the reviews slideshow wraps (prev from the first goes to the last)', async ({ page }) => {
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

  test('the home product rail is ENDLESS: loop:true injects clones', async ({ page }) => {
    // The owner regressed on this once — the rail MUST clone so it wraps in both
    // directions, not hit an edge. Assert clones are present around the real cards.
    await page.goto('/index.html');
    await waitForLoop(page, '#productsTrack');
    await expect(
      page.locator('#productsTrack .home-prod-card:not([data-carousel-clone])')
    ).toHaveCount(7);
    await expect(
      page.locator('#productsTrack .home-prod-card[data-carousel-clone]').first()
    ).toBeAttached();
  });

  test('the home rail wraps forward: next() past the last card returns to the first', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await waitForLoop(page, '#productsTrack');

    const settled = await page.evaluate(() => {
      const track = document.querySelector('#productsTrack');
      const api = track.__carousel;
      const real = track.querySelectorAll('.home-prod-card:not([data-carousel-clone])').length;
      api.goTo(0, false);
      for (let i = 0; i < real; i++) api.next(); // whole set + one wrap
      return { current: api.current(), real };
    });

    expect(settled.real).toBe(7);
    expect(settled.current).toBe(0); // wrapped back to the first card
  });

  test('the home rail wraps backward: prev() from the first goes to the last', async ({ page }) => {
    await page.goto('/index.html');
    await waitForLoop(page, '#productsTrack');

    const result = await page.evaluate(() => {
      const track = document.querySelector('#productsTrack');
      const api = track.__carousel;
      const total = track.querySelectorAll('.home-prod-card:not([data-carousel-clone])').length;
      api.goTo(0, false);
      api.prev(); // 0 → wrap to the last card
      return { current: api.current(), last: total - 1 };
    });

    expect(result.current).toBe(result.last);
  });

  // Regression guard: every endless carousel on the page (hero fade + clone-based
  // loops) MUST wrap last→first. If any loop:true rail silently loses its wrap
  // again, this fails.
  test('guard: EVERY endless carousel wraps last→first', async ({ page }) => {
    await page.goto('/index.html');
    for (const sel of ['.hero-track', '#reviewsTrack', '#productsTrack']) {
      await waitForCarousel(page, sel);
    }

    const results = await page.evaluate(() => {
      const sels = ['.hero-track', '#reviewsTrack', '#productsTrack'];
      return sels.map((sel) => {
        const track = document.querySelector(sel);
        const api = track.__carousel;
        api.pause();
        const real = Array.from(track.children).filter(
          (c) => !c.hasAttribute('data-carousel-clone')
        ).length;
        api.goTo(0, false);
        for (let i = 0; i < real; i++) api.next();
        return { sel, real, current: api.current() };
      });
    });

    for (const r of results) {
      expect(r.real, `${r.sel} should have ≥2 real slides`).toBeGreaterThan(1);
      expect(r.current, `${r.sel} should wrap back to 0`).toBe(0);
    }
  });
});

test.describe('carousel — looping is opt-in', () => {
  test('a carousel without loop:true is NEVER cloned (PDP gallery)', async ({ page }) => {
    // The PDP photo gallery is loop:false — cloning it made the product-page image
    // flicker, so it must never inject clones.
    await page.goto('/product.html?design=bachelorette');
    await expect(page.locator('#galleryTrack .pdp-gallery-slide')).not.toHaveCount(0);
    await expect(page.locator('#galleryTrack [data-carousel-clone]')).toHaveCount(0);
  });
});
