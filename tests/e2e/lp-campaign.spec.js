// The campaign landing page (/lp.html).
//
// It exists to win ONE action from ad and DM traffic, and it repeats numbers
// that live elsewhere: the price in settings, the FAQ the owner edits, the
// celebrations count. So the tests here are about the two ways this page can
// quietly rot.
//
// The first is DRIFT: the page ships 199, "מינימום 100" and 23 as real markup so
// it reads complete before any fetch lands. That seeded copy is exactly what
// turns stale the day the owner changes a price — hence the assertions that the
// rendered number FOLLOWS the API rather than merely equalling today's default.
// A test that only asserted "199" would pass forever and prove nothing.
//
// The second is the page losing its single job: one action, one destination.
import { test, expect } from '@playwright/test';

const SHIPPED_FAQ = 5;

test.describe('one offer, one action', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/lp.html');
  });

  test('every ordering CTA points at the same place and is counted the same way', async ({
    page,
  }) => {
    const ctas = page.locator('a[data-ga="order_started"]');
    // Header, hero, final. A fourth destination appearing here is the page
    // growing a second job.
    await expect(ctas).toHaveCount(3);
    for (const cta of await ctas.all()) {
      await expect(cta).toHaveAttribute('href', 'products.html');
    }
    // Each one names its own place, or the funnel cannot tell them apart.
    const places = await ctas.evaluateAll((els) => els.map((el) => el.dataset.gaCta));
    expect(new Set(places).size).toBe(places.length);
  });

  test('the hero offers no competing action beside the CTA', async ({ page }) => {
    // Above the fold there is one link out that is not the logo: the order CTA.
    // A nav menu, a "learn more", a second offer — each one is a way to leave
    // without converting, and this is the assertion that keeps them off.
    const heroLinks = page.locator('.hero a, .lp-header a');
    const hrefs = await heroLinks.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
    for (const href of hrefs) {
      expect(['products.html', 'index.html']).toContain(href);
    }
  });

  test('the final CTA repeats the hero CTA word for word', async ({ page }) => {
    const hero = page.locator('[data-edit="lp-hero-cta"]');
    const final = page.locator('[data-edit="lp-final-cta"]');
    expect((await final.innerText()).trim()).toBe((await hero.innerText()).trim());
  });

  test('no dead links', async ({ page }) => {
    // A button pointing at "#" looks live and does nothing.
    await expect(page.locator('a[href="#"]')).toHaveCount(0);
  });
});

test.describe('it does not compete with the home page for the same search', () => {
  test('the page is noindex', async ({ page }) => {
    await page.goto('/lp.html');
    const robots = page.locator('meta[name="robots"]');
    await expect(robots).toHaveAttribute('content', /noindex/);
  });

  test('it still carries its own title, description and share image', async ({ page }) => {
    await page.goto('/lp.html');
    await expect(page).toHaveTitle(/דוגרי/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /3 ימי עסקים/
    );
    // Absolute, and on the apex: a relative og:image is dropped by every
    // scraper, and www.dugri-israel.co.il does not resolve.
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      'https://dugri-israel.co.il/assets/hero-1.jpg'
    );
  });
});

test.describe('the numbers follow their source', () => {
  test('the price is whatever /api/pricing says, not the seeded 199', async ({ page }) => {
    await page.route('**/api/pricing', (route) =>
      route.fulfill({
        json: {
          store: { now: 214, was: 268 },
          versions: {
            pdf: { enabled: false, price: 79 },
            pickup: { enabled: true, price: 214 },
            delivery: { enabled: false, price: 214 },
            custom: { enabled: false, price: 599 },
          },
          delivery_fee: 0,
          sale: { on: true, label: 'מחיר השקה', banner: '' },
          delivery_exceptions: { count: 0, eta_days: 11 },
        },
      })
    );
    await page.goto('/lp.html');
    await expect(page.getByTestId('lp-price-now')).toHaveText('214');
    await expect(page.getByTestId('lp-price-was')).toHaveText('268');
    // Sale on: the struck price is a CLAIM, and it is only shown once the
    // server has confirmed it.
    await expect(page.locator('.was')).toBeVisible();
  });

  test('FAILS SAFE: a broken pricing API leaves the seeded price standing', async ({ page }) => {
    await page.route('**/api/pricing', (route) => route.abort('failed'));
    await page.goto('/lp.html');
    await expect(page.getByTestId('lp-price-now')).toHaveText('199');
    // No confirmed sale means no struck price: we do not claim a discount we
    // could not read.
    await expect(page.locator('.was')).toBeHidden();
  });

  test('the FAQ is the owner list, and survives a broken API', async ({ page }) => {
    await page.route('**/api/faq', (route) =>
      route.fulfill({
        json: {
          items: [{ id: 'x', q: 'שאלה מהשרת', a: 'תשובה מהשרת', link_text: '', link_url: '' }],
        },
      })
    );
    await page.goto('/lp.html');
    await expect(page.locator('#faqList details')).toHaveCount(1);
    await expect(page.locator('#faqList summary').first()).toHaveText('שאלה מהשרת');

    await page.unroute('**/api/faq');
    await page.route('**/api/faq', (route) => route.abort('failed'));
    await page.goto('/lp.html');
    await expect(page.locator('#faqList details')).toHaveCount(SHIPPED_FAQ);
  });

  test('a zero celebrations count never replaces the seeded one', async ({ page }) => {
    // "0 חגיגות עד היום" under a claim that people love this is worse than no
    // proof at all, so only a real positive number is allowed to win.
    await page.route('**/api/stats/orders', (route) => route.fulfill({ json: { count: 0 } }));
    await page.goto('/lp.html');
    await expect(page.getByTestId('orders-count')).toHaveText('23');

    await page.unroute('**/api/stats/orders');
    await page.route('**/api/stats/orders', (route) => route.fulfill({ json: { count: 41 } }));
    await page.goto('/lp.html');
    await expect(page.getByTestId('orders-count')).toHaveText('41');
  });
});

test.describe('proof sits with the claim', () => {
  test('a testimonial is above the fold on every screen', async ({ page }) => {
    await page.goto('/lp.html');
    const quote = page.locator('.proof__quote');
    await expect(quote).toBeVisible();
    const box = await quote.boundingBox();
    const viewport = page.viewportSize();
    // The FOLD, not "near the top": whatever the device, the visitor reads the
    // claim and the evidence for it without scrolling. This runs on Desktop
    // Chrome and on an iPhone 14, and the phone is the one that catches a hero
    // that has quietly grown.
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });

  test('every screenshot carries its quote as text', async ({ page }) => {
    await page.goto('/lp.html');
    const shots = page.getByTestId('proof-reviews').locator('figure');
    await expect(shots).toHaveCount(4);
    for (const shot of await shots.all()) {
      // Alt text AND a visible caption: the proof has to survive an image that
      // never loads.
      const alt = await shot.locator('img').getAttribute('alt');
      expect(alt.trim().length).toBeGreaterThan(10);
      expect((await shot.locator('figcaption').innerText()).trim().length).toBeGreaterThan(10);
    }
  });
});

test.describe('the tagline reveal', () => {
  test('ships as one readable sentence and is split into lit words', async ({ page }) => {
    await page.goto('/lp.html');
    const tagline = page.getByTestId('lp-tagline');
    const words = tagline.locator('span.w');
    // The split is JS-side so a screen reader announces a sentence, not thirty
    // fragments — but once JS has run, every word is its own target.
    await expect(words.first()).toBeVisible();
    expect(await words.count()).toBeGreaterThan(10);

    await tagline.scrollIntoViewIfNeeded();
    // Scroll past it so every word has crossed the middle band.
    await page.mouse.wheel(0, 600);
    await expect(words.first()).toHaveClass(/lit/);
  });

  test('reduced motion reads it at full contrast immediately', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/lp.html');
    const tagline = page.getByTestId('lp-tagline');
    await expect(tagline).toBeVisible();
    // No splitting, no muting: the sentence is simply the sentence.
    await expect(tagline.locator('span.w')).toHaveCount(0);
    await expect(tagline).toContainText('שולחים מילים');
  });

  test('sections are visible with reduced motion, not left mid-animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/lp.html');
    // [data-rise] hides its target until an observer releases it. Under reduced
    // motion nothing hides in the first place — this is the assertion that the
    // page cannot ship blank to anyone who turned motion off.
    for (const section of await page.locator('[data-rise]').all()) {
      await expect(section).toBeVisible();
    }
  });
});

test.describe('accessible and reachable', () => {
  test('a keyboard user can skip the header', async ({ page }) => {
    await page.goto('/lp.html');
    const skip = page.locator('a.skip');
    await expect(skip).toHaveAttribute('href', '#main');
    await skip.focus();
    await expect(skip).toBeFocused();
    // Off-screen until focused, on-screen once it is. Polled, because it
    // arrives on the page's 700ms curve rather than instantly — reading the box
    // once catches it mid-slide.
    await expect
      .poll(async () => (await skip.boundingBox()).y, { timeout: 2000 })
      .toBeGreaterThanOrEqual(0);
  });

  test('there is a way back to the site', async ({ page }) => {
    await page.goto('/lp.html');
    await expect(page.locator('.lp-foot a[href="index.html"]')).toBeVisible();
  });

  // Split the heading into per-word spans, group the spans by the line box they
  // landed on, and hand back how many words each rendered line holds. This is
  // the only way to SEE a wrap: the DOM has no notion of a line, and a heading
  // that reads perfectly at one width strands a word at another.
  async function wordsPerLine(page, selector) {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const original = el.innerHTML;
      // Keep the authored <br>: it is part of how the heading breaks.
      el.innerHTML = original
        .split(/(<br\s*\/?>)/i)
        .map((chunk) =>
          /^<br/i.test(chunk)
            ? chunk
            : chunk
                .split(/\s+/)
                .filter(Boolean)
                .map((w) => `<span data-w>${w}</span>`)
                .join(' ')
        )
        .join('');
      const lines = new Map();
      for (const span of el.querySelectorAll('[data-w]')) {
        const top = Math.round(span.getBoundingClientRect().top);
        lines.set(top, (lines.get(top) || 0) + 1);
      }
      el.innerHTML = original;
      return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
    }, selector);
  }

  test('the hero heading never strands a word on a line of its own', async ({ page }) => {
    await page.goto('/lp.html');
    // Runs on both projects, and the phone is the one that catches it: at 36px
    // the first authored line wrapped and left "מילים." alone.
    expect(await wordsPerLine(page, '.hero h1')).not.toContain(1);
  });

  test('the hero heading and its subheading share one 680px measure', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/lp.html');
    const heading = await page.locator('.hero h1').boundingBox();
    const sub = await page.locator('.hero__sub').boundingBox();
    expect(heading.width).toBeLessThanOrEqual(680);
    expect(sub.width).toBeLessThanOrEqual(680);
  });
});
