import { test, expect } from '@playwright/test';
import { PROBE_TEXT, loadFaces } from './font-metrics.js';

// The homepage "מה זה דוגרי?" explainer (data-edit="index-about-body") is the one
// paragraph the owner asked to see in bold, overriding the site's thin-weight
// brand rule.
//
// Asserting `font-weight: 700` on it proves nothing. Assistant is a single
// variable woff2 that fonts.css exposes as discrete faces capped at 600, so
// `font-weight: 700` computes to "700" and rasterises the 600 master — bold in
// the CSS, not bold on screen. The paragraph therefore sets the wght axis
// directly (`font-variation-settings: 'wght' 700`), and these tests measure
// RENDERED advance widths, with `font-synthesis: none` so a faux-bold smear
// cannot pass for a real heavier master either.
const ABOUT = 'p[data-edit="index-about-body"]';

// Advance width of PROBE_TEXT at 200px in the font settings `selector` resolves
// to — family, style, stretch and, crucially, its font-variation-settings.
// Size is normalised so the number is comparable with the references below.
async function widthAsRendered(page, selector, overrides = {}) {
  return page.evaluate(
    ({ selector, text, overrides }) => {
      const cs = getComputedStyle(document.querySelector(selector));
      const el = document.createElement('span');
      el.textContent = text;
      el.style.cssText =
        'position:absolute;visibility:hidden;white-space:nowrap;font-synthesis:none;font-size:200px;';
      el.style.fontFamily = cs.fontFamily;
      el.style.fontWeight = overrides.fontWeight ?? cs.fontWeight;
      el.style.fontStyle = cs.fontStyle;
      el.style.fontStretch = cs.fontStretch;
      el.style.fontVariationSettings = overrides.fontVariationSettings ?? cs.fontVariationSettings;
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    },
    { selector, text: PROBE_TEXT, overrides }
  );
}

// Width of PROBE_TEXT at an arbitrary point on Assistant's real wght axis.
// Declares a throwaway family over the SAME woff2 with the full 200–800 range,
// which is how the browser is told the file is variable. Whatever this returns
// at 700 is, by construction, the genuine 700 master.
async function trueAxisWidth(page, wght) {
  const css = await (await page.request.get('/assets/fonts/fonts.css')).text();
  const src = css.match(/url\((\/assets\/fonts\/assistant-[^)]*hebrew[^)]*\.woff2)\)/);
  expect(src, 'no Assistant hebrew woff2 in fonts.css').toBeTruthy();
  return page.evaluate(
    async ({ src, wght, text }) => {
      const face = new FontFace('DugriAxisReference', `url(${src}) format('woff2')`, {
        weight: '200 800',
      });
      await face.load();
      document.fonts.add(face);
      const el = document.createElement('span');
      el.textContent = text;
      el.style.cssText =
        'position:absolute;visibility:hidden;white-space:nowrap;font-synthesis:none;' +
        `font-size:200px;font-family:DugriAxisReference;font-weight:${wght};`;
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    },
    { src: src[1], wght, text: PROBE_TEXT }
  );
}

test.describe('the about paragraph renders genuinely bold', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/index.html', { waitUntil: 'networkidle' });
    await loadFaces(page, ['Assistant']);
  });

  test('it rasterises Assistant 700, not the 600 the rest of the site clamps to', async ({
    page,
  }) => {
    const rendered = await widthAsRendered(page, ABOUT);

    // What a plain `font-weight: 700` gets you on this site: the 600 master,
    // because no 700 face is declared. This is the number the paragraph has to
    // beat, and the reason `toHaveCSS('font-weight', '700')` is worthless here.
    const clamped = await widthAsRendered(page, ABOUT, { fontVariationSettings: 'normal' });
    const at600 = await widthAsRendered(page, ABOUT, {
      fontWeight: '600',
      fontVariationSettings: 'normal',
    });

    expect(clamped, 'plain font-weight:700 should still clamp to the 600 master').toBe(at600);
    expect(
      rendered,
      `the paragraph renders ${rendered}px — the same as the clamped 600 master (${clamped}px). ` +
        `It is not actually bold.`
    ).toBeGreaterThan(clamped);

    // And it is the REAL 700 instance, to the pixel — not a synthesised
    // approximation and not some other point on the axis.
    const true700 = await trueAxisWidth(page, 700);
    expect(rendered).toBe(true700);
  });

  test('the weight comes from the variable axis, not from faux bold', async ({ page }) => {
    // Synthesised bold is a single smear: it has no axis, so it cannot produce
    // three distinct, monotonically increasing widths. A real variable
    // instantiation can, and does.
    const [w600, w700, w800] = [
      await trueAxisWidth(page, 600),
      await trueAxisWidth(page, 700),
      await trueAxisWidth(page, 800),
    ];
    expect(w700).toBeGreaterThan(w600);
    expect(w800).toBeGreaterThan(w700);

    // The paragraph sits exactly on that axis at 700.
    expect(await widthAsRendered(page, ABOUT)).toBe(w700);

    // Belt and braces: the browser is not being asked to fake anything, because
    // the rule declares the axis explicitly.
    await expect(page.locator(ABOUT)).toHaveCSS('font-variation-settings', '"wght" 700');
  });

  test('nothing else on the homepage picked up the heavier instance', async ({ page }) => {
    // Rendered widths, not declared weights — that distinction is the whole
    // point of this file. Each of these shares an ancestor, a class or a token
    // with the about paragraph, so each is a plausible leak path.
    const neighbours = [
      'p[data-edit="index-products-sub"]', // same .sec-title p rule
      'p[data-edit="index-reviews-sub"]',
      'h2[data-edit="index-about-heading"]', // same section
      'p[data-edit="index-story-p1"]', // plain body copy
    ];
    for (const sel of neighbours) {
      const fvs = await page
        .locator(sel)
        .evaluate((el) => getComputedStyle(el).fontVariationSettings);
      expect(fvs, `${sel} inherited the wght override`).toBe('normal');
      // …and it renders no heavier than the same element at its own weight with
      // no axis override, i.e. nothing moved underneath it.
      const asIs = await widthAsRendered(page, sel);
      const noAxis = await widthAsRendered(page, sel, { fontVariationSettings: 'normal' });
      expect(asIs).toBe(noAxis);
    }
  });
});

test.describe('the bold survives owner edits to the copy', () => {
  test('a stored content override replaces the text and keeps the weight', async ({ page }) => {
    // Production renders this paragraph from a stored override, not from the
    // shipped HTML — editor.js applies it with `el.textContent = ov.text`, which
    // would wipe any <strong> in the markup. The weight rides the element, so it
    // must survive.
    const ownerText =
      'משחק מילים אישי שכל כולו על האדם שחוגגים לו. ומה הקאץ׳? כל המילים עליכם! ' +
      'המסיבה מתחילה לפני המסיבה.';
    await page.route('**/api/content*', (route) =>
      route.fulfill({ json: { overrides: { 'index-about-body': { text: ownerText } } } })
    );

    await page.goto('/index.html');
    await loadFaces(page, ['Assistant']);
    await expect(page.locator(ABOUT)).toHaveText(ownerText);

    // Still on the real 700 master after the text was replaced wholesale.
    expect(await widthAsRendered(page, ABOUT)).toBe(await trueAxisWidth(page, 700));

    // The bold is not (and must never become) markup inside the paragraph.
    await expect(page.locator(`${ABOUT} strong, ${ABOUT} b`)).toHaveCount(0);
  });
});
