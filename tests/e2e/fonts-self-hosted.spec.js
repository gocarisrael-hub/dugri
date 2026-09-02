import { test, expect } from '@playwright/test';

// The site self-hosts its fonts so in-app mobile browsers (Instagram/WhatsApp
// webviews) that block or throttle fonts.gstatic.com still render the brand
// faces. Assert at RUNTIME that no page reaches the Google Fonts CDN, the local
// stylesheet + woff2 load, and the display face actually renders.
const PAGES = ['/', '/options.html', '/collect.html', '/timer.html', '/pay-done.html'];

for (const url of PAGES) {
  test(`${url} loads fonts from the local origin, never Google Fonts`, async ({ page }) => {
    const external = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('fonts.googleapis.com') || u.includes('fonts.gstatic.com')) external.push(u);
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    expect(external, `hit Google Fonts: ${external.join(', ')}`).toHaveLength(0);

    // The self-hosted stylesheet is served and cached hard. Follow the URL the
    // PAGE loads rather than the bare name: since the asset tags are
    // content-hashed, `fonts.<hash>.css` is what every page asks for and what
    // carries the long cache, while the bare name deliberately revalidates so
    // an HTML copy cached before hashing shipped cannot be stuck on it for ever.
    // Asserting on the bare name tested a path the site no longer uses.
    const href = await page.evaluate(() => {
      const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) =>
        /\/assets\/fonts\/fonts\b/.test(l.getAttribute('href') || '')
      );
      return link ? link.getAttribute('href') : null;
    });
    expect(href, 'the page loads no self-hosted font stylesheet').toBeTruthy();
    const cssRes = await page.request.get(href);
    expect(cssRes.status()).toBe(200);
    expect(cssRes.headers()['cache-control']).toContain('max-age');

    // Heebo (the display face used on every page) actually loads.
    await page.evaluate(() => document.fonts.ready);
    const heeboLoaded = await page.evaluate(() =>
      [...document.fonts].some(
        (f) => f.family.replace(/['"]/g, '') === 'Heebo' && f.status === 'loaded'
      )
    );
    expect(heeboLoaded).toBe(true);
  });
}

test('a woff2 file is served with an immutable long-lived cache header', async ({ page }) => {
  // Derive a real woff2 path from the served stylesheet (filenames are
  // content-hashed, so never hardcode one).
  const css = await (await page.request.get('/assets/fonts/fonts.css')).text();
  const ref = css.match(/url\((\/assets\/fonts\/[^)]+\.woff2)\)/);
  expect(ref, 'no woff2 url in fonts.css').toBeTruthy();
  const res = await page.request.get(ref[1]);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('font/woff2');
  expect(res.headers()['cache-control']).toContain('31536000');
  expect(res.headers()['cache-control']).toContain('immutable');
});
