// @vitest-environment node
// The redesigned homepage's data rules (site/js/home-data.js) and the page's static guarantees (site/new.html).
//
// What these pin, in order of what a regression would cost:
//   1. The business form accepts exactly what the server accepts: a send the page lets through is never refused by
//      POST /api/business-lead for a rule the page could have shown, and every server reply maps to a state the page shows.
//   2. The designs on the page come from the live catalog: a hidden design disappears, a renamed one shows its new name,
//      a public custom design the page has no art for still shows (its own template card), never a sheet of eight.
//   3. The colours each design paints are the ones DESIGN.md and redesign-tokens.css record.
//   4. new.html stays private (noindex, not in the sitemap), self-hosts its fonts, and every editable text has a valid key.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {
  DESIGN_ART,
  homeDesigns,
  floodColor,
  panelColors,
  priceText,
  phoneOk,
  validateLead,
  leadOutcome,
  sendLead,
  LEAD_MESSAGES,
} from '../../site/js/home-data.js';
import { ILL, PLACEMENTS } from '../../site/js/home-illos.js';
import * as acorn from 'acorn';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'site');
const server = require('../../server/business-leads.js');
const seo = require('../../server/seo.js');
const read = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');

const builtIn = (id, name, extra = {}) => ({
  id,
  name,
  public: true,
  thumbs: { front: 'x', back: 'y', board: 'z' },
  ...extra,
});
const custom = (id, name, img) => ({ id, name, public: true, custom: true, img });

describe('the business form agrees with the server', () => {
  const cases = [
    { name: 'דנה', company: 'אלביט', phone: '054-123-4567' },
    { name: 'ד', company: 'אלביט', phone: '0541234567' },
    { name: 'דנה', company: '', phone: '0541234567' },
    { name: '   ', company: 'x y', phone: '03-1234567' },
    { name: 'דנה', company: 'אלביט', phone: '+972 54 123 4567' },
    { name: 'דנה', company: 'אלביט', phone: '+972-054-1234567' },
    { name: 'דנה', company: 'אלביט', phone: '00972541234567' },
    { name: 'דנה', company: 'אלביט', phone: '(054) 123.4567' },
    { name: 'דנה', company: 'אלביט', phone: '12345' },
    { name: 'דנה', company: 'אלביט', phone: '054123456789' },
    { name: 'דנה', company: 'אלביט', phone: 'abc' },
    { name: 'דנה', company: 'אלביט', phone: '' },
    { name: 'א'.repeat(81), company: 'אלביט', phone: '0541234567' },
    { name: 'א'.repeat(80), company: 'ב'.repeat(80), phone: '0541234567' },
    { name: 'ד\u0000נ', company: 'א\tב', phone: '0541234567' },
  ];
  for (const c of cases) {
    it(`same verdict as the server for ${JSON.stringify(c).slice(0, 70)}`, () => {
      const s = server.validateLead(c);
      expect(validateLead(c)).toEqual(s.ok ? {} : s.errors);
    });
  }

  it('has a Hebrew message for every code the server can send', () => {
    for (const f of ['name', 'company', 'phone'])
      for (const code of ['required', 'too_short', 'too_long', 'invalid'])
        expect(LEAD_MESSAGES[f][code]).toMatch(/[֐-׿]/);
  });

  it('keeps the example number left-to-right inside the Hebrew line', () => {
    expect(LEAD_MESSAGES.phone.invalid).toContain('⁦054‑123‑4567⁩');
    expect(phoneOk('054-123-4567')).toBe(true);
  });

  it('maps every reply of POST /api/business-lead to what the page shows', () => {
    expect(leadOutcome(200, { ok: true })).toEqual({ state: 'ok' });
    expect(
      leadOutcome(400, { error: 'invalid', fields: { phone: 'invalid', name: 'bogus' } })
    ).toEqual({ state: 'invalid', fields: { phone: 'invalid' } });
    expect(leadOutcome(400, { error: 'invalid' })).toEqual({ state: 'error' });
    expect(leadOutcome(429, { error: 'too many attempts' })).toEqual({ state: 'rate' });
    expect(leadOutcome(500, { error: 'not stored' })).toEqual({ state: 'error' });
    expect(leadOutcome(200, null)).toEqual({ state: 'error' });
  });

  it('sends the cleaned fields, the honeypot and the page, and never throws', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true }) }));
    const out = await sendLead(
      { name: '  דנה  כהן ', company: 'אלביט', phone: '054-1234567', website: '' },
      { fetchImpl, source: '/new.html' }
    );
    expect(out).toEqual({ state: 'ok' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/business-lead');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      name: 'דנה כהן',
      company: 'אלביט',
      phone: '054-1234567',
      website: '',
      source: '/new.html',
    });
    expect(
      await sendLead(
        { name: 'a' },
        {
          fetchImpl: async () => {
            throw new Error('offline');
          },
        }
      )
    ).toEqual({ state: 'error' });
    expect(
      await sendLead(
        { name: 'a' },
        {
          fetchImpl: async () => ({
            status: 502,
            json: async () => {
              throw new Error('html');
            },
          }),
        }
      )
    ).toEqual({ state: 'error' });
  });
});

describe('the designs come from the live catalog', () => {
  it('keeps the approved order, with designs added later after it', () => {
    const list = homeDesigns([
      builtIn('kids', 'ברוקלין'),
      builtIn('bachelorette', 'פריז'),
      custom('new-one', 'חדש', { front: '/api/template-image/new-one/front' }),
      builtIn('marriage', 'סנטוריני'),
    ]);
    expect(list.map((d) => d.id)).toEqual(['bachelorette', 'marriage', 'kids', 'new-one']);
  });

  it('shows the live name and drops a design that is not public', () => {
    const list = homeDesigns([
      builtIn('bachelorette', 'שם חדש'),
      builtIn('marriage', 'סנטוריני', { public: false }),
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('שם חדש');
    expect(list[0].href).toBe('product.html?design=bachelorette');
  });

  it('uses the approved single cards and boards, and every one of those files exists', () => {
    const ids = Object.keys(DESIGN_ART);
    const list = homeDesigns(
      ids.map((id) =>
        id.includes('-') || ['grapefruit', 'tarifa'].includes(id)
          ? custom(id, id, { front: 'f' })
          : builtIn(id, id)
      )
    );
    expect(list.map((d) => d.id)).toEqual(ids);
    for (const d of list) {
      expect(d.fronts).toHaveLength(DESIGN_ART[d.id].fronts);
      for (const f of [...d.fronts, d.back, d.board && d.board.src]) {
        expect(f, d.id).toBeTruthy();
        expect(fs.existsSync(path.join(SITE, f)), f).toBe(true);
      }
      for (const part of (d.board.srcset || '').split(',').filter(Boolean)) {
        expect(fs.existsSync(path.join(SITE, part.trim().split(' ')[0])), part).toBe(true);
      }
    }
  });

  it('shows a public custom design it has no art for from its own template card', () => {
    const [d] = homeDesigns([
      custom('new-one', 'חדש', {
        front: '/api/template-image/new-one/front',
        back: '/api/template-image/new-one/back',
      }),
    ]);
    expect(d.fronts).toEqual(['/api/template-image/new-one/front']);
    expect(d.back).toBe('/api/template-image/new-one/back');
    expect(d.board).toBeNull();
    expect(d.deal).toBe(true);
  });

  it('never shows a built-in design without art: its live picture is a sheet of eight, not a card', () => {
    expect(homeDesigns([builtIn('brand-new', 'x')])).toEqual([]);
  });

  it('deals every design with a back except ברוקלין', () => {
    const list = homeDesigns([builtIn('kids', 'ברוקלין'), builtIn('bachelorette', 'פריז')]);
    expect(list.find((d) => d.id === 'kids').deal).toBe(false);
    expect(list.find((d) => d.id === 'bachelorette').deal).toBe(true);
  });
});

describe('the colours match DESIGN.md', () => {
  const tokens = fs.readFileSync(path.join(SITE, 'css', 'redesign-tokens.css'), 'utf8');
  const tok = (n) => (tokens.match(new RegExp(`--${n}:\\s*(#[0-9a-f]{6})`, 'i')) || [])[1];
  const NAMES = {
    bachelorette: 'paris',
    birthday: 'california',
    grapefruit: 'oasis',
    marriage: 'santorini',
    'daniel-amit': 'dani',
    japanese: 'tokyo',
    posttrip: 'seychelles',
    'football-boys': 'haaland',
    tarifa: 'tarifa',
    kids: 'brooklyn',
  };
  for (const [id, n] of Object.entries(NAMES)) {
    it(`${id}: the base, the tapped view and the panel are the recorded tokens`, () => {
      const c = DESIGN_ART[id].color;
      expect(c).toBe(tok(`design-${n}`));
      expect(floodColor(c)).toBe(tok(`design-${n}-flood`));
      expect(panelColors(c)).toEqual([tok(`design-${n}-panel`), tok(`design-${n}-panel-mid`)]);
    });
  }
});

describe('the price', () => {
  it('reads the live price, and the old one only during a sale', () => {
    expect(priceText({ store: { now: 239, was: 279 }, sale: { on: false } })).toEqual({
      now: '239 ₪',
      was: null,
    });
    expect(priceText({ store: { now: 199, was: 239 }, sale: { on: true } })).toEqual({
      now: '199 ₪',
      was: '239 ₪',
    });
    expect(priceText({ store: {} })).toBeNull();
  });
});

describe('new.html', () => {
  const html = read('new.html');

  it('is private: noindex, and not one of the public pages', () => {
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow" \/>/);
    expect(seo.PUBLIC_PAGES.map((p) => p.file)).not.toContain('new.html');
    expect(seo.PUBLIC_PAGES.map((p) => p.file)).toContain('index.html'); // the list really is file names
  });

  it('every editable text has a valid key and a shipped default', () => {
    const keys = [...html.matchAll(/data-edit(?:-img)?="([^"]+)"[^>]*>([^<]*)/g)];
    expect(keys.length).toBeGreaterThan(40);
    const seen = new Set();
    for (const [, key, text] of keys) {
      expect(key).toMatch(/^[a-z0-9][a-z0-9-]{0,60}$/);
      // the story and the footer are the live homepage's texts, read and written through its bucket
      expect(/^(new-|index-story-|index-footer-)/.test(key), key).toBe(true);
      // a review's caption ships empty on purpose: until the owner writes one, its sheet shows the occasion
      const mayBeEmpty =
        html.includes(`data-edit-img="${key}"`) || /^new-review-\d+-cap$/.test(key);
      if (!mayBeEmpty) expect(text.trim(), key).not.toBe('');
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }
    // the story keys are the live homepage's, read and written through its bucket
    expect(html).toMatch(/data-edit-scope="index.html"[\s\S]*data-edit="index-story-heading"/);
    expect(html).toMatch(/<footer class="site-ft" data-edit-scope="index.html">/);
  });

  it('self-hosts its fonts: every face is a real woff2, the body face sized to Rubik', () => {
    const css = read('css/home-new.css');
    const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => m[1]);
    expect(faces.length).toBe(11);
    expect(css).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    const weights = new Set();
    for (const f of faces) {
      const url = f.match(/url\((\/assets\/fonts\/[^)]+\.woff2)\)/)[1];
      const buf = fs.readFileSync(path.join(SITE, url));
      expect(buf.toString('latin1', 0, 4), url).toBe('wOF2');
      expect(url).toMatch(/\.[0-9a-f]{8}\.woff2$/);
      if (f.includes('M PLUS Rounded 1c')) {
        expect(f).toContain('size-adjust: 109.8%');
        weights.add(+f.match(/font-weight: (\d+)/)[1]);
      } else expect(f).toContain('unicode-range: U+0590-05FF'); // the heading face is Hebrew only
    }
    expect([...weights].sort()).toEqual([400, 500, 700, 800, 900]);
  });

  it('links its own styles and the shared analytics and editor scripts', () => {
    expect(html).toContain('/css/redesign-tokens.css');
    expect(html).toContain('<script src="js/consent.js" defer></script>');
    expect(html).toContain('<script type="module" src="js/analytics.js"></script>');
    expect(html).toContain('<script src="js/editor.js" defer></script>');
    expect(html).toContain('<meta name="dugri:page" content="new.html" />');
  });

  it('ships no prototype tooling: no placement editor, no test switches, no placeholders', () => {
    expect(html).not.toMatch(/id="pal"|#place|#fields|\{price\}|\{שם\}|cards12|r1[67]\.html/);
    const js = read('js/home-new.js') + read('js/home-illos.js');
    expect(js).not.toMatch(/localStorage|location\.hash|__r7/);
  });

  it('every review screenshot and client logo it shows exists', () => {
    const refs = [...html.matchAll(/(?:data-shot|src)="(assets\/home\/[^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(15);
    for (const r of refs) expect(fs.existsSync(path.join(SITE, r)), r).toBe(true);
  });
});

describe('the reviews row', () => {
  const html = read('new.html');
  const track = html.slice(html.indexOf('id="track"'), html.indexOf('<dialog class="sheet"'));

  it('every review and logo is a card: class rc, never a stray class name that leaves a bare grey button', () => {
    const cls = [...track.matchAll(/<(?:button|div) class="([^"]*)"/g)].map((m) => m[1]);
    expect(cls.length).toBe(13); // 8 reviews, 5 logos
    for (const c of cls) expect(c.split(' ')[0], c).toBe('rc');
    expect(cls.filter((c) => c.startsWith('rc hot') || c === 'rc')).toHaveLength(8);
  });
});

describe('the site footer on the redesigned pages', () => {
  it('has the live homepage footer’s links, contacts and editable texts, on both pages', () => {
    const index = read('index.html');
    const idxFoot = index.slice(index.indexOf('<footer>'), index.indexOf('</footer>'));
    const testids = [...idxFoot.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]);
    const keys = [...idxFoot.matchAll(/data-edit="(index-footer-(?!brand)[^"]+)"/g)].map(
      (m) => m[1]
    );
    expect(testids.length).toBeGreaterThanOrEqual(4);
    for (const page of ['new.html', 'new-faq.html']) {
      const html = read(page);
      const foot = html.slice(html.indexOf('<footer class="site-ft"'), html.indexOf('</footer>'));
      for (const t of testids) expect(foot, `${page} ${t}`).toContain(`data-testid="${t}"`);
      for (const k of keys) expect(foot, `${page} ${k}`).toContain(`data-edit="${k}"`);
      for (const href of [
        'wordlists.html',
        'terms.html',
        'pickup.html',
        'timer.html',
        'new-faq.html',
        'mailto:',
        'tel:',
        'instagram.com',
        'wa.me',
      ])
        expect(foot, `${page} ${href}`).toContain(href);
    }
  });
});

describe('the questions page', () => {
  const home = read('new.html');
  const faq = read('new-faq.html');

  it('the FAQ left the homepage; its menu and footer link to new-faq.html', () => {
    expect(home).not.toMatch(/id="faq"|id="faqList"|href="#faq"/);
    expect(home.match(/href="new-faq\.html"/g)).toHaveLength(2);
    expect(read('js/home-new.js')).not.toMatch(/initFaq|faqList/);
  });

  it('is private like new.html, with the live FAQ, the shared menu and every link back to the homepage', () => {
    expect(faq).toMatch(/<meta name="robots" content="noindex, nofollow" \/>/);
    expect(seo.PUBLIC_PAGES.map((p) => p.file)).not.toContain('new-faq.html');
    expect(faq).toContain('<meta name="dugri:page" content="new-faq.html" />');
    expect(faq).toContain('<script type="module" src="js/new-faq.js"></script>');
    expect(faq).toContain('id="faqList"');
    expect(faq.match(/<details/g).length).toBeGreaterThanOrEqual(5); // shown until /api/faq answers
    expect(faq).not.toMatch(/href="#/); // no section of this page to jump to: every menu link is new.html#…
    for (const id of ['order', 'story', 'recs', 'biz'])
      expect(faq).toContain(`href="new.html#${id}"`);
    expect(faq).toMatch(/href="new-faq\.html" aria-current="page"/);
    const js = read('js/new-faq.js');
    expect(js).toMatch(/initFaq\(/);
    expect(js).toMatch(/initMenu\(/);
  });

  it('every editable text has a new- key (or the homepage footer’s) and a default', () => {
    const keys = [...faq.matchAll(/data-edit="([^"]+)"[^>]*>([^<]*)/g)];
    expect(
      keys
        .map((k) => k[1])
        .filter((k) => k.startsWith('new-'))
        .sort()
    ).toEqual(['new-faq-cta', 'new-faq-heading', 'new-faq-more', 'new-faq-wa']);
    for (const [, key] of keys) expect(key, key).toMatch(/^(new-faq-|index-footer-)/);
    for (const [, key, text] of keys) expect(text.trim(), key).not.toBe('');
  });
});

describe("old Safari (the owner's Mac shows no WebP: Safari 15.6 at most)", () => {
  const css = read('css/home-new.css');
  const pages = { 'new.html': read('new.html'), 'new-faq.html': read('new-faq.html') };

  it('both pages load home-legacy.js before any other script, as a classic script', () => {
    for (const [name, html] of Object.entries(pages)) {
      const first = html.match(/<script[^>]*src="([^"]+)"[^>]*>/);
      expect(first[0], name).toBe('<script src="js/home-legacy.js">');
      expect(html.indexOf('home-legacy.js'), name).toBeLessThan(html.indexOf('<img'));
    }
  });

  it('the module graphs parse as ES2019: no ?. or ??, no class fields, no top-level await', () => {
    const seen = new Set();
    const q = ['js/home-new.js', 'js/new-faq.js'];
    while (q.length) {
      const f = q.shift();
      if (seen.has(f)) continue;
      seen.add(f);
      const src = read(f);
      expect(() => acorn.parse(src, { ecmaVersion: 2019, sourceType: 'module' }), f).not.toThrow();
      for (const m of src.matchAll(/from '\.\/([^']+)'/g)) q.push('js/' + m[1]);
    }
    expect(seen.size).toBeGreaterThan(6);
  });

  it('the stylesheet uses no shorthand Safari before 14.1 drops, and backs every newer value with an older one', () => {
    expect(css).not.toMatch(
      /^\s*(inset|inset-inline|inset-block|inset-inline-end|inset-inline-start):/m
    );
    expect(css).not.toMatch(/^\s*(padding|margin|border)-(inline|block):/m);
    const lines = css.split('\n');
    lines.forEach((l, i) => {
      // svh (15.4) and overflow: clip (16): the line above holds the fallback for the same property
      const prop = l.split(':')[0].trim();
      if (/\dsvh/.test(l)) expect(lines[i - 1], `line ${i + 1}`).toBe(l.replace(/svh/g, 'vh'));
      if (/^\s*overflow(-[xy])?: clip;/.test(l))
        expect(lines[i - 1].trim(), `line ${i + 1}`).toMatch(new RegExp(`^${prop}: hidden;`));
    });
  });

  it('a :focus-visible never shares a rule with selectors that work without it: Safari before 15.4 drops the whole rule', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g);
    for (const m of rules) {
      const sels = m[1].split(',').map((x) => x.trim());
      const fv = sels.filter((x) => x.includes(':focus-visible'));
      if (fv.length) expect(fv.length, m[1]).toBe(sels.length);
    }
  });

  it('a closed <dialog> is hidden by the page, and the deck and the dealt card have a height without aspect-ratio', () => {
    expect(css).toMatch(/dialog:not\(\[open\]\) \{\s*display: none;/);
    for (const sel of ['.deck', '.card'])
      expect(css).toMatch(
        new RegExp(`\\n\\${sel} \\{[^}]*height: calc\\(var\\(--cw\\) \\* 1\\.41\\);`)
      );
  });
});

describe('the illustrations', () => {
  it('places only the eight kinds, in the four sections, inside -1..101 and 0..100', () => {
    expect(Object.keys(ILL).sort()).toEqual([
      'bstar',
      'cross',
      'disco',
      'glass',
      'popper',
      'pstar',
      'sparks',
      'star',
    ]);
    for (const bp of ['m', 'd']) {
      for (const [kind, sec, x, y, w] of PLACEMENTS[bp]) {
        expect(ILL[kind]).toBeTruthy();
        expect(['top', 'order', 'recs', 'story']).toContain(sec);
        expect(x).toBeGreaterThanOrEqual(-1);
        expect(x).toBeLessThanOrEqual(101);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(100);
        expect(w).toBeGreaterThan(0);
      }
    }
    expect(PLACEMENTS.m).toHaveLength(15);
    expect(PLACEMENTS.d).toHaveLength(23);
  });
});
