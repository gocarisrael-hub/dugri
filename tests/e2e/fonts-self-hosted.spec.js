import { test, expect } from '@playwright/test';

// The site self-hosts its fonts so in-app mobile browsers (Instagram/WhatsApp
// webviews) that block or throttle fonts.gstatic.com still render the brand
// faces. Assert at RUNTIME that no page reaches the Google Fonts CDN, the local
// stylesheet + woff2 load, and the display face actually renders.
const PAGES = ['/', '/options.html', '/collect.html', '/timer.html'];

for (const url of PAGES) {
  test(`${url} loads fonts from the local origin, never Google Fonts`, async ({ page }) => {
    const external = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('fonts.googleapis.com') || u.includes('fonts.gstatic.com')) external.push(u);
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    expect(external, `hit Google Fonts: ${external.join(', ')}`).toHaveLength(0);

    // The self-hosted stylesheet is served and cached hard.
    const cssRes = await page.request.get('/assets/fonts/fonts.css');
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

test('a woff2 file is served with a long-lived cache header', async ({ page }) => {
  await page.goto('/');
  const res = await page.request.get('/assets/fonts/heebo-300-hebrew.woff2');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('font/woff2');
  expect(res.headers()['cache-control']).toContain('31536000');
});
