import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// The wizard's top bar in redesign mode. Its links used to fan out into a row
// from 641px up — the old site's desktop header — where the shell header is a
// logo and a ≡ at every width. In the mode they now fold into the ≡ menu at every
// width. The live site keeps its desktop row.

for (const width of [1440, 390]) {
  test(`in the mode at ${width}: logo and ≡, the links only in the menu`, async ({ page }) => {
    await previewRedesign(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/options.html');
    await expect(page.locator('html')).toHaveClass(/\brd\b/);

    const toggle = page.locator('.nav-toggle');
    const links = page.locator('#navLinks');
    await expect(toggle).toBeVisible();
    await expect(links).toBeHidden();
    // The nav keeps its height: the no-scroll wizard is measured against it.
    const navH = await page.locator('.nav').evaluate((n) => n.getBoundingClientRect().height);
    expect(navH).toBeLessThanOrEqual(62);

    await toggle.click();
    await expect(links).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The menu opens under the bar, inside the page's width.
    const [nav, menu] = await Promise.all([
      page.locator('.nav').boundingBox(),
      links.boundingBox(),
    ]);
    expect(menu.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
    expect(menu.x).toBeGreaterThanOrEqual(-1);
    expect(menu.x + menu.width).toBeLessThanOrEqual(width + 1);
    await toggle.click();
    await expect(links).toBeHidden();
  });
}

test('the live site keeps its desktop link row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/options.html');
  await expect(page.locator('html')).not.toHaveClass(/\brd\b/);
  await expect(page.locator('#navLinks')).toBeVisible();
  await expect(page.locator('.nav-toggle')).toBeHidden();
});
