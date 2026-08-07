// Measuring what the browser ACTUALLY RENDERS, not what the CSS declares.
//
// Every self-hosted woff2 on this site is a VARIABLE font (Assistant exposes
// wght 200–800, Heebo 100–900) but fonts.css publishes them as a handful of
// discrete @font-face rules that all point at the same file. That has a
// consequence which no `font-weight` assertion can see: a weight with no
// declared face does not render at that weight — it falls back to the nearest
// declared one. Assistant's heaviest declared face is 600, so `font-weight: 700`
// (and 800, and `bold`) render at 600 everywhere on the site. The declared value
// still computes to "700"; only the pixels differ.
//
// So these helpers never look at font-weight. They measure the advance width of
// real text with `font-synthesis: none`, which is the one observable that moves
// if — and only if — a different font instance was actually rasterised.
// Synthesis is switched off so a smeared faux-bold cannot be mistaken for a
// genuine heavier master.

// A Hebrew probe string. Hebrew is what the site is written in, and it is where
// weight changes and faux-bold are most visible.
export const PROBE_TEXT = 'המסיבה מתחילה לפני המסיבה';

/**
 * Advance width of PROBE_TEXT rendered in `family` with `extraCss` applied.
 * The probe span is absolutely positioned and nowrap, so the number is a pure
 * text advance and does not depend on page layout or viewport.
 */
export async function probeWidth(page, extraCss, family = 'Assistant') {
  return page.evaluate(
    ({ extraCss, family, text }) => {
      const el = document.createElement('span');
      el.textContent = text;
      el.style.cssText =
        'position:absolute;visibility:hidden;white-space:nowrap;font-size:200px;' +
        `font-family:${family};font-synthesis:none;` +
        extraCss;
      document.body.appendChild(el);
      const width = el.getBoundingClientRect().width;
      el.remove();
      return width;
    },
    { extraCss, family, text: PROBE_TEXT }
  );
}

/**
 * Make sure every Assistant face this file measures has actually downloaded.
 * A face that has not loaded silently renders in a system fallback, which looks
 * like a perfectly plausible measurement and quietly invalidates the whole
 * comparison — so wait for them explicitly rather than trusting fonts.ready,
 * which only covers faces the page itself already used.
 */
export async function loadFaces(page, families = ['Assistant', 'Heebo']) {
  await page.evaluate(
    async ({ families, text }) => {
      for (const family of families) {
        for (const w of [200, 300, 400, 500, 600, 700, 800, 900]) {
          try {
            await document.fonts.load(`${w} 200px ${family}`, text);
          } catch {
            // No face declared at that weight — nothing to download.
          }
        }
      }
      await document.fonts.ready;
    },
    { families, text: PROBE_TEXT }
  );
}

/**
 * Check every element on the page that computes to a bold weight (>= 700) and
 * owns visible text, and confirm it still renders as the @font-face table in
 * `faces` — captured from origin/main — would have resolved it.
 *
 * For each element it renders that element's OWN text twice in an offscreen
 * nowrap probe:
 *   a) exactly as the page has it, and
 *   b) at the heaviest weight origin/main declares a face for at or below the
 *      element's weight, with no axis override.
 * Under origin/main's stylesheet those are the SAME font instance by definition,
 * so the two widths are equal. Declare a heavier face and (a) jumps to the new
 * instance while (b) stays put.
 *
 * Both numbers come from the same browser in the same run, so this holds
 * identically on macOS and on the Linux CI runner — unlike a recorded pixel
 * width, which is a property of the machine that recorded it.
 *
 * Returns { measured, drifted, axisOverrides }.
 */
export async function boldTextWidths(page, faces) {
  return page.evaluate((faces) => {
    const measured = [];
    const drifted = [];
    const axisOverrides = [];

    const measure = (cs, text, weight, axis) => {
      const probe = document.createElement('span');
      probe.textContent = text;
      probe.style.cssText =
        'position:absolute;visibility:hidden;white-space:nowrap;font-synthesis:none;';
      probe.style.fontFamily = cs.fontFamily;
      probe.style.fontSize = cs.fontSize;
      probe.style.fontWeight = weight;
      probe.style.fontStyle = cs.fontStyle;
      probe.style.fontStretch = cs.fontStretch;
      probe.style.letterSpacing = cs.letterSpacing;
      probe.style.fontVariationSettings = axis;
      document.body.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    };

    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const weight = parseInt(cs.fontWeight, 10);
      if (!(weight >= 700)) continue;

      // Only the element's own text nodes — otherwise a bold wrapper would
      // re-measure all of its children's copy as one blob.
      const text = Array.from(el.childNodes)
        .filter((n) => n.nodeType === window.Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;

      // Only self-hosted families are ours to reason about; a system fallback
      // has no @font-face table to compare against.
      const family = cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
      const declared = faces[family];
      if (!declared) continue;

      const label = `${el.tagName}|${family}|${cs.fontSize}|${weight}|${text}`;
      measured.push(label);

      if (cs.fontVariationSettings !== 'normal') {
        axisOverrides.push(`${label} → ${cs.fontVariationSettings}`);
        continue;
      }

      // The face origin/main would have matched: the heaviest declared weight
      // at or below this one (CSS falls back downward for weights >= 400).
      const below = declared.filter((w) => w <= weight);
      const target = below.length ? Math.max(...below) : Math.min(...declared);

      const asRendered = measure(cs, text, String(weight), 'normal');
      const asMainResolved = measure(cs, text, String(target), 'normal');
      if (asRendered !== asMainResolved) {
        drifted.push(
          `${label} → renders ${asRendered}px but the ${target} face origin/main matched ` +
            `renders ${asMainResolved}px`
        );
      }
    }
    return { measured: measured.length, drifted, axisOverrides };
  }, faces);
}

/** Settle a page so the fingerprint is reproducible run to run. */
export async function settle(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await loadFaces(page);
}
