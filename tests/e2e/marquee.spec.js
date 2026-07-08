import { test, expect } from '@playwright/test';

// The hero marquee ribbon (site/index.html, .marquee / .marquee__track) is a
// slim strip under the hero whose three phrases scroll endlessly. The page is
// dir="rtl", but the scroll keyframe animates translateX 0 → -50% (an
// LTR-direction move). Regression guard for the RTL bug: in an RTL container the
// track was anchored to the RIGHT and overflowed LEFT, so translating negative
// marched the whole strip off the left edge and left the strip BLANK before the
// animation reset. The fix forces the strip (and track) to `direction: ltr` so
// the track anchors at left=0 and the two-halves loop scrolls seamlessly, while
// each Hebrew phrase still renders RTL via inherent bidi + unicode-bidi: isolate.

test.describe('hero marquee: true endless loop, never blank', () => {
  test('the track always fully covers the visible strip (no blank edge, ever)', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.waitForSelector('.marquee__track');

    // Sample the track vs. the strip over a multi-second window using rAF, in the
    // page, so we catch the animation at many phases (including near the reset).
    // At EVERY sample the track must cover the strip: its left edge no further
    // right than the strip's left, and its right edge no further left than the
    // strip's right — otherwise a blank edge is exposed.
    const result = await page.evaluate(async () => {
      const track = document.querySelector('.marquee__track');
      const strip = document.querySelector('.marquee');
      let worstGap = -Infinity; // >0 px means a blank edge was exposed
      let samples = 0;
      const durationMs = 7000;
      const start = Date.now();
      return await new Promise((resolve) => {
        function tick() {
          const now = Date.now();
          const t = track.getBoundingClientRect();
          const s = strip.getBoundingClientRect();
          const leftGap = t.left - s.left; // >0 → blank on the left edge
          const rightGap = s.right - t.right; // >0 → blank on the right edge
          const gap = Math.max(leftGap, rightGap);
          if (gap > worstGap) worstGap = gap;
          samples++;
          if (now - start < durationMs) requestAnimationFrame(tick);
          else resolve({ worstGap, samples });
        }
        requestAnimationFrame(tick);
      });
    });

    // Enough samples that the assertion is meaningful (rAF ≈ 60fps over 7s).
    expect(result.samples).toBeGreaterThan(100);
    // The strip must be covered at every moment: allow a 1px sub-pixel tolerance.
    expect(result.worstGap).toBeLessThanOrEqual(1);
  });

  test('the track is laid out LTR so the scroll direction matches the keyframe', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.waitForSelector('.marquee__track');
    // Root cause guard: if the strip/track ever reverts to RTL flow, the LTR
    // translateX keyframe marches it off-screen again.
    const dir = await page.$eval('.marquee__track', (el) => getComputedStyle(el).direction);
    expect(dir).toBe('ltr');
  });
});

test.describe('hero marquee: reduced motion', () => {
  test('prefers-reduced-motion disables the scroll animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/index.html');
    await page.waitForSelector('.marquee__track');
    const animationName = await page.$eval(
      '.marquee__track',
      (el) => getComputedStyle(el).animationName
    );
    expect(animationName).toBe('none');
  });
});
