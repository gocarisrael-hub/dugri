// @vitest-environment node
// SEARCH AND AI VISIBILITY: robots.txt, sitemap.xml, llms.txt and the head tags
// (canonical, noindex, JSON-LD) — server/seo.js and its wiring in index.js.
//
// The two properties that matter most:
//   • production (dugri-israel.co.il) is open to crawlers and carries the
//     structured data; every other host (staging, *.up.railway.app) is closed,
//     so Google never indexes a second copy of the shop.
//   • private pages (admin, a buyer's collection, payment returns) are noindex
//     on every host, including production.
//
// Same harness as api-no-store.test.js: require the app and bind a port. The
// host is sent as X-Forwarded-Host (trust proxy is on), which is how a request
// reaches the app behind Cloudflare/Railway.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const seo = require(path.join(serverDir, 'seo.js'));

const PROD = 'dugri-israel.co.il';
const STAGING = 'dugri-staging.up.railway.app';

describe('seo module (pure)', () => {
  it('only the production domain is indexable', () => {
    expect(seo.isIndexableHost(PROD)).toBe(true);
    expect(seo.isIndexableHost('www.' + PROD)).toBe(true);
    expect(seo.isIndexableHost('DUGRI-ISRAEL.CO.IL')).toBe(true);
    expect(seo.isIndexableHost(STAGING)).toBe(false);
    expect(seo.isIndexableHost('localhost')).toBe(false);
    expect(seo.isIndexableHost('')).toBe(false);
    expect(seo.isIndexableHost('evil-dugri-israel.co.il')).toBe(false);
  });

  it('robots.txt closes every non-production host', () => {
    expect(seo.robotsTxt({ indexable: false })).toBe('User-agent: *\nDisallow: /\n');
  });

  it('robots.txt on production allows all, blocks private paths, links the sitemap', () => {
    const t = seo.robotsTxt({ indexable: true });
    expect(t).toMatch(/^User-agent: \*$/m);
    expect(t).toMatch(/^Allow: \/$/m);
    for (const p of ['/admin', '/collect', '/pay', '/proof', '/dashboard']) {
      expect(t).toContain('Disallow: ' + p + '\n');
    }
    // The storefront's own data endpoints stay crawlable: Google renders the page.
    expect(t).not.toMatch(/^Disallow: \/api\/?$/m);
    expect(t).toContain('Sitemap: https://dugri-israel.co.il/sitemap.xml');
    // A bot-specific group would make that bot ignore every Disallow above.
    expect(t.match(/^User-agent:/gm)).toHaveLength(1);
  });

  it('sitemap lists the public pages and safe design ids only', () => {
    const x = seo.sitemapXml({ designIds: ['bachelorette', 'bad id"><x', 'birthday'] });
    expect(x).toContain('<loc>https://dugri-israel.co.il/</loc>');
    expect(x).toContain('<loc>https://dugri-israel.co.il/products.html</loc>');
    expect(x).toContain('product.html?design=bachelorette');
    expect(x).toContain('product.html?design=birthday');
    expect(x).not.toContain('bad id');
    expect(x).not.toMatch(/admin|collect|pay-/);
  });

  it('canonical drops tracking queries but keeps a product design', () => {
    expect(seo.canonicalUrl('index.html', { utm_source: 'ig', fbclid: 'x' })).toBe(
      'https://dugri-israel.co.il/'
    );
    expect(seo.canonicalUrl('product.html', { design: 'marriage', utm_source: 'ig' })).toBe(
      'https://dugri-israel.co.il/product.html?design=marriage'
    );
    expect(seo.canonicalUrl('product.html', { design: '"><script>' })).toBe(
      'https://dugri-israel.co.il/product.html'
    );
    expect(seo.canonicalUrl('admin.html', {})).toBe(null);
    expect(seo.canonicalUrl(null, {}, { fallback: true })).toBe('https://dugri-israel.co.il/');
  });

  it('a private page gets noindex and nothing else, even on production', () => {
    const t = seo.headTags({ file: 'pay-done.html', query: {}, indexable: true, html: '' });
    expect(t).toBe('<meta name="robots" content="noindex" />');
    // …and is not duplicated where the page already carries its own.
    const own = seo.headTags({
      file: 'admin.html',
      query: {},
      indexable: true,
      html: '<meta name="robots" content="noindex" />',
    });
    expect(own).toBe('');
  });

  it('the home page carries Organization, WebSite, Product with the live price, and FAQPage', () => {
    const t = seo.headTags({
      file: 'index.html',
      query: {},
      indexable: true,
      html: '',
      price: 187,
      faq: [{ q: 'מה זה?', a: 'משחק </script><b>x' }],
    });
    expect(t).toContain('<link rel="canonical" href="https://dugri-israel.co.il/" />');
    expect(t).toContain('og:image');
    const m = t.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).toBeTruthy();
    // Owner text can never close the script block.
    expect(m[1]).not.toContain('</script>');
    const ld = JSON.parse(m[1]);
    const types = ld['@graph'].map((n) => n['@type']);
    expect(types).toEqual(['Organization', 'WebSite', 'Product', 'FAQPage']);
    const product = ld['@graph'][2];
    expect(product.offers.price).toBe('187');
    expect(product.offers.priceCurrency).toBe('ILS');
    expect(ld['@graph'][3].mainEntity[0].acceptedAnswer.text).toBe('משחק </script><b>x');
    expect(ld['@graph'][0].alternateName).toContain('Dugri');
  });

  it('no Offer without a real price', () => {
    const t = seo.headTags({ file: 'products.html', query: {}, indexable: true, price: null });
    const ld = JSON.parse(t.match(/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const product = ld['@graph'].find((n) => n['@type'] === 'Product');
    expect(product.offers).toBeUndefined();
  });

  it('llms.txt names the brand, the live price and the FAQ', () => {
    const t = seo.llmsTxt({ price: 199, faq: [{ q: 'כמה מילים?', a: '100 עד 400' }] });
    expect(t.startsWith('# דוגרי (Dugri)\n')).toBe(true);
    expect(t).toContain('199 ₪');
    expect(t).toContain('### כמה מילים?');
    expect(t).toContain('https://dugri-israel.co.il/products.html');
    expect(t).not.toContain('אליאס');
  });

  // Google cuts a description at ~155-160 characters and SEO scanners flag one
  // that is missing, under ~50 or over 160. Every page in the sitemap has one.
  it('every public page has a meta description Google shows in full', () => {
    const siteDir = path.join(__dirname, '..', '..', 'site');
    for (const { file } of seo.PUBLIC_PAGES) {
      const html = fs.readFileSync(path.join(siteDir, file), 'utf8');
      const m = html.match(/<meta\s+name="description"\s+content="([^"]*)"/);
      expect(m, `${file} has no meta description`).toBeTruthy();
      expect(m[1].length, `${file} description length`).toBeGreaterThanOrEqual(50);
      expect(m[1].length, `${file} description length`).toBeLessThanOrEqual(160);
    }
  });

  // The hero photos are the first images a crawler sees on the home page; an
  // empty alt left them unnamed for search and for image results.
  it('the home hero photos are described', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'index.html'), 'utf8');
    const heroes = html.match(/<img\s+class="hero-slide__bg"[^>]*>/g) || [];
    expect(heroes).toHaveLength(3);
    for (const tag of heroes) expect(tag).toMatch(/alt="[^"]{10,}"/);
  });

  it('inject puts the tags inside <head>', () => {
    const out = seo.inject('<html><head><title>x</title></head><body></body></html>', '<a1 />');
    expect(out.indexOf('<a1 />')).toBeLessThan(out.indexOf('</head>'));
    expect(seo.inject('<p>no head</p>', '<a1 />')).toBe('<p>no head</p>');
  });
});

describe('seo routes (app)', () => {
  let server;
  let base;

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-seo-'));
    for (const f of ['faq.js', 'settings.js', 'notify.js', 'seo.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    const app = require(path.join(serverDir, 'index.js'));
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

  const get = (p, host) => fetch(base + p, { headers: { 'x-forwarded-host': host } });

  it('robots.txt is open on production and closed on staging', async () => {
    const prod = await get('/robots.txt', PROD);
    expect(prod.status).toBe(200);
    expect(prod.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await prod.text()).toContain('Sitemap: https://dugri-israel.co.il/sitemap.xml');

    const stg = await get('/robots.txt', STAGING);
    expect(await stg.text()).toBe('User-agent: *\nDisallow: /\n');
  });

  it('sitemap.xml lists the storefront and the public designs', async () => {
    const r = await get('/sitemap.xml', PROD);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/xml/);
    const x = await r.text();
    expect(x).toContain('<urlset');
    expect(x).toContain('https://dugri-israel.co.il/products.html');
    expect(x).toMatch(/product\.html\?design=[a-z]/);
  });

  it('llms.txt answers with the brand brief', async () => {
    const r = await get('/llms.txt', PROD);
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain('# דוגרי (Dugri)');
    expect(t).toMatch(/מחיר: \d+ ₪/);
  });

  it('the home page on production carries canonical and JSON-LD with the live price', async () => {
    const r = await get('/?utm_source=ig', PROD);
    const html = await r.text();
    expect(r.headers.get('x-robots-tag')).toBe(null);
    expect(html).toContain('<link rel="canonical" href="https://dugri-israel.co.il/" />');
    const ld = JSON.parse(html.match(/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const pricing = await (await get('/api/pricing', PROD)).json();
    const product = ld['@graph'].find((n) => n['@type'] === 'Product');
    expect(product.offers.price).toBe(String(pricing.store.now));
    expect(ld['@graph'].some((n) => n['@type'] === 'FAQPage')).toBe(true);
  });

  it('staging pages are noindex, by header and by meta', async () => {
    const r = await get('/', STAGING);
    expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const html = await r.text();
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('application/ld+json');
  });

  it('a private page is noindex on production too', async () => {
    const html = await (await get('/pay-done.html', PROD)).text();
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).not.toContain('application/ld+json');
  });

  it('a vanity path (SPA fallback) canonicalises to the home page', async () => {
    const html = await (await get('/sale', PROD)).text();
    expect(html).toContain('<link rel="canonical" href="https://dugri-israel.co.il/" />');
  });
});
