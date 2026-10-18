import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';
import { previewRedesign } from './helpers/redesign.js';

// The chosen design on the title step (the owner, 2026-10-18). A buyer can now land on the title step straight from
// the homepage, without passing the product page, so in redesign mode the step opens with a compact box: the design's
// name and the product page gallery's own pictures of it. The live site does not show it.

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
});

test('in redesign mode the title step shows the chosen design with the product page pictures', async ({
  page,
}) => {
  await previewRedesign(page);
  // what the product page gallery shows for this design, in its order
  await page.goto('/product.html?design=japanese');
  const gallery = page.locator('[data-testid="pdp-gallery"] img');
  await expect(gallery.first()).toBeVisible();
  // a lazy slide may not have its src yet: read the attribute the page set, whichever it is
  const gallerySrcs = await gallery.evaluateAll((imgs) =>
    imgs
      .map((i) => i.getAttribute('src') || i.dataset.src || '')
      .filter(Boolean)
      .map((x) => new URL(x, location.href).pathname)
  );
  expect(gallerySrcs.length).toBeGreaterThan(0);

  await page.goto('/options.html?design=japanese&step=3');
  await expect(page.getByTestId('step-3')).toBeVisible();
  const box = page.getByTestId('chosen-design');
  await expect(box).toBeVisible();
  await expect(page.getByTestId('chosen-design-name')).toHaveText('טוקיו');
  const pics = page.locator('[data-testid="chosen-design-pics"] img');
  await expect(pics.first()).toBeVisible();
  expect(await pics.count()).toBeLessThanOrEqual(4);
  const boxSrcs = await pics.evaluateAll((imgs) => imgs.map((i) => new URL(i.src).pathname));
  // the same lead picture as the product page (its later slides load lazily, so only the first is comparable), and
  // every picture is this design's own
  expect(boxSrcs[0]).toBe(gallerySrcs[0]);
  for (const src of boxSrcs)
    expect(src).toMatch(/\/assets\/designs\/japanese\/|\/content-uploads\//);

  // nothing scrolls sideways on a phone
  const [sw, iw] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  expect(sw).toBeLessThanOrEqual(iw);

  // "החלפה" goes back to the designs, where the box is not shown
  await page.getByTestId('chosen-design-change').click();
  await expect(page.getByTestId('step-1')).toBeVisible();
  await expect(box).toBeHidden();
});

test('the live site does not show it', async ({ page }) => {
  await page.goto('/options.html?design=japanese&step=3');
  await expect(page.getByTestId('step-3')).toBeVisible();
  await expect(page.getByTestId('chosen-design')).toBeHidden();
});
