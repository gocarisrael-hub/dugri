import { test, expect } from '@playwright/test';

// The homepage's GA events in a real browser (site/js/home-analytics.js). GA
// never loads on localhost, so the page's own gtag stub queue (dataLayer) is
// what the events look like.
const events = (page, name) =>
  page.evaluate(
    (n) =>
      (window.dataLayer || [])
        .map((a) => Array.from(a))
        .filter((a) => a[0] === 'event' && a[1] === n)
        .map((a) => a[2] || {}),
    name
  );

test('section_view: the hero at once, the rest as she scrolls, each once', async ({ page }) => {
  await page.goto('/');
  await expect.poll(() => events(page, 'section_view')).toContainEqual({ section: 'hero' });
  expect(await events(page, 'section_view')).not.toContainEqual({ section: 'footer' });

  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect.poll(() => events(page, 'section_view')).toContainEqual({ section: 'footer' });
  await page.locator('#top').scrollIntoViewIfNeeded();
  await page.locator('footer').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const footers = (await events(page, 'section_view')).filter((e) => e.section === 'footer');
  expect(footers).toHaveLength(1);
});

test('design_swipe: once, when she moves the designs rail', async ({ page }) => {
  await page.goto('/');
  const rail = page.locator('#productsTrack');
  await rail.scrollIntoViewIfNeeded();
  await expect(rail.locator('.home-prod-card').first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(await events(page, 'design_swipe')).toHaveLength(0);

  const box = await rail.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(400, 0);
  await expect.poll(async () => (await events(page, 'design_swipe')).length).toBe(1);
  await page.mouse.wheel(-400, 0);
  await page.waitForTimeout(500);
  expect(await events(page, 'design_swipe')).toHaveLength(1);
});
