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
    expect(text).toContain('שלחו לנו את הסיפורים המביכים.');
    expect(text).toContain('אנחנו נהפוך אותם למשחק שיפוצץ את הערב');
    // The old tagline must be gone.
    expect(text).not.toContain('בלי פילטרים');
    // Brand rule: never the trademarked word.
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('אליאס');
  });

  test('a real product image appears above the fold in the hero', async ({ page }) => {
    await page.goto('/index.html');
    const heroImg = page.locator('.hero-img img');
    await expect(heroImg).toBeVisible();
    const box = await heroImg.boundingBox();
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
  });
});

test.describe('audience "who is this game for" section', () => {
  const LABELS = [
    'מסיבת רווקות',
    'יום הולדת 30',
    'יום הולדת 40',
    'יום הולדת 50',
    'יום הולדת 60',
    'יום נישואין',
    'פרישה',
    'מסיבת פרידה',
  ];

  test('is present with all event labels', async ({ page }) => {
    await page.goto('/index.html');
    const section = page.locator('[data-testid="audience"]');
    await expect(section).toBeVisible();
    const grid = page.locator('[data-testid="audience-grid"]');
    // At least the 8 event cards.
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
