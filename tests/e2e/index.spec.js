import { test, expect } from '@playwright/test';

// Landing page first-impression guarantees:
// - the new tagline copy is present and exact,
// - a real product visual appears high in the hero (above the fold),
// - launch/FOMO urgency is shown near the hero CTA,
// - the price CTA label + price + ₪ never wrap onto a second line.

test.describe('landing page hero', () => {
  test('shows the exact new tagline copy', async ({ page }) => {
    await page.goto('/index.html');
    const tagline = page.locator('.tagline');
    await expect(tagline).toBeVisible();
    const text = (await tagline.innerText()).replace(/\s+/g, ' ').trim();
    expect(text).toContain('שלחו לנו את הסיפורים שרק אתם מכירים.');
    expect(text).toContain('אנחנו נהפוך אותם למשחק שיפוצץ את הערב');
    // The old tagline must be gone.
    expect(text).not.toContain('בלי פילטרים');
    // Brand rule: never the trademarked word.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('אליאס');
  });

  test('both tagline lines paint their gradient (line 1 is not invisible)', async ({ page }) => {
    await page.goto('/index.html');
    // The gradient-clip must live on each line, and neither line may have a
    // partial-opacity layer — otherwise line 1 paints transparent over the bg.
    for (const sel of ['.tagline-1', '.tagline-2']) {
      const s = await page.locator(sel).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundImage, opacity: cs.opacity };
      });
      expect(s.bg).toContain('gradient');
      expect(parseFloat(s.opacity)).toBe(1);
    }
  });

  test('a real product visual (hero video) appears above the fold in the hero', async ({
    page,
  }) => {
    await page.goto('/index.html');
    const heroVideo = page.locator('[data-testid="hero-video"] video');
    await expect(heroVideo).toBeVisible();
    const box = await heroVideo.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    // The product visual must start within the first viewport (above the fold).
    expect(box.y).toBeLessThan(viewport.height);
  });

  test('shows tasteful launch / FOMO urgency near the hero CTA', async ({ page }) => {
    await page.goto('/index.html');
    const offer = page.locator('.launch-offer');
    await expect(offer).toBeVisible();
    const text = await offer.innerText();
    expect(text).toContain('מבצע השקה');
  });
});

test.describe('price CTA wrapping', () => {
  // The sticky bottom CTA is the worst offender on narrow phones.
  test('sticky price CTA keeps label + price + ₪ on one line at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/index.html');
    const cta = page.locator('#stickyOrder');
    await expect(cta).toBeVisible();

    // The price and ₪ live inside a nowrap span so they can never split.
    const nowrap = cta.locator('span');
    await expect(nowrap).toHaveCount(1);
    await expect(nowrap).toHaveText('79 ₪');
    await expect(nowrap).toHaveCSS('white-space', 'nowrap');

    // The whole button must render as a single line (height ~ one line of text).
    const metrics = await cta.evaluate((el) => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || el.clientHeight;
      return { scrollHeight: el.scrollHeight, lineHeight: lh };
    });
    // Allow padding; one line of content => scrollHeight under two line-heights.
    expect(metrics.scrollHeight).toBeLessThan(metrics.lineHeight * 2 + 36);

    // And it must fit horizontally — no clipped/overflowing label or numbers.
    const overflowX = await cta.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflowX).toBeLessThanOrEqual(1);
  });
});

test.describe('audience "who is this game for" section', () => {
  const LABELS = ['מסיבת רווקות', 'יום הולדת עגול', 'יום נישואין', 'פרישה'];

  test('is present with all event labels', async ({ page }) => {
    await page.goto('/index.html');
    const section = page.locator('[data-testid="audience"]');
    await expect(section).toBeVisible();
    const grid = page.locator('[data-testid="audience-grid"]');
    // The 5 event cards (round-birthday merged into one).
    await expect(grid.locator('.aud-card')).toHaveCount(LABELS.length);
    const text = await grid.innerText();
    for (const label of LABELS) {
      expect(text).toContain(label);
    }
  });
});

test.describe('real contact info', () => {
  test('Instagram link resolves to dugri_israel with no placeholder', async ({ page }) => {
    await page.goto('/index.html');
    const ig = page.locator('#igLink');
    await expect(ig).toHaveAttribute('href', 'https://instagram.com/dugri_israel');
    await expect(ig).toHaveText('@dugri_israel');
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
  test('proof section shows exactly 3 real review images that load (200) and no placeholders', async ({
    page,
    request,
  }) => {
    await page.goto('/index.html');

    const reviews = page.locator('[data-testid="proof-reviews"] img');
    await expect(reviews).toHaveCount(3);

    const srcs = await reviews.evaluateAll((els) => els.map((img) => img.getAttribute('src')));
    expect(srcs.length).toBe(3);
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
});

test.describe('real party video clips', () => {
  test('hero + proof clips are muted-loop-autoplay and their files load (200)', async ({
    page,
    request,
  }) => {
    await page.goto('/index.html');

    // One eye-catching loop in the hero, two in the social-proof row.
    await expect(page.locator('[data-testid="hero-video"] video')).toHaveCount(1);
    await expect(page.locator('[data-testid="proof-clips"] video')).toHaveCount(2);

    // Every clip must be muted/loop/playsinline (so inline autoplay works) and
    // sourced from assets/video.
    const clips = await page.locator('video source').evaluateAll((els) =>
      els
        .map((s) => ({
          src: s.getAttribute('src'),
          muted: s.closest('video').hasAttribute('muted'),
          loop: s.closest('video').hasAttribute('loop'),
          playsinline: s.closest('video').hasAttribute('playsinline'),
        }))
        .filter((c) => c.src && c.src.includes('assets/video/'))
    );
    expect(clips.length).toBe(3);
    for (const c of clips) {
      expect(c.muted && c.loop && c.playsinline, `${c.src} must be muted/loop/playsinline`).toBe(
        true
      );
      // The committed file must actually be served (catches a broken/typo'd src).
      const res = await request.get('/' + c.src);
      expect(res.status(), `${c.src} should load`).toBe(200);
    }
  });
});
