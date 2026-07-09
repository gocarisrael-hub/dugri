import { test, expect } from '@playwright/test';

// The hero marquee ribbon (site/index.html, .marquee / .marquee__track) is a
// slim strip under the hero whose three phrases scroll endlessly. The page is
// dir="rtl", but the scroll keyframe animates translateX 0 → -50% (an
// LTR-direction move), played in `reverse` on the track so the content travels
// the other way: it enters from the LEFT and exits RIGHT. Because `reverse`
// traverses the exact same set of track positions as the forward animation (just
// in the opposite temporal order), the two-halves loop stays seamless either way.
// Regression guard for the RTL bug: in an RTL container the track was anchored to
// the RIGHT and overflowed LEFT, so translating negative marched the whole strip
// off the left edge and left the strip BLANK before the animation reset. The fix
// forces the strip (and track) to `direction: ltr` so the track anchors at left=0
// and the two-halves loop scrolls seamlessly, while each Hebrew phrase still
// renders RTL via inherent bidi + unicode-bidi: isolate.

test.describe('hero marquee: true endless loop, never blank', () => {
  test('a single half is at least as wide as the strip (phase-independent seamlessness)', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.waitForSelector('.marquee__half');
    // The track is two identical halves and the keyframe shifts by exactly one
    // half-width (translateX -50%). For the strip to stay covered at EVERY phase
    // — including translateX(-50%), which a short timed sample of a 26s animation
    // never reaches — one half must be at least as wide as the strip. If a future
    // edit drops marquee groups so a half becomes narrower than the viewport, a
    // blank appears around -50%; this invariant catches that directly, regardless
    // of animation phase. Phrase widths depend on the webfont, so wait for it.
    const { halfW, stripW } = await page.evaluate(async () => {
      await document.fonts.ready;
      const half = document.querySelector('.marquee__half');
      const strip = document.querySelector('.marquee');
      return {
        halfW: half.getBoundingClientRect().width,
        stripW: strip.getBoundingClientRect().width,
      };
    });
    expect(halfW).toBeGreaterThanOrEqual(stripW);
  });

  test('the track always covers the visible strip while scrolling (no blank edge)', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.waitForSelector('.marquee__track');

    // Sample the track vs. the strip while it scrolls: at every sample the track
    // must cover the strip (left edge no further right than the strip's left, and
    // right edge no further left than the strip's right) or a blank edge shows.
    // The pre-fix bug exposed a monotonically growing gap within the first
    // second, so a short window catches it; the half-width invariant above covers
    // the worst-case phase a short window can't reach.
    const result = await page.evaluate(async () => {
      await document.fonts.ready; // phrase widths depend on the loaded webfont
      const track = document.querySelector('.marquee__track');
      const strip = document.querySelector('.marquee');
      let worstGap = -Infinity; // >0 px means a blank edge was exposed
      let samples = 0;
      const durationMs = 2500;
      const start = Date.now();
      return await new Promise((resolve) => {
        function tick() {
          const t = track.getBoundingClientRect();
          const s = strip.getBoundingClientRect();
          worstGap = Math.max(worstGap, t.left - s.left, s.right - t.right);
          samples++;
          if (Date.now() - start < durationMs) requestAnimationFrame(tick);
          else resolve({ worstGap, samples });
        }
        requestAnimationFrame(tick);
      });
    });

    // Don't assume a frame rate (headless CI may throttle rAF); a handful of
    // samples is enough given the growing-gap bug and the invariant above.
    expect(result.samples).toBeGreaterThan(5);
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

  test('the content scrolls rightward (enters from the left, exits right)', async ({ page }) => {
    await page.goto('/index.html');
    await page.waitForSelector('.marquee__track');
    // The animation runs in `reverse`, so the track's translateX increases over
    // time (moves rightward). Sample the track's left edge across many frames and
    // require rightward motion to dominate. Counting the sign of per-frame deltas
    // (rather than start-vs-end) is robust to the single leftward jump when the
    // 26s loop resets, which would otherwise mask the direction in a short window.
    const { rightwardFrames, leftwardFrames } = await page.evaluate(async () => {
      await document.fonts.ready; // phrase widths depend on the loaded webfont
      const track = document.querySelector('.marquee__track');
      let prev = track.getBoundingClientRect().left;
      let rightwardFrames = 0;
      let leftwardFrames = 0;
      const durationMs = 1500;
      const start = Date.now();
      return await new Promise((resolve) => {
        function tick() {
          const left = track.getBoundingClientRect().left;
          const delta = left - prev;
          if (delta > 0.1) rightwardFrames++;
          else if (delta < -0.1) leftwardFrames++;
          prev = left;
          if (Date.now() - start < durationMs) requestAnimationFrame(tick);
          else resolve({ rightwardFrames, leftwardFrames });
        }
        requestAnimationFrame(tick);
      });
    });
    // Rightward motion must dominate; at most one leftward frame (the loop reset).
    expect(rightwardFrames).toBeGreaterThan(5);
    expect(leftwardFrames).toBeLessThanOrEqual(1);
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
