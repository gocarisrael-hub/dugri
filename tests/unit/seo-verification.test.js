// @vitest-environment node
//
// Search Console / Bing ownership tags (GOOGLE_SITE_VERIFICATION,
// BING_SITE_VERIFICATION, documented in RAILWAY_SETUP.md): on the home page only,
// in both of its looks (index.html, and new.html, which the redesign mode serves
// at "/"), and only when set. Plus two facts the structured data and llms.txt
// read rather than type: the mit4mit listing in Organization.sameAs, and the
// production time in llms.txt, which is the admin's pickup eta.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const seo = require(path.join(serverDir, 'seo.js'));

const GOOGLE = '<meta name="google-site-verification" content="g-TOKEN_123" />';
const BING = '<meta name="msvalidate.01" content="B1NG0TOKEN" />';

afterEach(() => {
  delete process.env.GOOGLE_SITE_VERIFICATION;
  delete process.env.BING_SITE_VERIFICATION;
});

describe('verificationTags (pure)', () => {
  it('is nothing when neither is set', () => {
    expect(seo.verificationTags({})).toEqual([]);
  });
  it('is one tag per variable that is set', () => {
    expect(seo.verificationTags({ GOOGLE_SITE_VERIFICATION: 'g-TOKEN_123' })).toEqual([GOOGLE]);
    expect(
      seo.verificationTags({
        GOOGLE_SITE_VERIFICATION: ' g-TOKEN_123 ',
        BING_SITE_VERIFICATION: 'B1NG0TOKEN',
      })
    ).toEqual([GOOGLE, BING]);
  });
  it('takes a whole pasted <meta> tag down to its token', () => {
    expect(
      seo.verificationTags({
        GOOGLE_SITE_VERIFICATION: '<meta name="google-site-verification" content="g-TOKEN_123" />',
      })
    ).toEqual([GOOGLE]);
  });
  it('refuses a value that could break out of the attribute', () => {
    expect(seo.verificationTags({ GOOGLE_SITE_VERIFICATION: 'a"><script>x</script>' })).toEqual([]);
  });
});

describe('headTags puts them on the home page only', () => {
  const tags = (file, extra = {}) =>
    seo.headTags({ file, query: {}, indexable: true, price: 199, faq: [], ...extra });

  it('on index.html and new.html, indexable or not, when set', () => {
    process.env.GOOGLE_SITE_VERIFICATION = 'g-TOKEN_123';
    process.env.BING_SITE_VERIFICATION = 'B1NG0TOKEN';
    for (const file of ['index.html', 'new.html']) {
      expect(tags(file)).toContain(GOOGLE);
      expect(tags(file)).toContain(BING);
      expect(tags(file, { indexable: false })).toContain(GOOGLE);
    }
    expect(tags(null, { fallback: true })).toContain(GOOGLE);
  });

  it('never on any other page', () => {
    process.env.GOOGLE_SITE_VERIFICATION = 'g-TOKEN_123';
    process.env.BING_SITE_VERIFICATION = 'B1NG0TOKEN';
    for (const file of [
      'products.html',
      'options.html',
      'pickup.html',
      seo.occasionFile('yom-huledet'),
    ])
      expect(tags(file)).not.toMatch(/site-verification|msvalidate/);
  });

  it('nowhere when unset', () => {
    expect(tags('index.html')).not.toMatch(/site-verification|msvalidate/);
  });
});

describe('Organization.sameAs', () => {
  it('names Instagram and the mit4mit listing', () => {
    const t = seo.headTags({ file: 'index.html', query: {}, indexable: true, price: 199, faq: [] });
    const org = JSON.parse(t.match(/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'][0];
    expect(org['@type']).toBe('Organization');
    expect(org.sameAs).toEqual([
      'https://instagram.com/dugri_israel',
      'https://www.mit4mit.co.il/biz/106559',
    ]);
  });
  it('leaves the Google Business Profile as a TODO for the owner', () => {
    const src = fs.readFileSync(path.join(serverDir, 'seo.js'), 'utf8');
    expect(src).toMatch(/TODO\(owner\): the Google Business Profile/);
  });
});

describe('llms.txt quotes the admin’s production time', () => {
  it('as the number in the pickup eta', () => {
    const t = seo.llmsTxt({
      price: null,
      faq: [],
      eta: 'מוכן תוך כ-6 ימי עסקים מרגע שרשימת המילים מוכנה.',
    });
    expect(t).toContain('- זמן אספקה: עד 6 ימי עסקים מרגע שליחת רשימת המילים');
  });
  it('with no number there, it types none', () => {
    const t = seo.llmsTxt({ price: null, faq: [], eta: 'בקרוב' });
    expect(t).toContain('- זמן אספקה: כמה ימי עסקים מרגע שליחת רשימת המילים');
    expect(t).not.toMatch(/\d+\s*ימי\s*עסקים/);
  });
  it('the source types no day count of its own', () => {
    const src = fs.readFileSync(path.join(serverDir, 'seo.js'), 'utf8');
    expect(src).not.toMatch(/\d+\s*ימי\s*עסקים/);
  });
});

describe('the routes (app)', () => {
  let server;
  let base;
  let settings;

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-seo-verify-'));
    for (const k of Object.keys(require.cache))
      if (k.startsWith(serverDir)) delete require.cache[k];
    const app = require(path.join(serverDir, 'index.js'));
    settings = require(path.join(serverDir, 'settings.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
  });
  const get = (p) =>
    fetch(base + p, { headers: { 'x-forwarded-host': 'dugri-israel.co.il' } }).then((r) =>
      r.text()
    );

  it('"/" carries the tags in either look, and /products.html does not', async () => {
    process.env.GOOGLE_SITE_VERIFICATION = 'g-TOKEN_123';
    process.env.BING_SITE_VERIFICATION = 'B1NG0TOKEN';
    settings.set('redesign', 'enabled', false);
    const legacy = await get('/');
    expect(legacy).toContain(GOOGLE);
    expect(legacy).toContain(BING);
    settings.set('redesign', 'enabled', true);
    const redesigned = await get('/');
    expect(redesigned).toContain('home-new'); // new.html is what "/" serves now
    expect(redesigned).toContain(GOOGLE);
    expect(redesigned).toContain(BING);
    settings.set('redesign', 'enabled', false);
    expect(await get('/products.html')).not.toMatch(/site-verification|msvalidate/);
    expect(await get('/yom-huledet')).not.toMatch(/site-verification|msvalidate/);
  });

  it('llms.txt follows an edit to the admin’s pickup eta', async () => {
    const pickup = settings.get('email', 'pickup_info');
    settings.set('email', 'pickup_info', { ...pickup, eta: 'מוכן תוך כ-7 ימי עסקים.' });
    const t = await get('/llms.txt');
    const line = t.split('\n').find((l) => l.startsWith('- זמן אספקה:'));
    expect(line).toContain('עד 7 ימי עסקים');
    settings.set('email', 'pickup_info', pickup);
  });
});
