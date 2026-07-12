import { test, expect } from '@playwright/test';

// Landing page first-impression guarantees for the redesigned homepage:
// - a full-bleed hero slideshow (3 rotating slides), each carrying one sentence
//   and a single solid CTA into the store,
// - the shared sticky header (order-now → store, hamburger toggles the menu),
// - a swipeable product rail whose cards open the per-design detail page,
// - real reviews / contact info, and the brand rule (never the trademarked word).

test.describe('landing page hero', () => {
  test('shows a 3-slide hero, each with a sentence and a CTA into the store', async ({ page }) => {
    await page.goto('/index.html');

    // Real slides only — the endless-loop engine injects aria-hidden clones
    // ([data-carousel-clone]) around the set so the hero wraps seamlessly.
    const slides = page.locator('.hero-slide:not([data-carousel-clone])');
    await expect(slides).toHaveCount(3);

    // The first slide's title is the page <h1> and carries the headline sentence.
    const h1 = page.locator('.hero-slide h1');
    await expect(h1).toHaveCount(1);
    await expect(h1).toContainText('המתנה המושלמת');

    // Every hero CTA is a solid button that opens the store.
    const heroCtas = page.locator('.hero-slide:not([data-carousel-clone]) [data-ga-cta="hero"]');
    await expect(heroCtas).toHaveCount(3);
    const hrefs = await heroCtas.evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    for (const href of hrefs) expect(href).toBe('products.html');

    // Brand rule: never the trademarked word.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('אליאס');
  });

  test('hero backgrounds are the official product photos (assets/hero-N.jpg) and load', async ({
    page,
    request,
  }) => {
    await page.goto('/index.html');

    const bgs = page.locator('.hero-slide:not([data-carousel-clone]) .hero-slide__bg');
    await expect(bgs).toHaveCount(3);

    const srcs = await bgs.evaluateAll((els) => els.map((img) => img.getAttribute('src')));
    expect(srcs).toEqual(['assets/hero-1.jpg', 'assets/hero-2.jpg', 'assets/hero-3.jpg']);
    // No filler gallery placeholders may remain in the hero.
    for (const src of srcs) {
      expect(src).not.toMatch(/gallery-/);
      const res = await request.get('/' + src);
      expect(res.status(), `${src} should load`).toBe(200);
    }
  });

  test("the middle slide's headline sits BELOW its CTA button", async ({ page }) => {
    await page.goto('/index.html');

    // Slide 2 (hero-2.jpg) reads badly with the headline overlapping the board
    // photo, so on THAT slide only the CTA is on top and the headline drops
    // underneath it. Slides 1 and 3 keep the headline ABOVE the button. Fade mode
    // stacks all three slides in the same box, so every inner still has layout
    // (getBoundingClientRect is valid even on the hidden slides).
    const inners = page.locator('.hero-slide:not([data-carousel-clone]) .hero-slide__inner');
    await expect(inners).toHaveCount(3);

    // Slide 2: headline top is BELOW the button's bottom, and the whole
    // button+headline group is nudged into the LOWER third of the photo
    // (approved layout) — the headline's bottom sits past the hero mid-line.
    const s2 = await inners.nth(1).evaluate((inner) => {
      const slide = inner.closest('.hero-slide');
      const hero = slide.getBoundingClientRect();
      const btn = inner.querySelector('.btn');
      const title = inner.querySelector('.hero-slide__title');
      const tb = title.getBoundingClientRect();
      return {
        titleTop: tb.top,
        btnBottom: btn.getBoundingClientRect().bottom,
        titleBottomPct: ((tb.bottom - hero.top) / hero.height) * 100,
      };
    });
    expect(s2.titleTop).toBeGreaterThan(s2.btnBottom);
    // lower third: the headline reaches past the middle of the slide.
    expect(s2.titleBottomPct).toBeGreaterThan(60);

    // Slides 1 & 3 (control): headline stays ABOVE the button.
    for (const idx of [0, 2]) {
      const s = await inners.nth(idx).evaluate((inner) => {
        const btn = inner.querySelector('.btn');
        const title = inner.querySelector('.hero-slide__title');
        return {
          titleBottom: title.getBoundingClientRect().bottom,
          btnTop: btn.getBoundingClientRect().top,
        };
      });
      expect(s.titleBottom).toBeLessThanOrEqual(s.btnTop);
    }
  });
});

test.describe('hero marquee ribbon', () => {
  test('a scrolling ribbon lists all three phrases, built from two identical halves for a seamless loop', async ({
    page,
  }) => {
    await page.goto('/index.html');

    const marquee = page.getByTestId('hero-marquee');
    await expect(marquee).toHaveCount(1);

    const phrases = ['מפעילים את הטיימר', 'מנחשים מילים', 'הכל עליכם'];

    // The track is EXACTLY two halves; the CSS translateX 0 → -50% loop moves it
    // by one half-width, so the loop is seamless only if the two halves are
    // pixel-identical. Each half repeats the 3-phrase group several times so a
    // single half is always wider than the viewport (no blank gap at any width).
    const halves = marquee.locator('.marquee__half');
    await expect(halves).toHaveCount(2);

    const texts = await halves.evaluateAll((els) => els.map((el) => el.innerText));
    // Each half carries all three phrases...
    for (const txt of texts) {
      for (const p of phrases) expect(txt).toContain(p);
    }
    // ...and the two halves are identical, which is what makes the loop seamless.
    expect(texts[0]).toBe(texts[1]);

    // Each half repeats the 3-phrase group multiple times so it can fill the strip.
    const groupsPerHalf = await halves.first().locator('.marquee__group').count();
    expect(groupsPerHalf).toBeGreaterThanOrEqual(3);
  });
});

test.describe('shared sticky header', () => {
  test('order-now opens the store and the hamburger toggles the menu', async ({ page }) => {
    await page.goto('/index.html');

    await expect(page.getByTestId('order-now')).toHaveAttribute('href', 'products.html');

    const toggle = page.getByTestId('nav-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('home product rail', () => {
  test('one card per public design, each opening its detail page', async ({ page }) => {
    await page.goto('/index.html');

    const rail = page.getByTestId('home-products');
    await expect(rail).toBeVisible();

    const cards = rail.locator('a.home-prod-card:not([data-carousel-clone])');
    await expect(cards).toHaveCount(7);

    // Every card links to product.html?design=<id> and shows a name + price.
    const hrefs = await cards.evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    for (const href of hrefs) expect(href).toMatch(/^product\.html\?design=[a-z]+$/);
    await expect(cards.first().locator('.home-prod-name')).not.toHaveText('');
    await expect(cards.first().locator('.home-prod-price')).toContainText('79 ₪');

    // The "מעבר אל החנות" button opens the store.
    await expect(rail.locator('.home-products-cta a')).toHaveAttribute('href', 'products.html');
  });
});

test.describe('landing order funnel', () => {
  test('nav, hero and final CTAs all point to the store', async ({ page }) => {
    await page.goto('/index.html');

    await expect(page.locator('.nav-cta[data-ga-cta="nav"]')).toHaveAttribute(
      'href',
      'products.html'
    );
    const heroCtas = page.locator('.btn[data-ga-cta="hero"]');
    await expect(heroCtas.first()).toHaveAttribute('href', 'products.html');
    await expect(page.locator('.btn[data-ga-cta="final"]')).toHaveAttribute(
      'href',
      'products.html'
    );
  });
});

test.describe('real contact info', () => {
  test('Instagram link resolves to dugri_israel with no placeholder', async ({ page }) => {
    await page.goto('/index.html');
    const ig = page.locator('#igLink');
    await expect(ig).toHaveAttribute('href', 'https://instagram.com/dugri_israel');
    // No placeholder must remain anywhere on the page.
    const html = await page.content();
    expect(html).not.toContain('INSTAGRAM_HANDLE');
  });

  test('email and phone are visible in the footer', async ({ page }) => {
    await page.goto('/index.html');
    const footer = page.locator('footer');
    const footerText = await footer.innerText();
    expect(footerText).toContain('dugri.israel@gmail.com');
    expect(footerText).toContain('0546577715');

    await expect(footer.locator('a[href="mailto:dugri.israel@gmail.com"]')).toHaveCount(1);
    await expect(footer.locator('a[href="tel:+972546577715"]')).toHaveCount(1);
  });
});

test.describe('real customer testimonials', () => {
  test('proof section shows exactly 4 real review images that load (200) and no placeholders', async ({
    page,
    request,
  }) => {
    await page.goto('/index.html');

    const reviews = page.locator(
      '[data-testid="proof-reviews"] .review:not([data-carousel-clone]) img'
    );
    await expect(reviews).toHaveCount(4);

    const srcs = await reviews.evaluateAll((els) => els.map((img) => img.getAttribute('src')));
    expect(srcs.length).toBe(4);
    for (const src of srcs) {
      // Every testimonial image must live under assets/testimonials/...
      expect(src).toMatch(/^assets\/testimonials\//);
      // ...and actually be served (catches a missing/untracked file).
      const res = await request.get('/' + src);
      expect(res.status(), `${src} should load`).toBe(200);
    }

    // No fake placeholder captions may remain anywhere on the page.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('שם הלקוחה');
    expect(body).not.toContain('שם הלקוח');
    // Brand rule: never the trademarked word.
    expect(body).not.toContain('אליאס');
  });

  test('each review sits in its own distinct warm card that lifts off the sand section', async ({
    page,
  }) => {
    await page.goto('/index.html');

    const reviews = page.locator(
      '[data-testid="proof-reviews"] .review:not([data-carousel-clone])'
    );
    await expect(reviews).toHaveCount(4);

    const bgs = await reviews.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).backgroundColor)
    );
    expect(bgs.length).toBe(4);

    // The section wash is the sand token --section (#f4efe6). Each review is a
    // distinct warm off-white CARD, deliberately LIGHTER than the section so it
    // lifts off the wash (border + shadow do the rest) instead of blending in.
    const SECTION = [244, 239, 230];
    const sectionSum = SECTION[0] + SECTION[1] + SECTION[2];
    for (const bg of bgs) {
      // never transparent
      expect(bg, `review bg ${bg} must be an opaque fill`).not.toMatch(
        /rgba?\(0, 0, 0, 0\)|transparent/
      );
      const [r, g, b] = bg.match(/\d+/g).map(Number);
      // clearly not the sand section itself
      expect([r, g, b], `review bg ${bg} must differ from the sand section`).not.toEqual(SECTION);
      // a bright, light card...
      expect(Math.min(r, g, b)).toBeGreaterThan(210);
      // ...that is warm — red at least as strong as blue (sand/cream, not pink/blue)
      expect(r).toBeGreaterThanOrEqual(b);
      // ...and lighter than the sand section, so it reads as a raised card on it
      expect(r + g + b).toBeGreaterThan(sectionSum);
    }
    // The four shades are distinct from one another.
    expect(new Set(bgs).size).toBe(4);
  });

  test('each review box is a roomy rectangular mat (tall vertical padding)', async ({ page }) => {
    await page.goto('/index.html');

    const first = page
      .locator('[data-testid="proof-reviews"] .review:not([data-carousel-clone])')
      .first();
    const pad = await first.evaluate((el) => {
      const s = getComputedStyle(el);
      return { top: parseFloat(s.paddingTop), bottom: parseFloat(s.paddingBottom) };
    });
    // the pink frame reads as a tall box around the screenshot, not a hugging 10px line
    expect(pad.top).toBeGreaterThanOrEqual(24);
    expect(pad.bottom).toBeGreaterThanOrEqual(24);
  });
});

test.describe('hero readability + menu + trimmed CTA', () => {
  test('the hero white scrim is strong enough to keep the dark headline readable', async ({
    page,
  }) => {
    await page.goto('/index.html');

    // The scrim is a white gradient painted on .hero-slide::after. A brighter
    // wash was needed so the near-black headline stays legible over bright
    // photos. Read the pseudo-element's computed gradient and assert every white
    // stop got meaningfully stronger than the old 0.24 / 0.46 / 0.28 baseline.
    const alphas = await page
      .locator('.hero-slide')
      .first()
      .evaluate((el) => {
        const bg = window.getComputedStyle(el, '::after').backgroundImage;
        return [...bg.matchAll(/rgba?\([^)]*?,\s*([\d.]+)\)/g)].map((m) => parseFloat(m[1]));
      });
    expect(alphas.length).toBe(3);
    // Each stop clearly heavier than before; the middle peak carries the headline.
    expect(alphas[0]).toBeGreaterThan(0.38);
    expect(alphas[1]).toBeGreaterThan(0.6);
    expect(alphas[2]).toBeGreaterThan(0.4);
  });

  test('the final CTA no longer carries the trust/reassure line', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('[data-edit="index-final-reassure"]')).toHaveCount(0);
  });

  test('the header menu links to the online timer', async ({ page }) => {
    await page.goto('/index.html');
    const timer = page.locator('[data-testid="nav-menu"] a[href="timer.html"]');
    await expect(timer).toHaveCount(1);
    await expect(timer).toHaveText('טיימר');
  });
});

test.describe('hero lets the page scroll vertically', () => {
  test('the hero carousel track allows vertical page scroll (touch-action includes pan-y)', async ({
    page,
  }) => {
    await page.goto('/index.html');
    const hero = page.locator('.hero-track.carousel-track');
    await expect(hero).toHaveCount(1);
    // Regression guard: 'pan-x' alone blocked scrolling the page when a touch
    // started on the tall hero photo. The track must allow vertical panning too.
    const touchAction = await hero.evaluate((el) => getComputedStyle(el).touchAction);
    expect(touchAction).toContain('pan-y');
  });
});
