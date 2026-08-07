import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boldTextWidths, probeWidth, settle } from './font-metrics.js';

// The site's brand direction is thin: no bold. Exactly one paragraph is exempt —
// the homepage "מה זה דוגרי?" explainer, which the owner asked for by hand.
//
// The trap this file exists to close: the obvious way to make that paragraph
// bold is to add an Assistant 700 @font-face to fonts.css. It works, and it is a
// site-wide restyle. All 14 pages load that one stylesheet, and Assistant's
// heaviest declared face is 600, so every `font-weight: 700 / 800 / bold`
// already written across the site renders at 600. Publishing a 700 face un-caps
// all of them at once — prices, buttons, footer links, labels — while every
// `font-weight` assertion in the suite stays green, because the DECLARED weights
// never changed. That is precisely how it shipped once before.
//
// So this spec asserts pixels, not declarations. It does NOT store absolute
// widths: text rasterises to different numbers on macOS and on the Linux CI
// runner, so a recorded pixel value is a machine fingerprint, not a fact about
// the site. What it stores instead is origin/main's @font-face TABLE — the thing
// that actually decides which instance a weight resolves to — and then, in the
// browser, re-derives the instance origin/main would have given each bold
// element and asserts the page still renders exactly that width. Both numbers
// are measured in the same browser in the same run, so the comparison holds on
// any machine.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'bold-weight-baseline.json'), 'utf8')
);

// The pages the reviewer counted the most newly-heavier declarations on
// (options 27, collect 27, how 23) plus the storefront, which is all prices.
const PAGES = ['/options.html', '/collect.html', '/how.html', '/products.html'];

const ONLY = 'Desktop Chrome';

test.describe('bold stays capped at 600 everywhere except the one approved paragraph', () => {
  test.beforeEach(({}, testInfo) => {
    // One measurement pass is enough: these are font-instance facts, not
    // responsive layout, and the phone profile would measure the same thing.
    test.skip(testInfo.project.name !== ONLY, 'rendered-width measurement runs once');
  });

  for (const url of PAGES) {
    test(`${url} renders every bold element as origin/main's faces resolve it`, async ({
      page,
    }) => {
      await settle(page, url);
      const found = await boldTextWidths(page, BASELINE.faces);

      // Guard against the test quietly measuring nothing (a page that failed to
      // render would otherwise "pass" with an empty sweep).
      expect(
        found.measured,
        `only ${found.measured} bold elements found on ${url}; expected at least ` +
          `${BASELINE.minBoldElements[url]} — did the page render?`
      ).toBeGreaterThanOrEqual(BASELINE.minBoldElements[url]);

      // No element on these pages may carry a wght axis override. The one
      // element on the whole site that does is the homepage about paragraph;
      // anything else here would be a second, unreviewed exception.
      expect(
        found.axisOverrides,
        `elements on ${url} set font-variation-settings: ${found.axisOverrides.join(', ')}`
      ).toEqual([]);

      // The assertion that matters: each bold element renders at the width of
      // the face origin/main would have matched it to. If a heavier face gets
      // declared, the element resolves to a new instance and this diverges.
      expect(
        found.drifted,
        `${found.drifted.length} of ${found.measured} bold elements on ${url} no longer render ` +
          `as the face origin/main matched them to. Something changed which font instance they ` +
          `resolve to — almost certainly a new @font-face weight in fonts.css.`
      ).toEqual([]);
    });
  }

  test('Assistant still has no face heavier than 600, so site-wide bold still clamps', async ({
    page,
  }) => {
    // The same fact stated directly, with no table lookup at all: with no
    // 700/800 face declared, `font-weight: 700` MUST rasterise the 600 master.
    // If a future change publishes a heavier Assistant face, this fails
    // immediately and says why, covering every page at once.
    await settle(page, '/options.html');

    const w400 = await probeWidth(page, 'font-weight:400');
    const w600 = await probeWidth(page, 'font-weight:600');
    const w700 = await probeWidth(page, 'font-weight:700');
    const w800 = await probeWidth(page, 'font-weight:800');
    const w900 = await probeWidth(page, 'font-weight:900');

    // Sanity: the probe really is measuring Assistant and the axis really moves,
    // otherwise "everything is equal" would pass for the wrong reason (e.g. the
    // font never loaded and we measured a system fallback).
    expect(w600, 'Assistant 600 should be wider than 400 — is the font loading?').toBeGreaterThan(
      w400
    );

    for (const [label, w] of [
      ['700', w700],
      ['800', w800],
      ['900', w900],
    ]) {
      expect(
        w,
        `font-weight ${label} renders wider than 600 (${w} vs ${w600}). An Assistant face ` +
          `heavier than 600 has been declared, which re-bolds the whole site.`
      ).toBe(w600);
    }
  });

  test("the stored face table still matches origin/main's fonts.css", async ({ page }) => {
    // The table above is the yardstick for every page test, so it has to keep
    // describing the stylesheet the site actually ships. If a face is added or
    // removed, this is the one place to look.
    const css = await (await page.request.get('/assets/fonts/fonts.css')).text();
    const live = {};
    for (const block of css.split('@font-face').slice(1)) {
      const family = (block.match(/font-family:\s*'([^']+)'/) || [])[1];
      const weight = (block.match(/font-weight:\s*(\d+)/) || [])[1];
      if (!family || !weight) continue;
      (live[family] = live[family] || new Set()).add(Number(weight));
    }
    const normalised = Object.fromEntries(
      Object.keys(live)
        .sort()
        .map((f) => [f, [...live[f]].sort((a, b) => a - b)])
    );
    expect(normalised).toEqual(BASELINE.faces);
  });
});

// Regenerating the face table in bold-weight-baseline.json:
//   git show origin/main:site/assets/fonts/fonts.css
// …and list, per font-family, every distinct font-weight it declares. It must
// come from origin/main — the point of the file is to say what the site
// resolved to before the change under review.
