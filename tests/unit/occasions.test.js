// @vitest-environment node
// The occasion landing pages (server/occasions.js, site/occasion.html, server/occasions/*.json). What these pin:
//   1. every data file obeys the format and the copy rules (8 example words, 4-5 questions, "עד 412 מילים אישיות", no price,
//      no tax invoice, no trademarked game name, no minimum, no typed production time, the fixed players answer)
//   2. the production time is the admin's, filled in per request
//   3. the template is filled entirely from the data file and new.html's shared pieces, and every order link carries the slug
//   4. the routes: a live slug is served, a known slug that is not live and the raw template answer 404
//   5. the footer's "לפי אירוע" row, on the home pages and the occasion pages
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const siteDir = path.join(__dirname, '..', '..', 'site');
const occ = require(path.join(serverDir, 'occasions.js'));
const DATA = occ.DATA_DIR;
const files = fs.readdirSync(DATA).filter((f) => f.endsWith('.json'));
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const NEW_HTML = fs.readFileSync(path.join(siteDir, 'new.html'), 'utf8');
const TEMPLATE = fs.readFileSync(path.join(siteDir, 'occasion.html'), 'utf8');
const ETA = 'המשחק מוכן בדרך כלל תוך כ-4 ימי עסקים מרגע שרשימת המילים מוכנה.';

describe('the data files', () => {
  const known = new Set(files.map((f) => read(f).slug));

  it('page 1 and its dad page exist and are live', () => {
    expect(known).toEqual(new Set(['yom-huledet', 'yom-huledet-aba']));
    expect(occ.live().map((o) => o.slug)).toEqual(['yom-huledet', 'yom-huledet-aba']);
  });

  for (const f of files) {
    it(`${f} obeys the format and the copy rules`, () => {
      const o = read(f);
      expect(f).toBe(o.slug + '.json');
      expect(occ.validateOccasion(o, known)).toEqual([]);
      expect(o.sampleWords.words).toHaveLength(8);
      expect(o.faq.items.length).toBeGreaterThanOrEqual(4);
      expect(o.faq.items.length).toBeLessThanOrEqual(5);
      const text = JSON.stringify(o);
      expect(text).toContain('עד 412 מילים אישיות');
      expect(text).not.toMatch(/₪|מחיר|חשבונית|אליאס|alias|מינימום/i);
      // the production time is never typed: it is the admin's, as {eta}
      expect(text).not.toMatch(/\d+\s*ימי עסקים/);
      expect(text).toContain('{eta}');
      const players = o.faq.items.find((i) => /כמה אנשים יכולים לשחק/.test(i.q));
      expect(players.a).toBe('כמה שרוצים, עדיף בקבוצות.');
    });
  }

  it('the dad page speaks about אבא, not אמא', () => {
    const aba = read('yom-huledet-aba.json');
    expect(aba.catch).toBe('כל המילים עליו!');
    expect(JSON.stringify(aba)).not.toMatch(/אמא/);
  });

  it('the validator rejects each broken rule', () => {
    const good = read('yom-huledet.json');
    const known = new Set(['yom-huledet', 'yom-huledet-aba']);
    const bad = (mut) => {
      const o = JSON.parse(JSON.stringify(good));
      mut(o);
      return occ.validateOccasion(o, known);
    };
    expect(occ.validateOccasion(good, known)).toEqual([]);
    expect(bad((o) => o.sampleWords.words.pop())).toContain('sampleWords: exactly 8 words');
    expect(bad((o) => (o.faq.items = o.faq.items.slice(0, 3))).join()).toMatch(/4-5 questions/);
    expect(bad((o) => (o.blueBox.lead += ' רק 199 ₪'))).toContain('states a price');
    expect(bad((o) => (o.faq.items[1].a += ' כולל חשבונית'))).toContain('mentions a tax invoice');
    expect(bad((o) => (o.blueBox.body += ' כמו אליאס'))).toContain('names the trademarked game');
    expect(bad((o) => (o.blueBox.body += ' מינימום 100 מילים'))).toContain(
      'states a minimum word count'
    );
    expect(bad((o) => (o.steps.items[2].text = 'תוך 4 ימי עסקים'))).toContain(
      'types the production time (use {eta})'
    );
    const no412 = JSON.parse(JSON.stringify(good).replace(/עד 412 מילים אישיות/g, 'מילים'));
    expect(occ.validateOccasion(no412, known)).toContain('says "עד 412 מילים אישיות"');
    expect(bad((o) => (o.faq.items[0].a = 'עד 10 אנשים')).join()).toMatch(/players answer/);
    expect(bad((o) => (o.related = ['nope'])).join()).toMatch(/unknown slug nope/);
    expect(bad((o) => (o.audience = 'other'))).toContain('audience');
    expect(bad((o) => delete o.live)).toContain('live must be true or false');
    expect(bad((o) => (o.slug = 'Not A Slug'))).toContain('slug');
  });

  it('a bad file is left out of the loaded set, and the others still load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-occ-'));
    fs.copyFileSync(path.join(DATA, 'yom-huledet.json'), path.join(dir, 'yom-huledet.json'));
    const broken = read('yom-huledet-aba.json');
    broken.sampleWords.words = ['x'];
    fs.writeFileSync(path.join(dir, 'yom-huledet-aba.json'), JSON.stringify(broken));
    fs.writeFileSync(path.join(dir, 'junk.json'), '{not json');
    const err = console.error;
    console.error = () => {};
    try {
      // the good page's `related` names the broken one: it still loads, as the slug is known
      expect([...occ.loadOccasions(dir).keys()]).toEqual(['yom-huledet']);
    } finally {
      console.error = err;
    }
  });
});

describe('the production time', () => {
  it("is read out of the admin's pickup eta", () => {
    expect(occ.etaPhrase(ETA)).toBe('4 ימי עסקים');
    expect(occ.etaPhrase('מוכן תוך 6 ימי עסקים')).toBe('6 ימי עסקים');
    expect(occ.etaPhrase('בקרוב')).toBe(null);
    const o = occ.resolve(occ.find('yom-huledet'), 'מוכן תוך כ-6 ימי עסקים.');
    expect(o.description).toContain('תוך 6 ימי עסקים');
    expect(o.steps.items[2].text).toContain('תוך 6 ימי עסקים');
    expect(JSON.stringify(o)).not.toContain('{eta}');
    // with no number in the admin's text, no number is invented
    expect(occ.resolve(occ.find('yom-huledet'), '').description).toContain('תוך כמה ימי עסקים');
  });
});

describe('the template', () => {
  const page = occ.resolve(occ.find('yom-huledet'), ETA);
  const html = occ.renderPage(TEMPLATE, NEW_HTML, page);

  it('finds every shared piece in new.html, each holding no element of its own kind', () => {
    for (const [name, inner] of [
      ['recs', '<section'],
      ['sheet', '<dialog'],
      ['flood', '<dialog'],
      ['biz', '<section'],
      ['footer', '<footer'],
    ]) {
      const p = occ.piece(NEW_HTML, name);
      expect(p, name).not.toBe('');
      expect(p.slice(1).includes(inner), name).toBe(false);
    }
  });

  it('is filled entirely, from the data file', () => {
    expect(html).not.toMatch(/\{\{\{?\w+\}?\}\}/);
    expect(html).toContain(
      '<title>מתנה ליום הולדת 60 לאמא – משחק שכל המשפחה כותבת | דוגרי</title>'
    );
    expect(html).toContain('<h1 id="h1" class="tt">המתנה ליום הולדת 60 שכל המשפחה כותבת</h1>');
    expect(html).toContain('<b>משחק מילים אישי שכל כולו על אמא.</b>');
    expect(html).toContain('<span class="big">כל המילים עליה!</span>');
    for (const w of page.sampleWords.words) expect(html).toContain(w.replace(/"/g, '&quot;'));
    for (const f of page.faq.items) expect(html).toContain(`<summary>${f.q}</summary>`);
    expect(html).toContain('תוך 4 ימי עסקים, ומשחקים בארוחה');
    const cfg = JSON.parse(html.match(/id="occasion-data">([^<]*)</)[1]);
    expect(cfg).toEqual({ slug: 'yom-huledet', audience: 'private', designs: page.designs });
  });

  it("carries the home page's reviews (read from new.html's content) and hides the business section; no story", () => {
    expect(html).toContain('<section data-edit-scope="new.html" class="recs"');
    expect(html).toContain('data-edit="new-review-2-quote"');
    expect(html).toMatch(/<section data-edit-scope="new\.html" hidden class="biz"/);
    expect(html).not.toContain('class="story"');
    expect(html).toContain('<footer class="site-ft" data-edit-scope="index.html">');
  });

  it('sends every order button to options.html?occasion=<slug>', () => {
    const orders = [...html.matchAll(/<a\s+class="pill"\s+href="([^"]*)"/g)].map((m) => m[1]);
    // header, hero, steps, designs, faq, menu (the business section's WhatsApp is hidden with it)
    const own = orders.filter((h) => !h.startsWith('https://wa.me/'));
    expect(own.length).toBeGreaterThanOrEqual(6);
    for (const h of own) expect(h).toBe('options.html?occasion=yom-huledet');
  });

  it('escapes the data', () => {
    const o = JSON.parse(JSON.stringify(page));
    o.h1 = '<script>x</script>';
    expect(occ.renderPage(TEMPLATE, NEW_HTML, o)).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

describe('the "לפי אירוע" row', () => {
  it('links every live page and marks the current one', () => {
    const row = occ.footerRow(occ.live(), 'yom-huledet-aba');
    expect(row).toContain('<a href="/yom-huledet" data-ga');
    expect(row).toContain('<a href="/yom-huledet-aba" aria-current="page"');
    expect(row).toContain('יום הולדת לאמא');
    expect(occ.footerRow([], null)).toBe('');
  });

  it('sits on both home pages and the template, and nowhere a page has no marker', () => {
    for (const f of ['index.html', 'new.html', 'occasion.html'])
      expect(fs.readFileSync(path.join(siteDir, f), 'utf8'), f).toContain(occ.ROW_MARK);
    expect(occ.injectRow('<p>x</p>', null)).toBe('<p>x</p>');
    expect(occ.injectRow('<p>' + occ.ROW_MARK + '</p>', null)).toContain(
      'data-testid="footer-occasions"'
    );
  });
});

describe('the routes (app)', () => {
  let server;
  let base;
  let settings;
  let live;

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-occ-routes-'));
    for (const f of ['faq.js', 'settings.js', 'notify.js', 'seo.js', 'occasions.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    const app = require(path.join(serverDir, 'index.js'));
    settings = require(path.join(serverDir, 'settings.js'));
    live = require(path.join(serverDir, 'occasions.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    delete process.env.DATA_DIR;
  });

  it('serves a live page at its slug', async () => {
    for (const slug of ['yom-huledet', 'yom-huledet-aba']) {
      const r = await fetch(base + '/' + slug);
      expect(r.status, slug).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/text\/html/);
      const html = await r.text();
      expect(html).toContain(`data-occasion="${slug}"`);
      expect(html).toContain('data-testid="footer-occasions"');
    }
  });

  it('a known slug that is not live, and the raw template, answer 404', async () => {
    live.all().set('draft-page', { ...live.find('yom-huledet'), slug: 'draft-page', live: false });
    try {
      expect((await fetch(base + '/draft-page')).status).toBe(404);
    } finally {
      live.all().delete('draft-page');
    }
    expect((await fetch(base + '/occasion.html')).status).toBe(404);
    expect((await fetch(base + '/occasion')).status).toBe(404);
  });

  it("follows the admin's production time on the next request", async () => {
    const pickup = settings.get('email', 'pickup_info');
    settings.set('email', 'pickup_info', { ...pickup, eta: 'המשחק מוכן תוך כ-6 ימי עסקים.' });
    try {
      const html = await (await fetch(base + '/yom-huledet')).text();
      expect(html).toContain('ולוח מעוצבים תוך 6 ימי עסקים.');
      expect(html).not.toContain('{eta}');
    } finally {
      settings.set('email', 'pickup_info', pickup);
    }
  });

  it('the home page carries the row; another page does not', async () => {
    expect(await (await fetch(base + '/')).text()).toContain('href="/yom-huledet"');
    expect(await (await fetch(base + '/products.html')).text()).not.toContain('footer-occasions');
  });
});
