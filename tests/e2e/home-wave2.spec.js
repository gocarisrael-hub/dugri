import { test, expect } from '@playwright/test';

// Homepage "wave 2" improvements (site/index.html):
//  I5  — a compact "מה זה דוגרי?" explainer section between the marquee ribbon
//        and the products rail.
//  I3  — a bordered celebrations-counter box whose number comes from the public
//        /api/stats/orders endpoint, with a graceful fallback to the shipped 23.
//  I4a — the marquee phrases carry a per-phrase data-edit key on EVERY clone so
//        the owner can retitle them from the inline content editor.
//  I4b — the "our story" photos are now real, owner-replaceable <img> elements.
//
// The stats endpoint is added by a separate agent and does not exist in this
// worktree's server, so every counter test MOCKS the route — keeping the specs
// deterministic and independent of that work.

test.describe('I5 — "מה זה דוגרי?" explainer', () => {
  test('shows the heading + the exact two-sentence body, between marquee and products', async ({
    page,
  }) => {
    await page.goto('/index.html');

    const about = page.getByTestId('home-about');
    await expect(about).toHaveCount(1);

    const heading = about.locator('h2[data-edit="index-about-heading"]');
    await expect(heading).toHaveText('מה זה דוגרי?');

    const body = about.locator('p[data-edit="index-about-body"]');
    await expect(body).toHaveCount(1);
    // Both locked sentences are present.
    await expect(body).toContainText('משחק ניחוש מילים שכולו על האדם שחוגגים');
    await expect(body).toContainText('אנחנו מעצבים חפיסה ולוח');
    await expect(body).toContainText(
      'פותחים במסיבה, מתחלקים לקבוצות, ומגלים מי באמת מכיר את בעל השמחה'
    );

    // Document order: marquee → about → products.
    const order = await page.evaluate(() => {
      const marquee = document.querySelector('[data-testid="hero-marquee"]');
      const about = document.querySelector('[data-testid="home-about"]');
      const products = document.querySelector('[data-testid="home-products"]');
      const FOLLOWING = window.Node.DOCUMENT_POSITION_FOLLOWING;
      return {
        aboutAfterMarquee: !!(marquee.compareDocumentPosition(about) & FOLLOWING),
        productsAfterAbout: !!(about.compareDocumentPosition(products) & FOLLOWING),
      };
    });
    expect(order.aboutAfterMarquee).toBe(true);
    expect(order.productsAfterAbout).toBe(true);
  });
});

test.describe('I3 — celebrations counter box', () => {
  test('renders the live count from /api/stats/orders (no "+")', async ({ page }) => {
    await page.route('**/api/stats/orders', (route) => route.fulfill({ json: { count: 42 } }));
    await page.goto('/index.html');

    const count = page.getByTestId('orders-count');
    await expect(count).toHaveText('42');

    // A clean number, never a "+" suffix, sitting in one bordered box with a label.
    const box = page.locator('.stat-box');
    await expect(box).toHaveCount(1);
    await expect(box).toContainText('חגיגות עד היום');
    await expect(box).not.toContainText('+');
    const border = await box.evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(parseFloat(border)).toBeGreaterThan(0);
  });

  test('falls back to 23 when the stats endpoint fails (never blank/broken)', async ({ page }) => {
    await page.route('**/api/stats/orders', (route) =>
      route.fulfill({ status: 500, body: 'boom' })
    );
    await page.goto('/index.html');

    const count = page.getByTestId('orders-count');
    await expect(count).toHaveText('23');
    await expect(count).not.toHaveText('');
  });

  test('a 200 with a null/zero count does NOT overwrite the safe 23 default', async ({ page }) => {
    // A valid HTTP 200 whose payload is nullish or 0 must not render a misleading
    // "0 חגיגות" — the shipped 23 stays until a real positive number arrives.
    await page.route('**/api/stats/orders', (route) => route.fulfill({ json: { count: null } }));
    await page.goto('/index.html');
    await expect(page.getByTestId('orders-count')).toHaveText('23');
  });
});

test.describe('marquee ribbon stays a seamless loop', () => {
  test('the two halves are pixel-identical text (separators untagged)', async ({ page }) => {
    // (Marquee text-editing is deferred until the content editor can sync all
    // duplicated clones; for now just guard the seamless-loop invariant.)
    await page.goto('/index.html');
    const marquee = page.getByTestId('hero-marquee');
    const texts = await marquee
      .locator('.marquee__half')
      .evaluateAll((els) => els.map((el) => el.innerText));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe(texts[1]);
  });
});

test.describe('I4b — "our story" photos are editable images', () => {
  test('both story photos are real <img> with a data-edit-img key and a default src', async ({
    page,
    request,
  }) => {
    await page.goto('/index.html');

    const photos = page.locator('#story .story-photo img');
    await expect(photos).toHaveCount(2);

    await expect(page.locator('#story img[data-edit-img="index-story-photo-1"]')).toHaveCount(1);
    await expect(page.locator('#story img[data-edit-img="index-story-photo-2"]')).toHaveCount(1);

    const srcs = await photos.evaluateAll((els) => els.map((img) => img.getAttribute('src')));
    for (const src of srcs) {
      expect(src).toBeTruthy();
      const res = await request.get('/' + src);
      expect(res.status(), `${src} should load`).toBe(200);
    }
  });
});
