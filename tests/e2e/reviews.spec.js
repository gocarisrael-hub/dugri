import { test, expect } from '@playwright/test';

// Regression for the "reviews show blank cards" bug (site/index.html #reviewsTrack).
// The testimonials rail shows ONE full-width WhatsApp screenshot per view. It used
// to be a loop:slideshow carousel that, in the RTL layout, initialized to a
// mis-parked position — so the visible slot showed a blank gap/sliver even though
// the images loaded. It is now a `scroller` (RTL-safe initial position) with
// scroll-snap re-enabled so it rests one-per-view.
//
// The guard must be STRONG: because the carousel uses loop:true it clones the
// slides, so many .review img nodes merely *overlap* the viewport at any scroll
// offset — a weak "some image overlaps" check is trivially true even in the blank
// state. Instead we require that some review image actually FILLS and is CENTERED
// in the track (i.e. one screenshot properly on view), which the blank/sliver
// state fails. We also wait for a real image to decode rather than a fixed delay.

async function filledCenteredCount(page) {
  return page.evaluate(() => {
    const track = document.getElementById('reviewsTrack');
    const t = track.getBoundingClientRect();
    const center = t.left + t.width / 2;
    return [...document.querySelectorAll('#reviewsTrack .review img')].filter((im) => {
      const b = im.getBoundingClientRect();
      const ic = b.left + b.width / 2;
      // loaded, spans most of the track width, and centered in it (one-per-view)
      return (
        im.naturalWidth > 0 && b.width >= t.width * 0.7 && Math.abs(ic - center) <= t.width * 0.2
      );
    }).length;
  });
}

test.describe('reviews section shows the testimonials (not blank)', () => {
  test('a screenshot fills and centers the rail at load, and stays snapped after scrolling', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.locator('#reviews').scrollIntoViewIfNeeded();
    // wait for a real review image to actually decode (no fixed-timeout flake)
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#reviewsTrack .review img')].some((i) => i.naturalWidth > 0)
    );

    // exactly one screenshot is properly on view (fills + centered), not a blank sliver
    await expect.poll(() => filledCenteredCount(page)).toBeGreaterThan(0);

    // snap holds: scroll one screenshot over, and a review is again centered (not
    // resting half-and-half between two, which the pre-snap scroller would do)
    await page
      .locator('#reviewsTrack')
      .evaluate((el) => el.scrollBy({ left: -el.clientWidth, behavior: 'instant' }));
    await expect.poll(() => filledCenteredCount(page)).toBeGreaterThan(0);
  });
});
