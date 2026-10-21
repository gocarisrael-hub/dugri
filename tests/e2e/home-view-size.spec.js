// @ts-check
// The tapped design's view (new.html) on a computer: the window's height sets the board's size, up to 800 CSS px.
// The owner's main screen is a 3440x1440 display at 1 device pixel per CSS pixel, where the old 520 px cap drew the cards
// ~185 px wide and their hairlines soft; more source pixels could not fix that, a bigger board does. What this pins, per window:
// - the board's width is min(80vw, 800, 37vh * 1.414) and each card is 31% of it;
// - the name, the price, the button and the note still fit on the screen under the pictures;
// - every picture is drawn from a file at least as wide as the screen draws it.
// Runs on WebKit too (WEBKIT_SPECS in playwright.config.js): Safari is what the owner uses.
import { test, expect } from '@playwright/test';

const WINDOWS = [
  // [width, height, dpr]
  [3440, 1440, 1],
  [1920, 1080, 1],
  [1440, 900, 2],
];

for (const [w, h, dpr] of WINDOWS)
  test.describe(`the design view at ${w}x${h} (${dpr}x)`, () => {
    test.use({
      viewport: { width: w, height: h },
      deviceScaleFactor: dpr,
      isMobile: false,
      hasTouch: false,
    });

    test('the board follows the window up to 800 px, the cards follow the board, and the info still fits', async ({
      page,
    }) => {
      await page.goto('/new.html');
      const tile = page.locator('#strip .dz:not([aria-hidden])[data-k="birthday"]');
      await tile.scrollIntoViewIfNeeded();
      await tile.click();
      await expect(page.locator('#flood')).toHaveAttribute('open', '');
      await page.waitForTimeout(1500); // the pictures have landed and their opening animations are dropped
      const g = await page.evaluate(() => {
        const box = (s) => {
          const el = /** @type {HTMLElement} */ (document.querySelector(s));
          return { w: el.offsetWidth, bottom: el.getBoundingClientRect().bottom };
        };
        return { bd: box('#tableau .bd'), fr: box('#tableau .fr'), note: box('#flood .note') };
      });
      const want = Math.min(0.8 * w, 800, 0.37 * h * 1.414);
      expect(Math.abs(g.bd.w - want)).toBeLessThanOrEqual(2);
      expect(Math.abs(g.fr.w - 0.31 * want)).toBeLessThanOrEqual(2);
      expect(g.note.bottom).toBeLessThanOrEqual(h);
    });

    test('every picture in the view is drawn from a file at least as wide as the screen draws it', async ({
      page,
    }) => {
      await page.goto('/new.html');
      const tile = page.locator('#strip .dz:not([aria-hidden])[data-k="birthday"]');
      await tile.scrollIntoViewIfNeeded();
      await tile.click();
      await expect(page.locator('#flood')).toHaveAttribute('open', '');
      await page.waitForFunction(() =>
        [...document.querySelectorAll('#tableau img')].every(
          (i) =>
            /** @type {HTMLImageElement} */ (i).complete &&
            /** @type {HTMLImageElement} */ (i).naturalWidth
        )
      );
      // the file's own pixels (an <img> with a srcset reports naturalWidth already divided by the density it picked)
      const got = await page.locator('#tableau img').evaluateAll((els) =>
        Promise.all(
          els.map(
            (i) =>
              new Promise((ok) => {
                const probe = new window.Image();
                probe.onload = () =>
                  ok({
                    src: /** @type {HTMLImageElement} */ (i).currentSrc,
                    nat: probe.naturalWidth,
                    need: /** @type {HTMLElement} */ (i).offsetWidth * window.devicePixelRatio,
                  });
                probe.src = /** @type {HTMLImageElement} */ (i).currentSrc;
              })
          )
        )
      );
      expect(got).toHaveLength(3);
      for (const p of got) expect(p.nat, p.src).toBeGreaterThanOrEqual(p.need);
    });
  });
