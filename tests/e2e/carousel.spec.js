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

// The home product rail's card count is asserted below against the BUILT-IN
// catalog. An uploaded template (surfaced by /api/custom-designs) now rides the
// same rail and would add extra cards — that path is covered in
// storefront-custom-designs.spec; stub it out so these counts stay deterministic
// regardless of which templates the server happens to have.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

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
    ).toHaveCount(6);
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

    expect(settled.real).toBe(6);
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

test.describe('carousel — the active dot is not mirrored (dot i aligns with slide i)', () => {
  // The engine renders its own dots and syncs the active one to the centered slide.
  // The active dot MUST sit under the physical position of the on-view slide in BOTH
  // directions: a dot row that runs opposite to the track lights the left/right
  // mirror of the slide actually centered. We build a real carousel (via the live
  // module) with fixed-width slides, in each direction, and assert that the ordering
  // of the dots by index matches the ordering of the slides by index.

  // Build an isolated N-slide carousel of the given direction on the current page,
  // init it through the real module, and return the physical x of slide i and dot i
  // plus the active dot's index after advancing to `goToIndex`.
  async function probe(page, { dir, goToIndex }) {
    return page.evaluate(
      async ({ dir, goToIndex }) => {
        const { initCarousel } = await import('/js/carousel.js');
        // The host stays on the PAGE direction (rtl) — the dots are rendered as a
        // sibling of the track inside it, so they inherit rtl. ONLY the track is set
        // to the tested direction. This mirrors the real name-preview structure,
        // where the filmstrip is ltr but the dots row is a page-level rtl sibling —
        // exactly the case that lit the mirror dot before the fix.
        const host = document.createElement('div');
        host.style.cssText = 'width:300px;position:fixed;top:0;left:0;';
        const track = document.createElement('div');
        track.style.cssText = `direction:${dir};display:flex;overflow-x:auto;width:300px;`;
        for (let i = 0; i < 4; i++) {
          const s = document.createElement('div');
          s.style.cssText = 'flex:0 0 300px;height:80px;';
          s.textContent = `slide ${i}`;
          track.appendChild(s);
        }
        host.appendChild(track);
        document.body.appendChild(host);

        const api = initCarousel(track, {
          mode: 'slideshow',
          loop: false,
          dots: true,
          arrows: false,
          autoplay: false,
        });
        api.goTo(goToIndex, false);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        track.dispatchEvent(new Event('scroll'));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        const dots = [...host.querySelectorAll('.carousel-dot')];
        const slideOf = (i) =>
          [...track.children].find(
            (c) => c.__carouselIndex === i && !c.hasAttribute('data-carousel-clone')
          );
        const midX = (el) => {
          const b = el.getBoundingClientRect();
          return b.left + b.width / 2;
        };
        const activeDot = dots.findIndex((d) => d.getAttribute('aria-current') === 'true');

        const out = {
          activeDot,
          apiCurrent: api.current(),
          dot0X: midX(dots[0]),
          dot3X: midX(dots[3]),
          slide0X: midX(slideOf(0)),
          slide3X: midX(slideOf(3)),
          dotsDir: getComputedStyle(host.querySelector('.carousel-dots')).direction,
          trackDir: getComputedStyle(track).direction,
        };
        api.destroy();
        host.remove();
        return out;
      },
      { dir, goToIndex }
    );
  }

  test('RTL: dots run the same way as the slides, and the active dot follows the centered slide', async ({
    page,
  }) => {
    await page.goto('/index.html');
    const r = await probe(page, { dir: 'rtl', goToIndex: 2 });

    expect(r.trackDir).toBe('rtl');
    expect(r.dotsDir).toBe('rtl'); // dots pinned to the track direction
    expect(r.apiCurrent).toBe(2);
    expect(r.activeDot).toBe(2); // the i-th dot lights for slide i
    // In RTL slide 0 is physically RIGHT of slide 3; the dots must mirror that same
    // ordering (dot 0 right of dot 3), i.e. NOT run opposite to the slides.
    expect(Math.sign(r.dot3X - r.dot0X)).toBe(Math.sign(r.slide3X - r.slide0X));
    expect(r.slide3X).toBeLessThan(r.slide0X); // sanity: RTL really does run right→left
  });

  test('LTR track on the RTL page: the dots follow the track, not the page (no mirror)', async ({
    page,
  }) => {
    // A page can render a carousel LTR even though the document is RTL (the site's
    // name-preview does exactly this). The engine must flow its dots with the TRACK,
    // else the inherited-RTL dots light the mirror of the on-view slide.
    await page.goto('/index.html');
    const r = await probe(page, { dir: 'ltr', goToIndex: 2 });

    expect(r.trackDir).toBe('ltr');
    expect(r.dotsDir).toBe('ltr'); // dots pinned to the LTR track, not the RTL page
    expect(r.activeDot).toBe(2);
    // LTR: slide 0 left of slide 3, and the dots must match (dot 0 left of dot 3).
    expect(Math.sign(r.dot3X - r.dot0X)).toBe(Math.sign(r.slide3X - r.slide0X));
    expect(r.slide3X).toBeGreaterThan(r.slide0X);
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

// ---- prev/next arrows: side, painted direction, and who gets them ---------
// The owner reported the reviews arrows as reversed: the button on the RIGHT drew
// a left-pointing chevron. The sides and the scrolling were already correct — the
// ICON was wrong, because `›` (U+203A) and `‹` (U+2039) are bidi-MIRRORED
// characters and this page is dir="rtl", so the browser painted them flipped. The
// icons are now inline SVG paths, which bidi does not mirror. jsdom cannot see any
// of this (no layout, no bidi), so it is asserted here in a real browser.

// The review currently centred in the rail, plus the reviews physically to its
// left and right. Identity-based (filenames), so a seamless-loop recenter jump
// cannot make it flaky the way a raw pixel delta would.
function railNeighbours() {
  const track = document.getElementById('reviewsTrack');
  const t = track.getBoundingClientRect();
  const centre = t.left + t.width / 2;
  const nodes = [...track.children]
    .map((el) => {
      const im = el.querySelector('img');
      const b = el.getBoundingClientRect();
      return {
        src: im ? (im.currentSrc || im.src).split('/').pop() : null,
        x: b.left + b.width / 2,
      };
    })
    .filter((n) => n.src)
    .sort((a, b) => a.x - b.x);
  if (!nodes.length) return null;
  let i = 0;
  for (let k = 1; k < nodes.length; k++) {
    if (Math.abs(nodes[k].x - centre) < Math.abs(nodes[i].x - centre)) i = k;
  }
  return {
    centre: nodes[i].src,
    toTheLeft: i > 0 ? nodes[i - 1].src : null,
    toTheRight: i < nodes.length - 1 ? nodes[i + 1].src : null,
  };
}

test.describe('carousel — arrows point (and travel) the way they sit', () => {
  test('the RIGHT-hand arrow points right and moves the rail right; the left one, left', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.locator('#reviews').scrollIntoViewIfNeeded();
    await waitForCarousel(page, '#reviewsTrack');
    test.skip(
      await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches),
      'arrows are a fine-pointer affordance — the touch profile has none by design'
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#reviewsTrack .review img')].some((i) => i.naturalWidth > 0)
    );

    // Which button is physically on the right, and which chevron does it draw?
    const painted = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#reviews .carousel-arrow')].map((b) => ({
        side: b.getBoundingClientRect().left,
        role: b.classList.contains('carousel-arrow--prev') ? 'prev' : 'next',
        point: b.querySelector('svg') && b.querySelector('svg').getAttribute('data-point'),
        text: b.textContent.trim(),
      }));
      btns.sort((a, b) => a.side - b.side);
      return { left: btns[0], right: btns[1] };
    });
    expect(painted.right.point).toBe('right');
    expect(painted.left.point).toBe('left');
    // No bidi-mirrored character anywhere in either button — that is what flipped.
    expect(painted.right.text).toBe('');
    expect(painted.left.text).toBe('');
    // On this RTL page the right-hand button is the LOGICAL "previous" one.
    expect(painted.right.role).toBe('prev');

    // Clicking the right-hand button travels RIGHT: the review that was sitting to
    // the right of the centred one becomes the centred one.
    const before = await page.evaluate(railNeighbours);
    expect(before.toTheRight).toBeTruthy();
    await page.locator('#reviews .carousel-arrow--prev').click();
    await expect
      .poll(async () => (await page.evaluate(railNeighbours)).centre)
      .toBe(before.toTheRight);

    // And the left-hand button travels LEFT, back to where we started.
    const mid = await page.evaluate(railNeighbours);
    expect(mid.toTheLeft).toBeTruthy();
    await page.locator('#reviews .carousel-arrow--next').click();
    await expect.poll(async () => (await page.evaluate(railNeighbours)).centre).toBe(mid.toTheLeft);
  });

  test('a coarse pointer gets NO arrows anywhere on the storefront — dots only', async ({
    page,
  }) => {
    const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
    test.skip(!coarse, 'this is the touch-profile half of the pointer gate');

    for (const url of ['/index.html', '/products.html']) {
      await page.goto(url);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
      await expect(page.locator('.carousel-arrow')).toHaveCount(0);
    }
    // Dots are NOT gated: the phone still gets its position indicator.
    await page.goto('/index.html');
    await page.locator('#reviews').scrollIntoViewIfNeeded();
    await expect(page.locator('#reviews .carousel-dot')).toHaveCount(4);
  });

  test('store-tile arrows sit in the controls strip and are really clickable', async ({ page }) => {
    // They used to be dropped straight after the track — i.e. INSIDE
    // .product-card__media, whose overflow:hidden clipped them into invisible but
    // still tab-focusable buttons. A hit test (not just toBeVisible, which ignores
    // clipping) proves they are reachable.
    await page.goto('/products.html');
    // Skip BEFORE waiting for an arrow: on a touch profile there is never one.
    test.skip(
      await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches),
      'no arrows on a touch device by design'
    );
    await page.waitForFunction(
      () => !!document.querySelector('.product-card__dots .carousel-arrow')
    );

    const hit = await page.evaluate(() => {
      const b = document.querySelector('.product-card__dots .carousel-arrow');
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { inside: !!(el && b.contains(el)), w: Math.round(r.width), h: Math.round(r.height) };
    });
    expect(hit.inside).toBe(true);
    expect(hit.w).toBeGreaterThan(20);
    expect(hit.h).toBeGreaterThan(20);

    // prev sits physically RIGHT of next on this RTL page (same rule as the rest
    // of the site), and both draw an SVG chevron rather than a mirrored glyph.
    const sides = await page.evaluate(() => {
      const strip = document.querySelector('.product-card__dots');
      const g = (sel) => strip.querySelector(sel).getBoundingClientRect().left;
      return {
        prev: g('.carousel-arrow--prev'),
        next: g('.carousel-arrow--next'),
        prevPoint: strip.querySelector('.carousel-arrow--prev svg').getAttribute('data-point'),
        nextPoint: strip.querySelector('.carousel-arrow--next svg').getAttribute('data-point'),
      };
    });
    expect(sides.prev).toBeGreaterThan(sides.next);
    expect(sides.prevPoint).toBe('right');
    expect(sides.nextPoint).toBe('left');
  });
});
