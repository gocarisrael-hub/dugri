import { test, expect } from '@playwright/test';

// Guards the durable fix for the 9 Aug store outage end-to-end, through the real
// Node server: the home page must publish an import map that points design-
// images.js at a content-hashed url, that hashed url must serve the real module
// immutably, and — the actual symptom that morning — the store must still render
// its product cards through that map.
test.describe('content-hashed modules (stale-JS / fresh-HTML guard)', () => {
  test('home injects a hashing import map and the store renders through it', async ({
    page,
    request,
  }) => {
    const html = await (await request.get('/')).text();

    const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    expect(mapMatch, 'import map present in served HTML').toBeTruthy();
    const map = JSON.parse(mapMatch[1]);
    const hashed = map.imports['/js/design-images.js'];
    expect(hashed, 'design-images.js is remapped to a hashed url').toMatch(
      /^\/js\/design-images\.[0-9a-f]{8}\.js$/
    );

    // The import map must precede the first module script or the browser starts
    // resolving imports before it exists.
    const mapIdx = html.indexOf('<script type="importmap"');
    const modIdx = html.search(/<script\b[^>]*type\s*=\s*["']?module/i);
    expect(mapIdx).toBeGreaterThanOrEqual(0);
    expect(modIdx).toBeGreaterThan(mapIdx);

    // The hashed asset serves the real module, immutably.
    const asset = await request.get(hashed);
    expect(asset.status()).toBe(200);
    expect(asset.headers()['cache-control']).toContain('immutable');
    expect(await asset.text()).toContain('export const SIZES');

    // A bare (unhashed) module url must NOT be immutable — it has to revalidate so
    // an edge can't pin it for a day against fresh HTML.
    const bare = await request.get('/js/design-images.js');
    expect(bare.headers()['cache-control'] || '').toContain('no-cache');

    // The 9 Aug symptom was zero product cards. Prove the module graph loads
    // through the import map by rendering the store rail.
    await page.goto('/');
    await page.waitForFunction(
      () => {
        const t = document.getElementById('productsTrack');
        return t && t.children.length > 0;
      },
      { timeout: 15000 }
    );
    const cards = await page.evaluate(
      () => document.getElementById('productsTrack').children.length
    );
    expect(cards).toBeGreaterThan(0);
  });
});
