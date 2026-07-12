import { test, expect } from '@playwright/test';

// B3 fix — buttons must feel instant to tap on iPhone. The press effect used to
// rely on ~0.3s transitions with no touch-action and a sticky :hover lift, which
// reads as sluggish/stuck on touch. This suite locks in the three guarantees of
// the fix, using only deterministic computed-style / CSSOM reads (no timing or
// animation sampling):
//   1. .btn declares `touch-action: manipulation` (kills iOS's ~300ms tap delay).
//   2. the `.btn:hover` lift lives inside an `@media (hover: hover)` block, so it
//      never sticks after a tap on a coarse pointer.
//   3. the `.btn` color/wipe transition is short (<= ~0.16s) so the pressed state
//      paints immediately.

// Every page that inlines its own .btn block (index.html has the canonical copy).
const PAGES = [
  '/index.html',
  '/how.html',
  '/product.html',
  '/products.html',
  '/options.html',
  '/timer.html',
];

// Read the canonical `.btn` cascade off a throwaway probe element. Products.html
// only ever renders a `.btn` inside JS-injected fallback markup, so a static
// locator is unreliable; a probe reads the same base `.btn` rules deterministically
// on every page (parent-scoped overrides like `.wiz-bar .btn` don't apply to it).
function readBtnStyle() {
  const el = window.document.createElement('a');
  el.className = 'btn';
  el.textContent = 'x';
  window.document.body.appendChild(el);
  const s = window.getComputedStyle(el);
  const props = s.transitionProperty.split(',').map((p) => p.trim());
  const durs = s.transitionDuration.split(',').map((d) => parseFloat(d));
  const idx = props.indexOf('color');
  const result = { touchAction: s.touchAction, colorDur: idx >= 0 ? durs[idx] : null };
  el.remove();
  return result;
}

// Walk every inlined stylesheet and classify `.btn:hover` rules (the lift, plus
// its `::after` companion) as either gated behind `@media (hover: hover)` or not.
// Compound selectors like `.btn.ghost:hover` are intentionally ignored — this
// targets the plain `.btn:hover` lift that must not stick on touch.
function classifyBtnHoverRules() {
  const BTN_HOVER = /(^|[\s,])\.btn:hover(?![\w.-])/;
  const out = { gated: 0, ungated: 0 };
  for (const sheet of window.document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet — skip
    }
    for (const rule of rules) {
      if (rule.media && rule.cssRules) {
        const cond = rule.conditionText || rule.media.mediaText || '';
        const isHoverMedia = /hover\s*:\s*hover/.test(cond);
        for (const inner of rule.cssRules) {
          if (inner.selectorText && BTN_HOVER.test(inner.selectorText)) {
            if (isHoverMedia) out.gated++;
            else out.ungated++;
          }
        }
      } else if (rule.selectorText && BTN_HOVER.test(rule.selectorText)) {
        out.ungated++;
      }
    }
  }
  return out;
}

test.describe('B3 — button tap responsiveness', () => {
  for (const url of PAGES) {
    test(`${url}: .btn opts out of the iOS tap delay (touch-action: manipulation)`, async ({
      page,
    }) => {
      await page.goto(url);
      const { touchAction } = await page.evaluate(readBtnStyle);
      expect(touchAction).toContain('manipulation');
    });

    test(`${url}: .btn press transition is snappy (<= 0.16s)`, async ({ page }) => {
      await page.goto(url);
      const { colorDur } = await page.evaluate(readBtnStyle);
      // The color/white-wipe feedback is what reads as "instant" on press.
      expect(colorDur).not.toBeNull();
      expect(colorDur).toBeLessThanOrEqual(0.16);
    });

    test(`${url}: the .btn:hover lift is gated behind @media (hover: hover)`, async ({ page }) => {
      await page.goto(url);
      const res = await page.evaluate(classifyBtnHoverRules);
      // The lift exists, and only inside a hover media query — never ungated,
      // so it can't stick after a tap on a touch (no-hover) device.
      expect(res.gated).toBeGreaterThanOrEqual(1);
      expect(res.ungated).toBe(0);
    });
  }
});
