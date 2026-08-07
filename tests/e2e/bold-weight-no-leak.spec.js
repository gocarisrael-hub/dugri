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
// heaviest declared face was 600, so every `font-weight: 700 / 800 / bold`
// already written across the site was rendering at 600. Publishing a 700 face
// un-caps all of them at once — prices, buttons, footer links, labels — while
// every `font-weight` assertion in the suite stays green, because the DECLARED
// weights never changed. That is precisely how it shipped once before.
//
// So this spec asserts pixels, not declarations: the rendered advance width of
// every bold-computing element on the four heaviest pages must still equal the
// width recorded from origin/main. Regenerate the baseline deliberately with
// E2E_UPDATE_BOLD_BASELINE=1 (see the comment at the bottom).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(__dirname, 'bold-weight-baseline.json');

// The pages the reviewer counted the most newly-heavier declarations on
// (options 27, collect 27, how 23) plus the storefront, which is all prices.
const PAGES = ['/options.html', '/collect.html', '/how.html', '/products.html'];

// A floor on how much of the baseline must still be recognisable. Copy edits on
// these pages legitimately change text and therefore keys, and this spec must
// not red other people's PRs for that — so it compares the INTERSECTION and
// insists the intersection stays substantial. A weight regression moves every
// intersecting width at once, so the floor never hides one.
const MIN_MATCHED = 6;

const ONLY = 'Desktop Chrome';
const UPDATING = process.env.E2E_UPDATE_BOLD_BASELINE === '1';

const readBaseline = () =>
  fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : {};

test.describe('bold stays capped at 600 everywhere except the one approved paragraph', () => {
  test.beforeEach(({}, testInfo) => {
    // One measurement pass is enough: these are font-instance facts, not
    // responsive layout, and the phone profile would need its own baseline.
    test.skip(testInfo.project.name !== ONLY, 'rendered-width measurement runs once');
  });

  for (const url of PAGES) {
    test(`${url} renders every bold element exactly as origin/main does`, async ({ page }) => {
      await settle(page, url);
      const actual = await boldTextWidths(page);

      if (UPDATING) {
        const all = readBaseline();
        all[url] = actual;
        fs.writeFileSync(BASELINE_FILE, JSON.stringify(all, null, 2) + '\n');
        test.info().annotations.push({
          type: 'baseline',
          description: `${url}: recorded ${Object.keys(actual).length} bold elements`,
        });
        return;
      }

      const expected = readBaseline()[url];
      expect(expected, `no baseline recorded for ${url}`).toBeTruthy();

      const shared = Object.keys(expected).filter((k) => k in actual);
      expect(
        shared.length,
        `only ${shared.length} of ${Object.keys(expected).length} baseline entries for ${url} ` +
          `were still found — the page changed enough that the baseline needs regenerating`
      ).toBeGreaterThanOrEqual(MIN_MATCHED);

      const drifted = shared
        .filter((k) => actual[k] !== expected[k])
        .map((k) => `${k} → ${expected[k]}px became ${actual[k]}px`);
      expect(
        drifted,
        `${drifted.length} of ${shared.length} bold elements on ${url} render at a different ` +
          `width than on origin/main. Something changed which font instance they resolve to — ` +
          `almost certainly a new @font-face weight in fonts.css.`
      ).toEqual([]);
    });
  }

  test('Assistant still has no face heavier than 600, so site-wide bold still clamps', async ({
    page,
  }) => {
    // The baseline comparison above is thorough but page-shaped. This is the
    // same fact stated directly and without a stored file: with no 700/800 face
    // declared, `font-weight: 700` MUST rasterise the 600 master. If a future
    // change publishes a heavier Assistant face, this fails immediately and says
    // why, on every page at once.
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
});

// Regenerating the baseline:
//   git checkout origin/main -- site/
//   E2E_UPDATE_BOLD_BASELINE=1 npx playwright test bold-weight-no-leak --project="Desktop Chrome"
//   git checkout HEAD -- site/
// It must be captured from origin/main — the point of the file is to say what
// the site looked like before the change under review.
