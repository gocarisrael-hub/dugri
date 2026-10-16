import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// B's pages in redesign mode: products.html, product.html (the page and its catalog parts) and design-codes.html, restyled from
// css/rd/<page>.css alone (docs/redesign-mode.md). What these pin, at 360, 390 and 1440:
// - with the mode on: the shared header stands in for the shop's (none on the staff page); the page title has the coloured
//   offset; each design is a card of the game table's kind (paper, an ink outline, a hard shadow); the page's own footer, with
//   the owner's contacts, stays; nothing scrolls sideways;
// - with the mode off: the page is as it was: no rd class, the old header, no card shadow from the redesign.

const sideways = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const WIDTHS = [360, 390, 1440];
const hardShadow = /rgb\(0, 0, 0\) \d+px \d+px 0px/;

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test.describe('in redesign mode', () => {
      test.beforeEach(async ({ page }) => {
        await previewRedesign(page);
      });

      test('the store: its title, its cards and the shop’s footer', async ({ page }) => {
        await page.goto('/products.html');
        await expect(page.locator('.product-card').first()).toBeVisible();
        await expect(page.locator('head link[href*="/css/rd/products."]')).toHaveCount(1);
        await expect(page.locator('.rd-hdr')).toBeVisible();
        await expect(page.locator('header.hdr')).toBeHidden();
        await expect(page.locator('.store-head h1')).toHaveClass(/\brd-title\b/);
        await expect(page.locator('.store-head h1')).toHaveCSS(
          'text-shadow',
          /rgb\(95, 208, 245\)/
        );
        const cards = page.locator('.product-card');
        expect(await cards.count()).toBeGreaterThanOrEqual(6);
        await expect(cards.first()).toHaveClass(/\brd-card\b/);
        await expect(cards.first()).toHaveCSS('box-shadow', hardShadow);
        await expect(cards.first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
        await expect(page.locator('.product-name').first()).toHaveCSS('font-weight', '800');
        // the dots under a picture stay on one line
        const rows = await page
          .locator('.product-card__dots .carousel-dots')
          .first()
          .evaluate(
            (d) =>
              new Set([...d.children].map((c) => Math.round(c.getBoundingClientRect().top))).size
          );
        expect(rows).toBe(1);
        await expect(page.locator('body > footer .foot-icons')).toBeVisible();
        await expect(page.locator('.rd-ftr')).toHaveCount(0);
        expect(await sideways(page)).toBe(0);
      });

      test('a design’s page: the gallery, the sections, more designs', async ({ page }) => {
        await page.goto('/product.html?design=bachelorette');
        await expect(page.locator('head link[href*="/css/rd/product."]')).toHaveCount(1);
        await expect(page.locator('.rd-hdr')).toBeVisible();
        await expect(page.locator('.pdp-gallery')).toHaveCSS('box-shadow', hardShadow);
        await expect(page.locator('.pdp-gallery')).toHaveCSS(
          'background-color',
          'rgba(0, 0, 0, 0)'
        ); // the letterbox is the page
        for (const sec of await page.locator('.pdp-sec').all()) {
          await expect(sec).toHaveClass(/\brd-box\b/);
          await expect(sec).toHaveCSS('box-shadow', hardShadow);
        }
        await expect(page.locator('.pdp-title-note')).toHaveCSS(
          'background-color',
          'rgb(253, 242, 212)'
        );
        await expect(page.locator('.pdp-related-head h2')).toHaveClass(/\brd-title\b/);
        await expect(page.locator('.pdp-rel-card').first()).toHaveClass(/\brd-card\b/);
        await expect(page.locator('#pdpBuy')).toBeVisible(); // A's buy box is still there
        await expect(page.locator('body > footer')).toBeVisible();
        expect(await sideways(page)).toBe(0);
      });

      test('the staff codes page keeps its own top and takes the controls', async ({ page }) => {
        await page.goto('/design-codes.html?key=dugri-admin');
        await expect(page.locator('.panel').first()).toBeVisible();
        await expect(page.locator('.rd-hdr')).toHaveCount(0);
        await expect(page.locator('.panel').first()).toHaveClass(/\brd-box\b/);
        await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 241, 222)');
        await expect(page.locator('#code')).toHaveCSS('border-radius', '999px');
        expect(await sideways(page)).toBe(0);
      });
    });

    test.describe('with the mode off', () => {
      test('every page is as it was', async ({ page }) => {
        for (const url of [
          '/products.html',
          '/product.html?design=bachelorette',
          '/design-codes.html?key=dugri-admin',
        ]) {
          await page.goto(url);
          await expect(page.locator('html')).not.toHaveClass(/(^|\s)rd(\s|$)/);
          await expect(
            page.locator('head link[href*="/css/rd/"], head link[href*="/css/redesign."]')
          ).toHaveCount(0);
          await expect(page.locator('.rd-hdr, .rd-card, .rd-box, .rd-title')).toHaveCount(0);
        }
        await page.goto('/products.html');
        await expect(page.locator('header.hdr')).toBeVisible();
        await expect(page.locator('.product-card').first()).toHaveCSS('box-shadow', 'none');
      });
    });
  });
}
