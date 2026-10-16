// @vitest-environment jsdom
// The redesign shell: css/redesign.css and js/redesign-shell.js, loaded on every page in redesign mode. What these pin:
//   1. the faces and the role tokens are copies of home-new.css's and redesign-tokens.css's, byte for byte, so the two never drift
//   2. the bridge renames every palette token tokens.css declares, so no old page keeps an old colour through a token
//   3. the stylesheet keeps to what the owner's old Safari reads (15.6 at most), and the shell script is ES5
//   4. the shell: the shared header and footer stand in for a page's own; a page built in the redesign is left alone; nothing runs
//      outside the mode or twice; a page can opt out
//   5. rd-kit.html is private
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as acorn from 'acorn';

const require = createRequire(import.meta.url);
const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../site');
const read = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');
const CSS = read('css/redesign.css');
const JS = read('js/redesign-shell.js');

describe('the stylesheet', () => {
  it('carries the same faces as new.html and the same role tokens as redesign-tokens.css', () => {
    const faces = (s) => s.match(/@font-face \{[^}]*\}/g);
    expect(faces(CSS)).toEqual(faces(read('css/home-new.css')));
    const root = (s) => s.slice(s.indexOf(':root {'), s.indexOf('\n}\n', s.indexOf(':root {')));
    expect(root(CSS)).toBe(root(read('css/redesign-tokens.css')));
  });

  it('the bridge renames every token tokens.css declares, except the price spacing', () => {
    const tokens = read('css/tokens.css');
    const block = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('\n}\n'));
    const names = [...block.matchAll(/^\s+(--[a-z0-9-]+):/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(25);
    const bridge = CSS.slice(CSS.indexOf('html.rd:not(.rd-native) {'));
    const bridged = bridge.slice(0, bridge.indexOf('\n}'));
    for (const n of names) {
      if (n === '--price-gap' || n === '--was-gap') continue; // spacing, not look
      expect(bridged, n).toContain(`  ${n}: `);
    }
  });

  it('keeps to what Safari 15.6 and older read', () => {
    const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(
      /^\s*(inset|inset-inline|inset-block|inset-inline-start|inset-inline-end):/m
    );
    expect(css).not.toMatch(/^\s*(padding|margin|border)-(inline|block):/m);
    expect(css).not.toMatch(/:has\(|:is\(|:where\(|color-mix|@layer|@container/);
    const lines = css.split('\n');
    lines.forEach((l, i) => {
      if (/\dsvh/.test(l)) expect(lines[i - 1], `line ${i + 1}`).toBe(l.replace(/svh/g, 'vh'));
      if (/^\s*overflow(-[xy])?: clip;/.test(l)) expect(lines[i - 1]).toMatch(/: hidden;/);
    });
    for (const m of css.matchAll(/([^{}]+)\{/g)) {
      const sels = m[1].split(',').map((x) => x.trim());
      const fv = sels.filter((x) => x.includes(':focus-visible'));
      if (fv.length) expect(fv.length, m[1]).toBe(sels.length);
    }
    expect(css).toMatch(/html\.rd dialog:not\(\[open\]\) \{\s*display: none;/);
  });

  it('every component rule is scoped under html.rd, so nothing applies outside the mode', () => {
    const body = CSS.slice(CSS.indexOf('/* ---------- 2. the bridge'));
    const rules = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@[a-z-]*keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, '');
    for (const m of rules.matchAll(/([^{}@]+)\{[^{}]*\}/g)) {
      for (const sel of m[1]
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean))
        expect(sel, sel).toMatch(/^html\.rd/);
    }
  });
});

describe('the shell script', () => {
  it('is ES5, so any Safari parses it', () => {
    expect(() => acorn.parse(JS, { ecmaVersion: 5, sourceType: 'script' })).not.toThrow();
  });

  const run = () => window.eval(JS);
  const page = (bodyHtml, { rd = true, meta } = {}) => {
    delete window.__dugriRdShell;
    document.documentElement.className = rd ? 'rd' : '';
    document.head.innerHTML = meta ? `<meta name="dugri:page" content="${meta}">` : '';
    document.body.outerHTML = `<body>${bodyHtml}</body>`;
  };
  const OLD =
    '<header class="hdr" id="old"><a href="index.html">x</a></header><main>m</main><footer id="oldF">f</footer>';

  beforeEach(() => window.history.replaceState(null, '', '/pickup.html'));

  it('puts the shared header and footer in place of the page’s own, which stay hidden in the DOM', () => {
    page(OLD);
    run();
    const hdr = document.querySelector('.rd-hdr');
    expect(hdr.nextElementSibling.id).toBe('old');
    expect(document.getElementById('old').hasAttribute('data-rd-replaced')).toBe(true);
    expect(document.querySelector('.rd-ftr').nextElementSibling.id).toBe('oldF');
    expect(document.getElementById('oldF').hasAttribute('data-rd-replaced')).toBe(true);
    expect(document.documentElement.classList.contains('rd-hdr-swapped')).toBe(true);
    expect(document.querySelector('#rdMenu a[aria-current="page"]').getAttribute('href')).toBe(
      'pickup.html'
    );
    expect([...document.querySelectorAll('#rdMenu a')].map((a) => a.getAttribute('href'))).toEqual([
      '/#order',
      'how.html',
      '/#recs',
      'new-faq.html',
      'pickup.html',
      '/#biz',
      '/#order',
    ]);
  });

  it('fills the slots a page marks, and leaves a page that opts out alone', () => {
    page('<div data-rd-header></div><main></main><div data-rd-footer></div>');
    run();
    expect(document.querySelector('[data-rd-header] > .rd-hdr')).not.toBe(null);
    expect(document.querySelector('[data-rd-footer] > .rd-ftr')).not.toBe(null);
    page(OLD.replace('<header', '<header data-x'));
    document.body.setAttribute('data-rd-no-header', '');
    document.body.setAttribute('data-rd-no-footer', '');
    run();
    expect(document.querySelector('.rd-hdr, .rd-ftr, #rdMenu')).toBe(null);
  });

  it('a page without the shared header keeps its own footer', () => {
    page('<main></main><footer id="oldF">f</footer>');
    run();
    expect(document.querySelector('.rd-ftr')).toBe(null);
    expect(document.getElementById('oldF').hasAttribute('data-rd-replaced')).toBe(false);
  });

  it('marks a page built in the redesign and does nothing else there', () => {
    for (const meta of ['new.html', 'new-faq.html']) {
      page(OLD, { meta });
      run();
      expect(document.documentElement.classList.contains('rd-native')).toBe(true);
      expect(document.querySelector('.rd-hdr')).toBe(null);
    }
  });

  it('does nothing outside the mode, and runs once', () => {
    page(OLD, { rd: false });
    run();
    expect(document.querySelector('.rd-hdr')).toBe(null);
    page(OLD);
    run();
    window.eval(JS);
    expect(document.querySelectorAll('.rd-hdr')).toHaveLength(1);
  });

  it('a toast says its text and fades', async () => {
    page('<main></main>');
    run();
    window.dugriRd.toast('נשמר', 10);
    const t = document.querySelector('.rd-toast');
    expect(t.textContent).toBe('נשמר');
    expect(t.getAttribute('role')).toBe('status');
    await new Promise((r) => setTimeout(r, 30));
    expect(t.className).toBe('rd-toast out');
  });
});

describe('rd-kit.html', () => {
  it('is private, and not one of the public pages', () => {
    const html = read('rd-kit.html');
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow" \/>/);
    const seo = require('../../server/seo.js');
    expect(seo.PUBLIC_PAGES.map((p) => p.file)).not.toContain('rd-kit.html');
  });
});
