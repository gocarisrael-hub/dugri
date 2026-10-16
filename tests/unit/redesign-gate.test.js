// @vitest-environment node
//
// REDESIGN MODE (server/redesign-gate.js, wired in server/index.js renderPage).
// The setting redesign.enabled flips the whole site; the rd=1 cookie (?rd=1 /
// ?rd=0) previews it in one browser and must never be indexed. With the setting
// off and no cookie, a page must come out byte-for-byte as it did before the gate.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const siteDir = path.join(__dirname, '..', '..', 'site');

const gate = require(path.join(serverDir, 'redesign-gate.js'));
const assetHashing = require(path.join(serverDir, 'asset-hashing.js'));

describe('the gate, as pure functions', () => {
  const req = (query = {}, cookie) => ({ query, headers: cookie ? { cookie } : {} });

  it('reads the rd cookie among others', () => {
    expect(gate.readCookie('a=1; rd=1; b=2')).toBe('1');
    expect(gate.readCookie('xrd=1')).toBe(null);
    expect(gate.readCookie(undefined)).toBe(null);
  });

  it('?rd=1 sets a session cookie and previews; ?rd=0 clears it', () => {
    const on = gate.forRequest(req({ rd: '1' }), { enabled: false });
    expect(on).toEqual({
      active: true,
      live: false,
      previewOnly: true,
      setCookie: 'rd=1; Path=/; SameSite=Lax',
    });
    // A session cookie: no lifetime of its own.
    expect(on.setCookie).not.toMatch(/Max-Age|Expires/i);
    const off = gate.forRequest(req({ rd: '0' }, 'rd=1'), { enabled: false });
    expect(off.active).toBe(false);
    expect(off.setCookie).toBe('rd=; Path=/; Max-Age=0; SameSite=Lax');
  });

  it('the cookie previews, the setting is live, and neither is anything else', () => {
    expect(gate.forRequest(req({}, 'rd=1'), { enabled: false })).toMatchObject({
      active: true,
      previewOnly: true,
      setCookie: null,
    });
    expect(gate.forRequest(req({}, 'rd=0'), { enabled: false }).active).toBe(false);
    expect(gate.forRequest(req({ rd: ['1', '1'] }), { enabled: false }).active).toBe(false);
    expect(gate.forRequest(req({}), { enabled: 'true' }).active).toBe(false);
    // On, a cookie changes nothing about indexability: it is the live site.
    expect(gate.forRequest(req({}, 'rd=1'), { enabled: true })).toMatchObject({
      active: true,
      live: true,
      previewOnly: false,
    });
  });

  it('knows the admin pages', () => {
    for (const f of ['admin.html', 'admin-features.html', '/x/site/admin-ads.html']) {
      expect(gate.isAdminFile(f)).toBe(true);
    }
    for (const f of ['index.html', 'new.html', 'administrator-guide.html', 'products.html']) {
      expect(gate.isAdminFile(f)).toBe(false);
    }
  });

  it('adds class rd to <html>, keeping attributes and an existing class', () => {
    expect(gate.addHtmlClass('<html lang="he" dir="rtl">')).toBe(
      '<html lang="he" dir="rtl" class="rd">'
    );
    expect(gate.addHtmlClass('<html class="a b" lang="he">')).toBe(
      '<html class="a b rd" lang="he">'
    );
    expect(gate.addHtmlClass('<html class="rd">')).toBe('<html class="rd">');
  });

  const page = [
    '<!doctype html>',
    '<html lang="he">',
    '  <head>',
    '    <link rel="stylesheet" href="/css/tokens.css" />',
    '    <link rel="canonical" href="https://x/" />',
    '  </head>',
    '  <body></body>',
    '</html>',
  ].join('\n');

  it('injects the stylesheet, then the script, as the last things in <head>', () => {
    const out = gate.apply(page, () => true);
    const head = out.slice(0, out.indexOf('</head>'));
    const css = head.indexOf('<link rel="stylesheet" href="/css/redesign.css" />');
    const js = head.indexOf('<script src="/js/redesign-shell.js" defer></script>');
    expect(css).toBeGreaterThan(head.indexOf('/css/tokens.css'));
    expect(css).toBeGreaterThan(head.indexOf('rel="canonical"'));
    expect(js).toBeGreaterThan(css);
    expect(
      head
        .slice(js)
        .replace(/<script[^>]*><\/script>/, '')
        .trim()
    ).toBe('');
    expect(out).toContain('<html lang="he" class="rd">');
  });

  it('names a page restyle after the page, and refuses anything else', () => {
    expect(gate.pageCssUrl('/x/site/how.html')).toBe('/css/rd/how.css');
    expect(gate.pageCssUrl('terms.html')).toBe('/css/rd/terms.css');
    expect(gate.pageCssUrl('new-faq.html')).toBe('/css/rd/new-faq.css');
    // chrome.css is the shared file, never a page's own.
    expect(gate.pageCssUrl('chrome.html')).toBe(null);
    expect(gate.pageCssUrl('../x.html')).toBe('/css/rd/x.css');
    expect(gate.pageCssUrl('a b.html')).toBe(null);
    expect(gate.pageCssUrl(undefined)).toBe(null);
  });

  it('links the shell, the chrome, the page, then the script', () => {
    const out = gate.apply(page, () => true, '/x/site/how.html');
    const order = [
      '<link rel="stylesheet" href="/css/redesign.css" />',
      '<link rel="stylesheet" href="/css/rd/chrome.css" />',
      '<link rel="stylesheet" href="/css/rd/how.css" />',
      '<script src="/js/redesign-shell.js" defer></script>',
    ].map((t) => out.indexOf(t));
    expect(order.every((i) => i > out.indexOf('rel="canonical"'))).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order[3]).toBeLessThan(out.indexOf('</head>'));
  });

  it("links only the restyles that exist, and never another page's", () => {
    const has = (u) => u === '/css/rd/terms.css';
    const terms = gate.apply(page, has, 'terms.html');
    expect(terms).toContain('/css/rd/terms.css');
    expect(terms).not.toContain('chrome.css');
    expect(gate.apply(page, has, 'how.html')).not.toContain('/css/rd/');
  });

  it('links a file only once it exists', () => {
    const none = gate.apply(page, () => false);
    expect(none).toBe(page.replace('<html lang="he">', '<html lang="he" class="rd">'));
    const cssOnly = gate.apply(page, (u) => u === gate.CSS_URL);
    expect(cssOnly).toContain('/css/redesign.css');
    expect(cssOnly).not.toContain('redesign-shell.js');
  });

  // Through the same path every page takes: the tag rewrite gives both tags
  // their content-hashed names, so a CDN can never pin a stale redesign.css.
  it('the injected tags come out with hashed urls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-rd-site-'));
    fs.mkdirSync(path.join(dir, 'css'));
    fs.mkdirSync(path.join(dir, 'js'));
    fs.writeFileSync(path.join(dir, 'css', 'redesign.css'), 'html.rd{color:red}');
    fs.writeFileSync(path.join(dir, 'js', 'redesign-shell.js'), 'void 0;');
    fs.mkdirSync(path.join(dir, 'css', 'rd'));
    fs.writeFileSync(path.join(dir, 'css', 'rd', 'chrome.css'), 'html.rd body{margin:0}');
    fs.writeFileSync(path.join(dir, 'css', 'rd', 'how.css'), 'html.rd h1{margin:0}');
    const assets = assetHashing.build(dir);
    const out = assets.rewriteTags(
      assets.inject(gate.apply(page, (u) => assets.forward.has(u), 'how.html'))
    );
    expect(out).toMatch(/<link rel="stylesheet" href="\/css\/rd\/chrome\.[0-9a-f]{8}\.css" \/>/);
    expect(out).toMatch(/<link rel="stylesheet" href="\/css\/rd\/how\.[0-9a-f]{8}\.css" \/>/);
    expect(out).toMatch(/<link rel="stylesheet" href="\/css\/redesign\.[0-9a-f]{8}\.css" \/>/);
    expect(out).toMatch(/<script src="\/js\/redesign-shell\.[0-9a-f]{8}\.js" defer><\/script>/);
  });

  it('drops only the robots meta', () => {
    const html =
      '<head>\n    <meta charset="UTF-8" />\n    <meta name="robots" content="noindex, nofollow" />\n    <title>x</title>\n</head>';
    expect(gate.dropRobotsMeta(html)).toBe(
      '<head>\n    <meta charset="UTF-8" />\n    <title>x</title>\n</head>'
    );
  });

  it('swaps only the site root index.html', () => {
    expect(gate.homeSwap(path.join(siteDir, 'index.html'), siteDir, fs)).toBe(
      path.join(siteDir, 'new.html')
    );
    expect(gate.homeSwap(path.join(siteDir, 'products.html'), siteDir, fs)).toBe(null);
    expect(gate.homeSwap(path.join(siteDir, 'sub', 'index.html'), siteDir, fs)).toBe(null);
    const noNew = { existsSync: () => false };
    expect(gate.homeSwap(path.join(siteDir, 'index.html'), siteDir, noNew)).toBe(null);
  });
});

describe('the gate, served', () => {
  let app;
  let server;
  let port;
  let settings;
  let seo;
  let db;

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-redesign-gate-'));
    // The test host IS the production host, so a page would be indexable unless
    // the gate makes it otherwise: a noindex seen here comes from the gate.
    process.env.SEO_HOST = '127.0.0.1';
    for (const f of ['db.js', 'settings.js', 'seo.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    settings = require(path.join(serverDir, 'settings.js'));
    db = require(path.join(serverDir, 'db.js'));
    seo = require(path.join(serverDir, 'seo.js'));
    app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) server.close();
    delete process.env.SEO_HOST;
  });

  afterEach(() => settings.reset('redesign', 'enabled'));

  function get(urlPath, cookie) {
    return new Promise((resolve, reject) => {
      const r = http.get(
        { host: '127.0.0.1', port, path: urlPath, headers: cookie ? { Cookie: cookie } : {} },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }
      );
      r.on('error', reject);
    });
  }
  const isRd = (body) => /<html\b[^>]*\bclass="rd"/.test(body);
  const servesNewHome = (body) => body.includes('<meta name="dugri:page" content="new.html" />');
  const robotsMeta = (body) => (body.match(/<meta\s+name="robots"[^>]*>/gi) || []).length;
  const canonical = (body) => {
    const m = body.match(/<link rel="canonical" href="([^"]+)"/);
    return m ? m[1] : null;
  };

  // The pre-gate pipeline, rebuilt from its parts: the gate must change nothing
  // while it is off. The pixel is not set in a fresh DATA_DIR, so it adds nothing.
  function preGate(file, { fallback = false } = {}) {
    const assets = assetHashing.build(siteDir);
    const raw = fs.readFileSync(path.join(siteDir, file), 'utf8');
    const tags = seo.headTags({
      file,
      query: {},
      fallback,
      indexable: true,
      html: raw,
      // The same live sources index.js's seoLive() reads.
      price: db.effectivePricing().store.now,
      faq: require(path.join(serverDir, 'faq.js')).publicFaq(settings.get('faq', 'list')),
    });
    return assets.rewriteTags(assets.inject(seo.inject(raw, tags)));
  }

  it('off, no cookie: pages are byte-identical to before, and no cookie is set', async () => {
    for (const [url, file] of [
      ['/', 'index.html'],
      ['/products.html', 'products.html'],
      ['/new.html', 'new.html'],
    ]) {
      const r = await get(url);
      expect(r.status).toBe(200);
      expect(r.body).toBe(preGate(file));
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect((await get('/some-ad-path')).body).toBe(preGate('index.html', { fallback: true }));
  });

  it('?rd=1 previews: a session cookie, the redesign, new.html at "/", noindex', async () => {
    const r = await get('/?rd=1');
    expect(r.headers['set-cookie']).toEqual(['rd=1; Path=/; SameSite=Lax']);
    expect(isRd(r.body)).toBe(true);
    expect(servesNewHome(r.body)).toBe(true);
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(robotsMeta(r.body)).toBe(1);
    expect(canonical(r.body)).toBe(null);
  });

  it('the cookie previews every page, never indexable', async () => {
    const r = await get('/products.html', 'rd=1');
    expect(isRd(r.body)).toBe(true);
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(r.body).toContain('<meta name="robots" content="noindex" />');
    // Without it, the same page is the indexable original.
    const plain = await get('/products.html');
    expect(isRd(plain.body)).toBe(false);
    expect(plain.headers['x-robots-tag']).toBeUndefined();
    expect(canonical(plain.body)).toBe('https://127.0.0.1/products.html');
  });

  it('?rd=0 clears the cookie and serves the page as it is', async () => {
    const r = await get('/?rd=0', 'rd=1');
    expect(r.headers['set-cookie']).toEqual(['rd=; Path=/; Max-Age=0; SameSite=Lax']);
    expect(isRd(r.body)).toBe(false);
    expect(servesNewHome(r.body)).toBe(false);
  });

  it("one browser's preview is not anyone else's", async () => {
    await get('/?rd=1');
    const other = await get('/');
    expect(isRd(other.body)).toBe(false);
    expect(servesNewHome(other.body)).toBe(false);
  });

  it('the setting on: the redesign for everyone, and "/" is the indexable new home', async () => {
    settings.set('redesign', 'enabled', true);
    const r = await get('/');
    expect(isRd(r.body)).toBe(true);
    expect(servesNewHome(r.body)).toBe(true);
    expect(robotsMeta(r.body)).toBe(0);
    expect(r.headers['x-robots-tag']).toBeUndefined();
    expect(canonical(r.body)).toBe('https://127.0.0.1/');
    expect(r.body).toContain('application/ld+json');
    // The url stays "/": served, not redirected.
    expect(r.status).toBe(200);
  });

  it('on, ?rd=1 keeps the canonical clean', async () => {
    settings.set('redesign', 'enabled', true);
    const r = await get('/?rd=1&utm_source=x');
    expect(canonical(r.body)).toBe('https://127.0.0.1/');
    expect(robotsMeta(r.body)).toBe(0);
  });

  it('on, /new.html itself stays noindex', async () => {
    settings.set('redesign', 'enabled', true);
    const r = await get('/new.html');
    expect(isRd(r.body)).toBe(true);
    expect(r.body).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(canonical(r.body)).toBe(null);
  });

  it('on, an ad vanity path shows the same new home as "/"', async () => {
    settings.set('redesign', 'enabled', true);
    const r = await get('/sale');
    expect(servesNewHome(r.body)).toBe(true);
    expect(canonical(r.body)).toBe('https://127.0.0.1/');
  });

  it('an admin page is untouched, setting on and cookie set', async () => {
    const before = (await get('/admin-features.html')).body;
    settings.set('redesign', 'enabled', true);
    const after = await get('/admin-features.html', 'rd=1');
    expect(after.body).toBe(before);
    expect(isRd(after.body)).toBe(false);
  });

  it('HTML stays no-cache in every mode', async () => {
    const off = await get('/');
    const preview = await get('/products.html', 'rd=1');
    settings.set('redesign', 'enabled', true);
    const on = await get('/');
    for (const r of [off, preview, on]) {
      expect(r.headers['cache-control']).toBe('no-cache');
      expect(r.headers['content-type']).toMatch(/^text\/html/);
    }
  });
});
