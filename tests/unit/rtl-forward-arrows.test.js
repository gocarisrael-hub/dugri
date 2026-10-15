// @vitest-environment node
//
// FORWARD ARROWS POINT LEFT. The site is Hebrew and dir="rtl", so a link that
// moves the visitor on ("לרכישה", "בונים את המשחק") ends in "‹". It used to end
// in "›", which on the live pages is drawn pointing right, i.e. BACK, and the
// owner saw every CTA pointing the wrong way. Checked by eye in Chromium and
// WebKit before this test was written.
//
// So no customer-facing page may end a link or button label in "›". The one
// exception is a link that really does go back ("חזרה לאתר ›"), where pointing
// right is the point, and a back link must never end in a FORWARD arrow (‹ or ←).
// Admin pages are out of scope.
//
// Carousel prev/next buttons are SVG (js/carousel.js) and never text, so they
// are not affected either way.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'site');

const pages = fs.readdirSync(siteDir).filter((f) => f.endsWith('.html') && !f.startsWith('admin'));

// A label is the text right before </a> or </button>, possibly inside a JS
// string that builds the markup (products.html does). Prettier may break the
// closing tag onto the next line, so whitespace between is allowed.
const LABEL_ENDING_IN_RIGHT_ARROW = />([^<>]*)›\s*<\/(a|button)\b/g;
const BACK = /חזרה/;

describe('forward arrows on customer pages', () => {
  it('finds the pages to check', () => {
    expect(pages).toContain('index.html');
    expect(pages).toContain('product.html');
    expect(pages.some((p) => p.startsWith('admin'))).toBe(false);
  });

  it.each(pages)('%s: no forward link or button ends in "›"', (page) => {
    const html = fs.readFileSync(path.join(siteDir, page), 'utf8');
    const bad = [...html.matchAll(LABEL_ENDING_IN_RIGHT_ARROW)]
      .map((m) => m[1].trim() + ' ›')
      .filter((label) => !BACK.test(label));
    expect(bad).toEqual([]);
  });

  // The mirror image: a BACK link ("חזרה …") must not end in an arrow that
  // points forward. timer.html's "חזרה לדוגרי ←" did. "←" is not a mirrored
  // glyph, so it is drawn pointing left, which is forward in RTL.
  const BACK_LABEL_ENDING_IN_FORWARD_ARROW = />([^<>]*חזרה[^<>]*)[‹←]\s*<\/(a|button)\b/g;

  it.each(pages)('%s: no back link ends in a forward arrow', (page) => {
    const html = fs.readFileSync(path.join(siteDir, page), 'utf8');
    const bad = [...html.matchAll(BACK_LABEL_ENDING_IN_FORWARD_ARROW)].map((m) => m[0]);
    expect(bad).toEqual([]);
  });

  it('would catch the old timer back link, and lets a correct one through', () => {
    const sample = [
      '<a href="index.html">חזרה לדוגרי ←</a>',
      '<a href="index.html">חזרה לאתר ‹</a\n>',
      '<a href="index.html">חזרה לדוגרי →</a>',
      '<a href="index.html">חזרה לאתר ›</a>',
      '<a class="btn" href="products.html">מעבר אל החנות ‹</a>',
    ].join('\n');
    const hits = [...sample.matchAll(BACK_LABEL_ENDING_IN_FORWARD_ARROW)].map((m) => m[1].trim());
    expect(hits).toEqual(['חזרה לדוגרי', 'חזרה לאתר']);
  });

  it('would catch the old CTA, and lets a real back link through', () => {
    const sample = [
      '<a class="btn" href="products.html">מעבר אל החנות ›</a>',
      '<a class="btn"\n  >בונים את המשחק ›</a\n>',
      '<a class="back" href="index.html">חזרה לאתר ›</a>',
      '<a class="btn" href="products.html">מעבר אל החנות ‹</a>',
    ].join('\n');
    const hits = [...sample.matchAll(LABEL_ENDING_IN_RIGHT_ARROW)].map((m) => m[1].trim());
    expect(hits).toEqual(['מעבר אל החנות', 'בונים את המשחק', 'חזרה לאתר']);
    expect(hits.filter((l) => !BACK.test(l))).toEqual(['מעבר אל החנות', 'בונים את המשחק']);
  });
});
