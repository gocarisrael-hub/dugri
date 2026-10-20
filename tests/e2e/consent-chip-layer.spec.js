import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// The one-time cookie chip (js/consent.js, #cookieNotice) is a small corner note, not a dialog. Anything that takes over
// the screen (a sheet, a photo viewer, a confirmation) has to cover it, so the chip never floats over a backdrop, where
// it reads as part of the open thing and takes its taps. It still stands clear of the short bars fixed to the foot of a
// page; that half is consent-chip-clearance.spec.js.
//
// "Covered" is measured the way a tap lands: the element at the chip's own centre is not the chip.

const chipHit = (page) =>
  page.evaluate(() => {
    const chip = document.querySelector('#cookieNotice');
    if (!chip) return 'missing';
    const r = chip.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top && chip.contains(top) ? 'chip' : 'covered';
  });

const phone = { width: 390, height: 844 };

test('the product photo viewer covers the chip', async ({ page }) => {
  await page.setViewportSize(phone);
  await page.goto('/product.html?design=bachelorette');
  await expect(page.locator('#cookieNotice')).toBeVisible();
  expect(await chipHit(page)).toBe('chip');
  await page.getByTestId('gallery-enlarge').click();
  await expect(page.getByTestId('pdp-zoom')).toBeVisible();
  expect(await chipHit(page)).toBe('covered');
});

test("the wizard's design viewer covers the chip (redesign mode, where step 3 shows the chosen design)", async ({
  page,
}) => {
  await previewRedesign(page);
  await page.setViewportSize(phone);
  await page.goto('/options.html?design=japanese&step=3');
  await expect(page.locator('#cookieNotice')).toBeVisible();
  const thumbs = page.getByTestId('chosen-design-pic');
  await expect(thumbs.nth(1)).toBeVisible();
  await thumbs.nth(1).click();
  await expect(page.getByTestId('deck-view')).toBeVisible();
  expect(await chipHit(page)).toBe('covered');
});

test("the friend coupon's sheet covers the chip, and before it opens the chip stands clear of the friend bar", async ({
  page,
  request,
}) => {
  const r = await request.post('/api/collections', { data: { honoree_name: 'Shira' } });
  expect(r.ok()).toBeTruthy();
  const { id } = await r.json();
  await page.setViewportSize(phone);
  await page.goto(`/collect.html?c=${id}`);
  await expect(page.locator('#cookieNotice')).toBeVisible();
  await page.locator('#wordInput').fill('w' + Math.random().toString(36).slice(2, 8));
  await page.locator('#addBtn').click();
  const bar = page.getByTestId('friend-bar');
  await expect(bar).toBeVisible();
  // The bar is fixed to the foot of the screen: the chip lifts above it and stays a working control.
  await expect.poll(() => chipHit(page)).toBe('chip');
  await expect(async () => {
    const b = await bar.boundingBox();
    const c = await page.locator('#cookieNotice').boundingBox();
    expect(c.y + c.height).toBeLessThanOrEqual(b.y);
  }).toPass({ timeout: 3000 });

  await page.getByTestId('friend-bar-go').click();
  await expect(page.getByTestId('friend-sheet')).toBeVisible();
  expect(await chipHit(page)).toBe('covered');
});
