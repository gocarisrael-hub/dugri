// @vitest-environment jsdom
// One footer on every page in redesign mode: new.html's. The shell (js/redesign-shell.js) renders the same markup on the other
// pages, and css/redesign.css carries the same rules scoped to it. What these pin:
//   1. the shell's footer markup is new.html's, byte for byte, but with no inline-edit keys (read-only on other pages)
//   2. the shell's footer rules are home-new.css's, rule for rule, under the shell's prefix (so the two can never drift)
//   3. an owner's edit to new.html's footer (saved in the index.html bucket, its data-edit-scope) reaches a shell page's footer
//   4. which pages carry it, and how (replace their own, or add it at the end)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../site');
const read = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');
const JS = read('js/redesign-shell.js');
const flat = (s) => s.replace(/\s+/g, ' ').trim();

// the inside of new.html's <footer class="site-ft">, as the shell must render it
function newHtmlFooter() {
  const html = read('new.html');
  const s = html.indexOf('<footer class="site-ft"');
  const inner = html.slice(html.indexOf('>', s) + 1, html.indexOf('</footer>', s));
  return flat(inner.replace(/data-edit="/g, 'data-rd-key="'));
}

// the shell, run on a bare page that asks for the footer at its end
function runShell(xhrBody) {
  delete window.__dugriRdShell;
  document.documentElement.className = 'rd';
  document.head.innerHTML = '<style>html.rd { --rd-footer: end; }</style>';
  document.body.outerHTML = '<body><main>m</main></body>';
  const sent = [];
  window.XMLHttpRequest = function () {
    const x = this;
    x.open = (m, u) => sent.push(u);
    x.send = () => {
      if (xhrBody === undefined) return;
      x.status = 200;
      x.responseText = JSON.stringify(xhrBody);
      x.onload();
    };
  };
  window.eval(JS);
  return { ftr: document.querySelector('footer.rd-ftr'), sent };
}

describe('the markup', () => {
  const realXhr = window.XMLHttpRequest;
  beforeEach(() => window.history.replaceState(null, '', '/products.html'));
  afterEach(() => {
    window.XMLHttpRequest = realXhr;
  });

  it("is new.html's footer, byte for byte, with no inline-edit keys", () => {
    const { ftr } = runShell();
    expect(flat(ftr.innerHTML)).toBe(
      flat(
        new window.DOMParser().parseFromString(`<footer>${newHtmlFooter()}</footer>`, 'text/html')
          .body.firstElementChild.innerHTML
      )
    );
    expect(ftr.querySelector('[data-edit], [data-edit-img], [data-edit-scope]')).toBe(null);
    // the same links and contacts as new.html, in the same order
    const hrefs = [...ftr.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('new-faq.html');
    expect(hrefs).toContain('tel:+972552441334');
    expect(hrefs).toContain('mailto:dugri.israel@gmail.com');
    expect(ftr.textContent).not.toMatch(/לעסקים/);
  });

  it("shows an owner's edit to new.html's footer, read from the index.html bucket", () => {
    const { ftr, sent } = runShell({
      overrides: {
        'index-footer-tag': { text: 'צילמתם? תייגו אותנו בסטורי' },
        'index-footer-mail-label': { text: 'אימייל:' },
        'products-footer-brand': { text: 'not ours' },
      },
    });
    expect(sent).toEqual(['/api/content?page=index.html']);
    expect(ftr.querySelector('[data-rd-key="index-footer-tag"]').textContent).toBe(
      'צילמתם? תייגו אותנו בסטורי'
    );
    expect(ftr.querySelector('[data-rd-key="index-footer-mail-label"]').textContent).toBe(
      'אימייל:'
    );
    // an untouched label keeps the shipped words, and nothing else is written
    expect(ftr.querySelector('[data-rd-key="index-footer-wa-label"]').textContent).toBe(
      'וואטסאפ / טלפון:'
    );
    expect(ftr.textContent).not.toContain('not ours');
  });

  it('keeps the shipped words when the edits cannot be read', () => {
    const { ftr } = runShell();
    expect(ftr.querySelector('[data-rd-key="index-footer-tag"]').textContent).toBe(
      'צילמתם? תייגו אותנו'
    );
  });
});

describe('the rules', () => {
  // the rule blocks between /* <name>:start */ and /* <name>:end */, each as [selector list, body]
  const rules = (css, name, prefix) => {
    const i = css.indexOf(`/* ${name}:start`);
    const j = css.indexOf(`/* ${name}:end */`, i);
    expect(i, name).toBeGreaterThan(-1);
    const block = css.slice(css.indexOf('*/', i) + 2, j).replace(/\/\*[\s\S]*?\*\//g, '');
    return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [
      sel
        .split(',')
        .map((x) => {
          let t = flat(x);
          if (prefix) t = t.replace(prefix + ' ', '').replace(prefix, '.site-ft');
          return t.replace(/^@media[^{]*\s/, '');
        })
        .join(', '),
      flat(body),
    ]);
  };
  const SHELL = 'html.rd:not(.rd-native) body > footer.rd-ftr';
  const home = read('css/home-new.css');
  const shell = read('css/redesign.css');

  for (const name of ['site-footer', 'site-footer-wide']) {
    it(`${name}: the shell's rules are home-new.css's, under the shell's prefix`, () => {
      const a = rules(home, name);
      expect(a.length).toBeGreaterThan(2);
      expect(rules(shell, name, SHELL)).toEqual(a);
    });
  }

  it('centres the footer on a wide screen', () => {
    const wide = rules(home, 'site-footer-wide');
    expect(wide.find(([s]) => s === '.site-ft')[1]).toContain('justify-content: center;');
  });
});

describe('which pages carry it', () => {
  const setting = (f) => (read(`css/rd/${f}.css`).match(/--rd-footer:\s*([a-z]+)/) || [])[1];
  it('replaces the old footer on the store, a design page and the terms; follows pickup’s own help; ends the rest', () => {
    for (const f of ['products', 'product', 'terms']) expect(setting(f), f).toBe('replace');
    for (const f of ['pickup', 'wordlists']) expect(setting(f), f).toBe('end');
    // deliberately none: a payment return, a partner link, an unsubscribe, a proof, the kiosk timer, the wizard's fixed bar
    for (const f of [
      'collect',
      'pay-done',
      'pay-success',
      'partner',
      'unsubscribe',
      'proof',
      'timer',
      'options',
    ])
      expect(setting(f), f).toBe('none');
  });
});
