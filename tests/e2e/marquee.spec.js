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

  test('the animation runs in reverse so the content scrolls the opposite way (enters left, exits right)', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.waitForSelector('.marquee__track');
    // Deterministic, no frame-rate dependence: the keyframe is a fixed
    // translateX(0 → -50%) leftward move, so running it in `reverse` makes the
    // track travel rightward instead (enters from the left, exits right). Assert
    // the computed animation-direction rather than sampling rAF frame deltas,
    // which throttle under CI parallel load and would flake red on a correct fix.
    const dir = await page.$eval(
      '.marquee__track',
      (el) => getComputedStyle(el).animationDirection
    );
    expect(dir).toBe('reverse');
  });
});

test.describe('hero marquee: owner-editable phrases (I4a)', () => {
  test('each of the 3 phrases carries its data-edit key on all 8 clones, separators untagged, halves identical', async ({
    page,
  }) => {
    await page.goto('/index.html');
    await page.waitForSelector('.marquee__half');

    const info = await page.evaluate(() => {
      const count = (sel) => document.querySelectorAll(sel).length;
      // The track is 2 halves × 4 phrase groups = 8 clones of each phrase.
      const keyed = {
        'index-marquee-1': count('[data-edit="index-marquee-1"]'),
        'index-marquee-2': count('[data-edit="index-marquee-2"]'),
        'index-marquee-3': count('[data-edit="index-marquee-3"]'),
      };
      // Separators must NOT be editable.
      const taggedSeparators = count('.marquee__sep[data-edit]');
      // The two halves must stay byte-identical so the translateX(-50%) loop is
      // seamless — compare their innerHTML directly.
      const halves = Array.from(document.querySelectorAll('.marquee__half'));
      const halvesIdentical = halves.length === 2 && halves[0].innerHTML === halves[1].innerHTML;
      // Each phrase's clones must all carry the SAME shipped text.
      const texts = (key) =>
        Array.from(document.querySelectorAll('[data-edit="' + key + '"]')).map((n) =>
          n.textContent.trim()
        );
      return {
        keyed,
        taggedSeparators,
        halvesIdentical,
        phrase1: texts('index-marquee-1'),
        phrase2: texts('index-marquee-2'),
        phrase3: texts('index-marquee-3'),
      };
    });

    expect(info.keyed['index-marquee-1']).toBe(8);
    expect(info.keyed['index-marquee-2']).toBe(8);
    expect(info.keyed['index-marquee-3']).toBe(8);
    expect(info.taggedSeparators).toBe(0);
    expect(info.halvesIdentical).toBe(true);
    expect(new Set(info.phrase1)).toEqual(new Set(['מפעילים את הטיימר']));
    expect(new Set(info.phrase2)).toEqual(new Set(['מנחשים מילים']));
    expect(new Set(info.phrase3)).toEqual(new Set(['הכל עליכם']));
  });

  test('a mocked override replaces the phrase across ALL clones for a visitor', async ({
    page,
  }) => {
    // applyOverrides sets textContent on every [data-edit] node on load, so an
    // owner override must land identically on all 8 clones (loop stays seamless).
    await page.route('**/api/content*', (route) =>
      route.fulfill({ json: { overrides: { 'index-marquee-1': { text: 'לוחצים על השעון' } } } })
    );
    await page.goto('/index.html');
    await page.waitForSelector('.marquee__half');
    const texts = await page.$$eval('[data-edit="index-marquee-1"]', (els) =>
      els.map((e) => e.textContent.trim())
    );
    expect(texts).toHaveLength(8);
    expect(new Set(texts)).toEqual(new Set(['לוחצים על השעון']));
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
