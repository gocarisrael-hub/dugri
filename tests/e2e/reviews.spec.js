import { test, expect } from '@playwright/test';

// Regression for the "reviews show blank cards" bug (site/index.html #reviewsTrack).
// The testimonials rail shows ONE full-width WhatsApp screenshot per view. It used
// to be a loop:true slideshow, whose clones mis-parked the rail to a blank
// gap/sliver in the RTL layout — so the visible slot was empty even though the
// images loaded. It is now a slideshow with loop:false (no clones → correct start
// on the first review) and dots (a way to reach the others).
//
// The guard must be STRONG. Because the images span the track, a weak "some image
// overlaps the viewport" check is trivially true even in the blank half-and-half
// state. Instead we require a review image that FILLS (>=0.7 track width) and is
// CENTERED (within 0.2 track width of the track centre) — i.e. exactly one
// screenshot properly on view, which the blank/sliver state fails. We also wait
// for the image to actually decode rather than a fixed delay (no flake).

// Returns the filename of the review screenshot currently filling+centered in the
// rail, or null if none is (the blank state).
function centeredReviewSrc() {
  const track = document.getElementById('reviewsTrack');
  const t = track.getBoundingClientRect();
  const centre = t.left + t.width / 2;
  const on = [...document.querySelectorAll('#reviewsTrack .review img')].find((im) => {
    const b = im.getBoundingClientRect();
    return (
      im.naturalWidth > 0 &&
      b.width >= t.width * 0.7 &&
      Math.abs(b.left + b.width / 2 - centre) <= t.width * 0.2
    );
  });
  return on ? (on.currentSrc || on.src).split('/').pop() : null;
}

test.describe('reviews section shows the testimonials (not blank)', () => {
  test('the first testimonial fills the rail at load, and the dots reach the others', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.locator('#reviews').scrollIntoViewIfNeeded();
    // wait for a real review image to decode (no fixed-timeout flake)
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#reviewsTrack .review img')].some((i) => i.naturalWidth > 0)
    );

    // At load a single screenshot is properly on view (fills + centred) — this is
    // what failed in the blank/mis-parked state (a clone sliver is neither).
    await expect.poll(() => page.evaluate(centeredReviewSrc)).toBe('review-1.jpg');

    // One dot per review, and they navigate: clicking the 3rd brings review-3 fully
    // on view (proves the other testimonials are reachable and land aligned).
    const dots = page.locator('#reviews .carousel-dot');
    await expect(dots).toHaveCount(4);
    await dots.nth(2).click();
    await expect.poll(() => page.evaluate(centeredReviewSrc)).toBe('review-3.jpg');
  });
});
