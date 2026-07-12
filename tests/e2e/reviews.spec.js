import { test, expect } from '@playwright/test';

// Regression for the "reviews show blank cards" bug: the testimonials section
// (site/index.html #reviewsTrack) is a carousel of real WhatsApp screenshots.
// It used to be a `slideshow` carousel with no arrows/dots/autoplay, which in the
// RTL layout initialized to an off-screen/empty scroll position — so the visible
// slot was blank even though the images loaded fine. It is now a swipeable
// `scroller` (like the products rail), which renders the screenshots at the
// scroll origin. Guard that at least one review screenshot is actually visible
// in the viewport when the section is on screen.

test.describe('reviews section shows the testimonials (not blank)', () => {
  test('a review screenshot is loaded and visible in the viewport', async ({ page }) => {
    await page.goto('/index.html');
    await page.locator('#reviews').scrollIntoViewIfNeeded();
    // let the carousel settle at its initial position
    await page.waitForTimeout(500);

    const visible = await page.evaluate(() => {
      const vw = window.innerWidth;
      const imgs = [...document.querySelectorAll('#reviewsTrack .review img')];
      // "visible" = the image actually loaded (naturalWidth>0), has a real
      // rendered size, and overlaps the horizontal viewport (not scrolled off).
      return imgs.some((im) => {
        const r = im.getBoundingClientRect();
        return im.naturalWidth > 0 && r.width > 40 && r.height > 40 && r.right > 0 && r.left < vw;
      });
    });
    expect(visible).toBe(true);
  });
});
