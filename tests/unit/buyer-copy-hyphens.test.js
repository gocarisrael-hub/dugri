import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The owner asked for buyer-facing copy to use a PLAIN HYPHEN (U+002D), never an
// em-dash (U+2014). This guard pins that decision on the real files.
//
// The scope is deliberately narrow, and the guard has to respect it:
//   • only user-visible text counts — text nodes, visible attributes, and the
//     string literals a buyer-facing script renders;
//   • CODE COMMENTS are exempt. This repo writes long em-dashed comments
//     everywhere; they are invisible to a buyer and rewriting them would be a
//     huge worthless diff. So a naive "no U+2014 anywhere in the file" check
//     would be WRONG — it would fail on prose no one ever reads;
//   • the ADMIN screens are exempt too. The owner explicitly kept their
//     em-dashes, so they are not listed below and must stay that way.
//
// The masker blanks comments (and only comments), then the assertion runs on
// what is left. The "masker itself" describe block below proves the mask keeps
// copy and drops comments, so a green run here means something.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const EM_DASH = '—';

// Buyer-facing pages + the buyer-facing JS modules. Admin pages are NOT here.
const BUYER_FILES = [
  'site/index.html',
  'site/products.html',
  'site/product.html',
  'site/options.html',
  'site/collect.html',
  'site/pay-success.html',
  'site/js/product.js',
  'site/js/start-explainer.js',
  'site/js/editor.js',
];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const countEmDash = (s) => (s.match(/—/g) || []).length;

// Replace every character of a `//` line comment or a /* block */ with a space,
// leaving newlines (so line numbers survive) and leaving string/template/regex
// literals completely alone — their contents are copy, not commentary.
export function maskJsComments(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let prev = ''; // last non-whitespace char, to tell `/` division from `/regex/`
  const blank = (k) => {
    if (src[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') blank(i++);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      if (i < n) {
        blank(i);
        blank(i + 1);
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i++;
          break;
        }
        i++;
      }
      prev = c;
      continue;
    }
    if (c === '/' && /[=(,:[!&|?{;+\-*%<>~^]/.test(prev)) {
      i++; // a regex literal: skip to its closing slash
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '\n') break;
        else if (src[i] === '/' && !inClass) {
          i++;
          break;
        }
        i++;
      }
      prev = '/';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

// Blank <!-- HTML comments -->, then run the JS masker over every <script> and
// <style> body so their comments are exempt on a page too.
export function maskHtmlComments(src) {
  const chars = src.split('');
  const blankRange = (from, to) => {
    for (let k = from; k < to; k++) if (chars[k] !== '\n') chars[k] = ' ';
  };
  let m;
  const html = /<!--[\s\S]*?-->/g;
  while ((m = html.exec(src))) blankRange(m.index, m.index + m[0].length);

  const blocks = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const partial = chars.join('');
  while ((m = blocks.exec(partial))) {
    const body = m[2];
    const start = m.index + m[0].length - body.length - `</${m[1]}>`.length;
    const cleaned = maskJsComments(body);
    for (let k = 0; k < body.length; k++) chars[start + k] = cleaned[k];
  }
  return chars.join('');
}

const maskComments = (file, src) =>
  file.endsWith('.html') ? maskHtmlComments(src) : maskJsComments(src);

describe('the comment masker itself', () => {
  it('drops an em-dash that sits in a JS line or block comment', () => {
    const src = `// a note ${EM_DASH} about things\n/* another ${EM_DASH} note */\nlet x = 1;\n`;
    expect(countEmDash(maskJsComments(src))).toBe(0);
  });

  it('KEEPS an em-dash that sits in a string, template or regex literal', () => {
    const src = `const a = 'copy ${EM_DASH} here';\nconst b = \`t ${EM_DASH} l\`;\nconst c = /x${EM_DASH}y/;\n`;
    expect(countEmDash(maskJsComments(src))).toBe(3);
  });

  it('is not confused by a // inside a string', () => {
    const src = `const u = 'https://x.test';\nconst t = 'copy ${EM_DASH} here';\n`;
    expect(countEmDash(maskJsComments(src))).toBe(1);
  });

  it('drops an HTML comment but keeps page text and visible attributes', () => {
    const src = `<!-- note ${EM_DASH} here -->\n<p>copy ${EM_DASH} here</p>\n<img alt="a ${EM_DASH} b">\n`;
    expect(countEmDash(maskHtmlComments(src))).toBe(2);
  });

  it('drops a comment inside a <script> block but keeps its strings', () => {
    const src = `<script>\n// note ${EM_DASH} here\nel.textContent = 'copy ${EM_DASH} here';\n</script>\n`;
    expect(countEmDash(maskHtmlComments(src))).toBe(1);
  });

  it('preserves length, so masking can never shift what it reports', () => {
    const src = `// x ${EM_DASH}\nlet a = 'y ${EM_DASH}';\n`;
    expect(maskJsComments(src)).toHaveLength(src.length);
  });
});

describe('buyer-facing copy uses a plain hyphen, never an em-dash', () => {
  for (const file of BUYER_FILES) {
    it(`${file} has no em-dash in user-visible text`, () => {
      const masked = maskComments(file, read(file));
      const offenders = masked
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter((r) => r.line.includes(EM_DASH))
        .map((r) => `${file}:${r.n}: ${r.line.slice(0, 120)}`);
      expect(offenders).toEqual([]);
    });
  }
});

describe('the exemptions are real, not an accident of the check', () => {
  // If this ever goes to 0 the guard has stopped proving anything: it would
  // mean the in-scope files no longer HAVE commented em-dashes, so "comments
  // are exempt" would be untested.
  it('leaves the em-dashes in the in-scope files’ comments alone', () => {
    const inComments = BUYER_FILES.reduce((sum, f) => {
      const src = read(f);
      return sum + (countEmDash(src) - countEmDash(maskComments(f, src)));
    }, 0);
    expect(inComments).toBeGreaterThan(100);
  });

  it('does not touch the admin screens, which the owner kept as they are', () => {
    const admin = fs
      .readdirSync(path.join(ROOT, 'site'))
      .filter((f) => /^admin-.*\.html$/.test(f) || f === 'design-codes.html');
    expect(admin.length).toBeGreaterThan(0);
    // None of them is in scope...
    for (const f of admin) expect(BUYER_FILES).not.toContain(`site/${f}`);
    // ...and they still carry em-dashes, deliberately.
    const kept = admin.reduce((sum, f) => sum + countEmDash(read(`site/${f}`)), 0);
    expect(kept).toBeGreaterThan(0);
  });
});
