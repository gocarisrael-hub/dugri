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
    // Pin the owner-editable store price so the rail-price assertion is hermetic
    // (the shared e2e server's settings could be mutated by the admin-pricing spec).
    await page.route('**/api/pricing', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          store: { now: 199, was: 239 },
          versions: {
            pdf: { enabled: false, price: 79 },
            pickup: { enabled: true, price: 199 },
            delivery: { enabled: false, price: 199 },
            custom: { enabled: false, price: 599 },
          },
        }),
      })
    );
    await page.goto('/index.html');

    const rail = page.getByTestId('home-products');
    await expect(rail).toBeVisible();

    const cards = rail.locator('a.home-prod-card:not([data-carousel-clone])');
    await expect(cards).toHaveCount(7);

    // Every card links to product.html?design=<id> and shows a name + price.
    const hrefs = await cards.evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    for (const href of hrefs) expect(href).toMatch(/^product\.html\?design=[a-z]+$/);
    await expect(cards.first().locator('.home-prod-name')).not.toHaveText('');
    await expect(cards.first().locator('.home-prod-price')).toContainText('199 ₪');

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

  test('each review sits in its own distinct pastel card that lifts off the sand section', async ({
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

    // A deliberate splash of soft colour on the reviews rail only: each review is a
    // distinct low-saturation pastel MAT that lifts off the sand section (--section
    // #f4efe6) via hue + the hairline border + shadow. The four shades cycle
    // light blue → light green → banana yellow → light pink.
    const SECTION = [244, 239, 230];
    const PASTELS = [
      'rgb(214, 236, 255)', // #d6ecff light blue
      'rgb(217, 242, 222)', // #d9f2de light green
      'rgb(255, 243, 196)', // #fff3c4 banana yellow
      'rgb(255, 225, 236)', // #ffe1ec light pink
    ];
    for (const bg of bgs) {
      // never transparent
      expect(bg, `review bg ${bg} must be an opaque fill`).not.toMatch(
        /rgba?\(0, 0, 0, 0\)|transparent/
      );
      const [r, g, b] = bg.match(/\d+/g).map(Number);
      // clearly not the sand section itself
      expect([r, g, b], `review bg ${bg} must differ from the sand section`).not.toEqual(SECTION);
      // a light, gentle pastel (every channel stays high — no dark/heavy fills)
      expect(Math.min(r, g, b)).toBeGreaterThan(180);
    }
    // Exactly the four intended pastels, in order and all distinct.
    expect(bgs).toEqual(PASTELS);
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

  test('the how-it-works page also dropped its reassure line', async ({ page }) => {
    await page.goto('/how.html');
    await expect(page.locator('[data-edit="how-final-reassure"]')).toHaveCount(0);
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

// ---- item 2a: the #about → #products junction no longer has an oversized void.
// The compact explainer + counter (#about) leads straight into the designs rail
// (#products). The default 72px+72px section padding, doubled around the small
// centered stat box, read as an oversized empty band — and #products had no
// divider (a <script> between the two sections breaks the `section + section`
// border-top selector). The junction is tightened and the hairline divider
// restored so it matches every other section boundary. Measured under reduced
// motion so the scroll-reveal transform isn't mid-flight (it offsets rects).
test.describe('spacing: counter → designs junction', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the gap between the orders counter and the designs section is a normal rhythm, with a divider', async ({
    page,
  }) => {
    await page.goto('/index.html');
    // let layout settle
    await page.locator('#products .home-products-head h2').scrollIntoViewIfNeeded();

    const m = await page.evaluate(() => {
      const stat = document.querySelector('.stat-box').getBoundingClientRect();
      const head = document.querySelector('#products .home-products-head').getBoundingClientRect();
      const products = document.getElementById('products');
      const reviews = document.getElementById('reviews');
      return {
        gap: head.top - stat.bottom,
        productsBorderTop: parseFloat(getComputedStyle(products).borderTopWidth),
        reviewsBorderTop: parseFloat(getComputedStyle(reviews).borderTopWidth),
      };
    });

    // Tightened, but not collapsed: clearly smaller than the old doubled void
    // (~144px) yet a comfortable rhythm, never touching.
    expect(m.gap).toBeGreaterThan(40);
    expect(m.gap).toBeLessThan(120);
    // The divider is restored so this boundary matches the others (e.g. #reviews).
    expect(m.productsBorderTop).toBeGreaterThanOrEqual(1);
    expect(m.productsBorderTop).toBe(m.reviewsBorderTop);
  });
});

// ---- item 2b: the reviews rail is visible AND navigable on every viewport,
// desktop included. The rail shows ONE screenshot per view; desktop has no touch,
// so without a visible control a mouse user cannot swipe and the tiny dots are
// easy to miss — the other three testimonials look unreachable ("no reviews on
// desktop"). Prev/next arrows now flank the dots so all four are reachable. This
// runs on every project (Desktop Chrome + the phones), so it guards both.
function centeredReviewSrc() {
  const track = document.getElementById('reviewsTrack');
  const t = track.getBoundingClientRect();
  const centre = t.left + t.width / 2;
  const on = [...document.querySelectorAll('#reviewsTrack .review img')].find((im) => {
    const b = im.getBoundingClientRect();
    return (
      im.naturalWidth > 0 &&
      b.width >= t.width * 0.7 &&
      Math.abs(b.left + b.width / 2 - centre) <= t.width * 0.2
    );
  });
  return on ? (on.currentSrc || on.src).split('/').pop() : null;
}

test.describe('reviews are visible and navigable on desktop', () => {
  test('the rail renders a real screenshot and prev/next arrows step through all four', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.locator('#reviews').scrollIntoViewIfNeeded();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#reviewsTrack .review img')].some((i) => i.naturalWidth > 0)
    );

    // The track has a real, non-zero box (not the collapsed / blank state).
    const trackBox = await page.locator('#reviewsTrack').boundingBox();
    expect(trackBox.width).toBeGreaterThan(100);
    expect(trackBox.height).toBeGreaterThan(100);

    // A single screenshot is properly on view at load.
    await expect.poll(() => page.evaluate(centeredReviewSrc)).toBe('review-1.jpg');

    // Both arrows are present AND visible — the clear desktop control that was
    // missing. Dots stay too (one per review).
    const arrows = page.locator('#reviews .carousel-arrow');
    await expect(arrows).toHaveCount(2);
    await expect(page.locator('#reviews .carousel-arrow--next')).toBeVisible();
    await expect(page.locator('#reviews .carousel-arrow--prev')).toBeVisible();
    await expect(page.locator('#reviews .carousel-dot')).toHaveCount(4);

    // The next arrow advances the rail (review-1 → review-2), proving the other
    // testimonials are reachable by clicking (works with a mouse, no swipe needed).
    await page.locator('#reviews .carousel-arrow--next').click();
    await expect.poll(() => page.evaluate(centeredReviewSrc)).toBe('review-2.jpg');

    // The centred screenshot fills the rail — visible, not a blank sliver.
    const filledWidth = await page.evaluate(() => {
      const track = document.getElementById('reviewsTrack');
      const t = track.getBoundingClientRect();
      const centre = t.left + t.width / 2;
      const im = [...document.querySelectorAll('#reviewsTrack .review img')].find((x) => {
        const b = x.getBoundingClientRect();
        return x.naturalWidth > 0 && Math.abs(b.left + b.width / 2 - centre) <= t.width * 0.2;
      });
      return im ? im.getBoundingClientRect().width / t.width : 0;
    });
    expect(filledWidth).toBeGreaterThan(0.7);
  });
});

// ---- item 6a: there is now a direct path from the homepage into the order flow.
// Every existing CTA leads to the shop grid (products.html); the order wizard
// (options.html) was only reachable by opening a product and pressing "buy". A
// header-menu link "להזמנה" now goes straight to options.html, which is a
// self-contained wizard that starts at step 1 (choose a design).
test.describe('order flow is reachable from the homepage', () => {
  test('a header link leads directly into the order wizard, which starts at step 1', async ({
    page,
  }) => {
    await page.goto('/index.html');

    const orderLink = page.getByTestId('nav-order-flow');
    await expect(orderLink).toHaveAttribute('href', 'options.html');
    await expect(orderLink).toHaveText('להזמנה');

    // Follow it: options.html is a working order-flow entry (step 1 = pick a design).
    await page.goto('/options.html');
    await expect(page.locator('.wiz-step.is-active')).toHaveCount(1);
    // Step 1 offers the design picker, so a shopper can begin without a preselected design.
    await expect(page.locator('.wiz-step.is-active .design').first()).toBeVisible();
  });

  test('the shop → product → buy path still reaches options.html (regression)', async ({
    page,
  }) => {
    await page.goto('/index.html');
    // homepage order CTA → shop
    await page.getByTestId('order-now').click();
    await expect(page).toHaveURL(/products\.html/);
    // shop → a product
    await page.locator('a[href^="product.html?design="]').first().click();
    await expect(page).toHaveURL(/product\.html\?design=/);
    // product → buy → the order wizard
    const buy = page.getByTestId('pdp-buy');
    await buy.waitFor();
    await expect.poll(() => buy.getAttribute('href')).toMatch(/^options\.html\?design=/);
    await buy.click();
    await expect(page).toHaveURL(/options\.html\?design=/);
  });
});
