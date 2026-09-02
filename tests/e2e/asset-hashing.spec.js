import { test, expect } from '@playwright/test';

// EVERY SCRIPT AND STYLESHEET A PAGE LOADS MUST CARRY ITS CONTENT HASH.
//
// The unit tests pin server/asset-hashing.js in isolation; this pins the thing
// that actually broke twice — what a REAL page ships to a REAL browser.
//
// 9 Aug: a CDN edge paired a day-old design-images.js with a fresh index.html and
// the store rendered empty. The fix, an import map, closed that hole and only that
// hole: a map resolves `import` specifiers, so it never touched a `<script src>`,
// not even a module entry's, and had never heard of a stylesheet.
//
// 2 Sep: the same failure through the tags the map cannot reach. Cloudflare
// rewrote our `no-cache` on those stable names into max-age=86400 and the edge
// went on serving a 26-day-old tokens.css — one without the `.amt` bidi isolate,
// so prices on that copy read "₪ 239 199". Whether a shopper got the old file or
// the new one came down to their browser and their edge, which is why the site
// looked one way in Instagram's in-app browser and another in Safari.
//
// A unique filename is the only cache instruction an edge cannot override. This
// asserts we still mint one for every asset on every page — headers included, so
// a hashed url that quietly fell back to `no-cache` would fail too.

const PAGES = ['/', '/products.html', '/product.html', '/options.html', '/collect.html'];
const HASHED = /\.[0-9a-f]{8}\.(m?js|css)$/;

// Our own assets, the ones a stale copy can break the page with. Anything with a
// scheme (Google Fonts) or injected by the CDN itself is not ours to hash.
function isOurs(url) {
  const path = new URL(url, 'http://x').pathname;
  return /^\/(js|css|assets\/fonts)\/.+\.(m?js|css)$/.test(path);
}

for (const path of PAGES) {
  test(`every script and stylesheet on ${path} is content-hashed`, async ({ page }) => {
    await page.goto(path);
    const urls = await page.evaluate(() =>
      [...document.querySelectorAll('script[src], link[rel~="stylesheet"][href]')].map(
        (el) => el.src || el.href
      )
    );
    const ours = urls.filter(isOurs);
    expect(ours.length).toBeGreaterThan(0);
    for (const url of ours) expect(new URL(url).pathname).toMatch(HASHED);
  });
}

test('a hashed url is served immutable, and a bare one still revalidates', async ({
  page,
  request,
}) => {
  await page.goto('/');
  const href = await page.evaluate(
    () => document.querySelector('link[rel~="stylesheet"][href*="/css/"]').href
  );
  expect(new URL(href).pathname).toMatch(HASHED);

  const hashed = await request.get(href);
  expect(hashed.status()).toBe(200);
  expect(hashed.headers()['cache-control']).toContain('immutable');
  expect(hashed.headers()['content-type']).toContain('text/css');

  // The bare name still answers — an old bookmark, or an HTML copy cached before
  // this shipped — but only after asking us whether it has changed.
  const bare = await request.get(new URL(href).pathname.replace(/\.[0-9a-f]{8}\.css$/, '.css'));
  expect(bare.status()).toBe(200);
  expect(bare.headers()['cache-control']).toBe('no-cache');
});

test('an unknown hash 404s rather than serving some other build', async ({ request }) => {
  const res = await request.get('/css/tokens.deadbeef.css');
  expect(res.status()).toBe(404);
});
