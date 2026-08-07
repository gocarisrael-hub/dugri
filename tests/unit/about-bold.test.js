import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The owner asked for ONE paragraph on the homepage — the "מה זה דוגרי?" explainer
// (data-edit="index-about-body") — to render bold, explicitly overriding the site's
// thin-weight brand rule. That is a narrow exception, and these tests pin down the
// three ways it could quietly go wrong:
//
//  1. BOLD BY MARKUP. That paragraph is owner-editable. Both the visitor path
//     (applyOverrides → el.textContent = ov.text) and the edit path (a
//     plaintext-only contenteditable whose textContent is POSTed) REPLACE the
//     node's text wholesale, so a <strong>/<b> wrapper would be destroyed the
//     first time she edits it — and would never apply to the stored override that
//     already replaces the shipped copy in production. The weight has to live on
//     the ELEMENT, in CSS.
//  2. LEAKAGE. `.sec-title p` is shared by every section subtitle on the page, so
//     a bold declared there would drag products / reviews / FAQ along with it.
//  3. FAUX BOLD. Assistant (the body face) ships as ONE variable woff2; fonts.css
//     declares a discrete @font-face per weight against it. Before this change the
//     heaviest declared Assistant face was 600, so `font-weight: 700` matched the
//     600 face — Hebrew that is not actually bold — or, on a browser that
//     synthesises instead, a smeared fake bold. A genuine 700 face must exist.
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
const weightOf = (sel) => window.getComputedStyle($(sel)).fontWeight;

describe('the about paragraph renders bold', () => {
  it('computes font-weight 700 from the page stylesheet', () => {
    expect($(`p[data-edit="${ABOUT_KEY}"]`)).toBeTruthy();
    expect(weightOf(`p[data-edit="${ABOUT_KEY}"]`)).toBe('700');
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
    expect(weightOf(`p[data-edit="${ABOUT_KEY}"]`)).toBe('700');
  });
});

describe('the bold does not leak past that one paragraph', () => {
  // These still resolve to the brand tokens (jsdom leaves var() unresolved, which
  // is precisely the signal we want: nothing overrode them with a literal weight).
  it.each([
    ['the sibling section subtitles', 'p[data-edit="index-products-sub"]', 'var(--sub-weight)'],
    ['the reviews subtitle', 'p[data-edit="index-reviews-sub"]', 'var(--sub-weight)'],
    ['the about heading', 'h2[data-edit="index-about-heading"]', 'var(--h-weight)'],
  ])('%s keep their token weight', (_name, sel, token) => {
    expect(weightOf(sel)).toBe(token);
  });

  it('the story body copy is untouched', () => {
    // No rule sets a weight on it at all — it inherits the body's (400 in a real
    // browser, unset in jsdom). What matters is that nothing made it bold.
    expect(weightOf('p[data-edit="index-story-p1"]')).not.toMatch(/700|800|900|bold/);
  });

  it('the shared .sec-title p rule itself was not made bold', () => {
    const rule = INDEX_HTML.match(/\.sec-title p \{[^}]*\}/);
    expect(rule).toBeTruthy();
    expect(rule[0]).toContain('font-weight: var(--sub-weight)');
    expect(rule[0]).not.toMatch(/700|bold/);
  });
});

describe('the bold weight is a real face, not a synthesised one', () => {
  it('fonts.css declares a genuine Assistant @font-face at weight 700', () => {
    const faces = FONTS_CSS.split('@font-face')
      .slice(1)
      .filter((b) => /font-family:\s*'Assistant'/.test(b));
    const weights = faces.map((b) => (b.match(/font-weight:\s*(\d+)/) || [])[1]);
    expect(weights).toContain('700');
    // …and it is served from our own volume (self-hosted), like every other face.
    const bold = faces.filter((b) => /font-weight:\s*700/.test(b));
    expect(bold.length).toBeGreaterThanOrEqual(2); // hebrew + latin subsets
    for (const b of bold) expect(b).toMatch(/url\(\/assets\/fonts\/assistant-[^)]+\.woff2\)/);
  });

  it('the font generator would reproduce that weight on a re-run', () => {
    // fonts.css is generated; a hand-added face would vanish on the next run.
    const script = fs.readFileSync(path.join(REPO, 'scripts', 'fetch-fonts.mjs'), 'utf8');
    const assistant = script.match(/'Assistant:wght@([^']+)'/);
    expect(assistant).toBeTruthy();
    expect(assistant[1].split(';')).toContain('700');
  });
});
