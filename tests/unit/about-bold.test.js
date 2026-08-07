import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The owner asked for ONE paragraph on the homepage — the "מה זה דוגרי?" explainer
// (data-edit="index-about-body") — to render bold, explicitly overriding the
// site's thin-weight brand rule.
//
// NOTHING HERE PROVES IT LOOKS BOLD. jsdom does not shape text, and on this site
// a declared `font-weight` says nothing about what is rasterised anyway: fonts.css
// exposes the variable Assistant woff2 as discrete faces capped at 600, so
// `font-weight: 700` computes to "700" and draws the 600 master. The proof that
// the paragraph renders a real 700 instance — and that no other page moved a
// pixel — is measured in a real browser in tests/e2e/about-bold.spec.js and
// tests/e2e/bold-weight-no-leak.spec.js.
//
// What this file pins is the structural half, which is where the change can rot
// silently:
//  1. BOLD BY MARKUP. That paragraph is owner-editable. Both the visitor path
//     (applyOverrides → el.textContent = ov.text) and the edit path (a
//     plaintext-only contenteditable whose textContent is POSTed) REPLACE the
//     node's text wholesale, so a <strong>/<b> wrapper would be destroyed the
//     first time she edits it. The weight has to live on the ELEMENT.
//  2. SELECTOR REACH. `.sec-title p` is shared by every section subtitle, so the
//     bold must be keyed to this one paragraph's content key.
//  3. THE MECHANISM. It must stay an element-level axis override. Reaching 700
//     by declaring a global Assistant 700 face works — and silently un-bolds
//     nothing while re-bolding every `font-weight: 700` already written across
//     all 14 pages, because they all load this one stylesheet. That is a
//     site-wide restyle, and it is how this shipped once before.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const SITE = path.join(REPO, 'site');
const INDEX_HTML = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
const FONTS_CSS = fs.readFileSync(path.join(SITE, 'assets', 'fonts', 'fonts.css'), 'utf8');

const ABOUT_KEY = 'index-about-body';
// What the owner's live copy looks like: longer than the shipped default and
// stored as an override, i.e. NOT the string in the HTML.
const OWNER_TEXT =
  'משחק מילים אישי שכל כולו על האדם שחוגגים לו. מתחלקים לקבוצות, שולפים קלף ומתארים את המילה בלי ' +
  'להגיד אותה. ומה הקאץ׳? כל המילים עליכם! המסיבה מתחילה לפני המסיבה.';

// The one rule that bolds the paragraph.
const ABOUT_RULE = INDEX_HTML.match(
  /#about \.sec-title p\[data-edit='index-about-body'\] \{[^}]*\}/
);

let editor;
beforeAll(async () => {
  await import('../../site/js/editor.js');
  editor = window.__dugriEditor;
});

// Render the REAL homepage into the test document (scripts do not execute via
// innerHTML, so this is the shipped markup + its <style> block and nothing else).
beforeEach(() => {
  document.documentElement.innerHTML = INDEX_HTML.replace(/<!doctype html>/i, '');
});

const $ = (sel) => document.querySelector(sel);

describe('the about paragraph is styled bold on the element', () => {
  it('has a rule of its own, keyed to its content key', () => {
    expect($(`p[data-edit="${ABOUT_KEY}"]`)).toBeTruthy();
    expect(ABOUT_RULE, 'no rule targets the about paragraph by its data-edit key').toBeTruthy();
  });

  it('carries the weight on the element, not on the words', () => {
    const p = $(`p[data-edit="${ABOUT_KEY}"]`);
    // No inline markup to lose: an owner edit rewrites textContent.
    expect(p.querySelectorAll('strong, b, em, span')).toHaveLength(0);
    expect(p.children).toHaveLength(0);
  });

  it('survives an inline content edit that replaces the whole text', () => {
    // Exactly what every visitor gets when a stored override exists, and what the
    // editor does to the node while the owner types.
    editor.applyOverrides(document, { [ABOUT_KEY]: { text: OWNER_TEXT } });
    const p = $(`p[data-edit="${ABOUT_KEY}"]`);
    expect(p.textContent).toBe(OWNER_TEXT);
    expect(p.querySelectorAll('strong, b')).toHaveLength(0);
    // The styling is a stylesheet rule against the element, so a text rewrite
    // cannot take it away. (Whether it LOOKS bold is measured in the e2e specs.)
    expect(p.matches('#about .sec-title p[data-edit="index-about-body"]')).toBe(true);
  });
});

describe('the bold is reached by the wght axis, not by a new global face', () => {
  it('the rule sets font-variation-settings on that one element', () => {
    // This is the part that cannot leak: an axis value on an element is not
    // matchable by any other element's font-weight.
    expect(ABOUT_RULE[0]).toMatch(/font-variation-settings:\s*'wght'\s*700/);
  });

  it('fonts.css declares no Assistant face heavier than 600', () => {
    // Adding one is the tempting shortcut and the actual defect: every page
    // loads this stylesheet, so a 700 face re-bolds the whole site at once.
    const weights = FONTS_CSS.split('@font-face')
      .slice(1)
      .filter((b) => /font-family:\s*'Assistant'/.test(b))
      .map((b) => Number((b.match(/font-weight:\s*(\d+)/) || [])[1]));
    expect(weights.length).toBeGreaterThan(0);
    expect(
      Math.max(...weights),
      `an Assistant face heavier than 600 is declared (${weights.join(', ')}); that re-bolds ` +
        `every font-weight:700 on every page`
    ).toBeLessThanOrEqual(600);
  });

  it('the font generator would not reintroduce one on a re-run', () => {
    // fonts.css is generated; a weight added to the fetch list comes back on the
    // next run even if the stylesheet is cleaned by hand.
    const script = fs.readFileSync(path.join(REPO, 'scripts', 'fetch-fonts.mjs'), 'utf8');
    const assistant = script.match(/'Assistant:wght@([^']+)'/);
    expect(assistant).toBeTruthy();
    const requested = assistant[1].split(';').map(Number);
    expect(Math.max(...requested)).toBeLessThanOrEqual(600);
  });
});

describe('the bold does not leak past that one paragraph', () => {
  it('the shared .sec-title p rule itself was not made bold', () => {
    const rule = INDEX_HTML.match(/\.sec-title p \{[^}]*\}/);
    expect(rule).toBeTruthy();
    expect(rule[0]).toContain('font-weight: var(--sub-weight)');
    expect(rule[0]).not.toMatch(/700|bold|font-variation-settings/);
  });

  it('no other selector in the page sets a wght axis override', () => {
    // Split on the block boundaries rather than matching selector+body with a
    // greedy character class — same answer, without scanning the whole document
    // from every offset.
    const blocks = INDEX_HTML.split('}');
    const axisRules = blocks.filter((b) => b.includes('font-variation-settings'));
    expect(axisRules).toHaveLength(1);
    expect(axisRules[0]).toContain(`data-edit='${ABOUT_KEY}'`);
  });
});
