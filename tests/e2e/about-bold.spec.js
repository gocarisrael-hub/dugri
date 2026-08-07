import { test, expect } from '@playwright/test';

// The homepage "מה זה דוגרי?" explainer (data-edit="index-about-body") is the one
// paragraph the owner asked to see in bold, overriding the site's thin-weight
// brand rule. The unit test pins the markup/CSS contract; this spec proves it in a
// REAL browser, where the two interesting failure modes actually live:
//
//  • Faux bold. Assistant ships as a single variable woff2 with a discrete
//    @font-face per weight. If no face matches 700, the browser either falls back
//    to the 600 face (text that is not bold at all) or synthesises a smeared fake
//    bold — both bad, and neither visible to a `font-weight` assertion. We measure
//    a fixed Hebrew string with font-synthesis DISABLED: a width that moves
//    between 600 and 700 can only come from a genuine 700 instance.
//  • Leakage. The bold must not reach any other heading or body copy.
const ABOUT = 'p[data-edit="index-about-body"]';
const PROBE_TEXT = 'המסיבה מתחילה לפני המסיבה';

// Width of PROBE_TEXT in Assistant at `weight`, with synthesis switched off.
async function assistantWidth(page, weight) {
  return page.evaluate(
    ({ w, text }) => {
      const el = document.createElement('span');
      el.textContent = text;
      el.style.cssText =
        'position:absolute;visibility:hidden;white-space:nowrap;font-size:17px;' +
        'font-family:Assistant;font-synthesis:none;font-weight:' +
        w;
      document.body.appendChild(el);
      const width = el.getBoundingClientRect().width;
      el.remove();
      return width;
    },
    { w: weight, text: PROBE_TEXT }
  );
}

test.describe('the about paragraph is bold', () => {
  test('computes font-weight 700 while its neighbours stay thin', async ({ page }) => {
    await page.goto('/index.html');
    await page.evaluate(() => document.fonts.ready);

    await expect(page.locator(ABOUT)).toHaveCSS('font-weight', '700');

    // Nothing else on the page went bold with it. The section subtitles share the
    // `.sec-title p` class with the about paragraph, so they are the ones a
    // careless selector would drag along.
    await expect(page.locator('p[data-edit="index-products-sub"]')).toHaveCSS('font-weight', '200');
    await expect(page.locator('p[data-edit="index-reviews-sub"]')).toHaveCSS('font-weight', '200');
    await expect(page.locator('h2[data-edit="index-about-heading"]')).toHaveCSS(
      'font-weight',
      '300'
    );
    await expect(page.locator('p[data-edit="index-story-p1"]')).toHaveCSS('font-weight', '400');
  });

  test('700 is a real Assistant weight, not a synthesised one', async ({ page }) => {
    await page.goto('/index.html');
    await page.evaluate(() => document.fonts.ready);

    const [w200, w600, w700] = [
      await assistantWidth(page, 200),
      await assistantWidth(page, 600),
      await assistantWidth(page, 700),
    ];
    // Sanity: the axis moves at all (the self-hosted face really is variable).
    expect(w600).toBeGreaterThan(w200);
    // The one that matters: 700 is its OWN instance. Before fonts.css declared an
    // Assistant 700 face this was exactly equal to the 600 width.
    expect(w700).toBeGreaterThan(w600);
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
    await expect(page.locator(ABOUT)).toHaveText(ownerText);
    await expect(page.locator(ABOUT)).toHaveCSS('font-weight', '700');
    // The bold is not (and must never become) markup inside the paragraph.
    await expect(page.locator(`${ABOUT} strong, ${ABOUT} b`)).toHaveCount(0);
  });
});
