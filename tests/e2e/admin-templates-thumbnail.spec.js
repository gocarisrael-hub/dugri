import { test, expect } from '@playwright/test';

// The asset checklist in admin-templates.html draws each SVG asset as an inline
// thumbnail. It cannot be an <img>: a de-duplicated card's background is a
// same-origin /api/template-asset/ reference, which an SVG image never loads. So
// the page parses the response as XML and runs an ALLOWLIST over the parsed tree
// before inserting it. These tests cover both sides of that: real art still draws,
// and a hostile SVG leaves nothing active and makes no request of its own. The
// admin page sends no CSP, so an external fetch from a thumbnail would reveal the
// owner's IP to whatever server a template names.
const KEY = 'dugri-admin';
const CARD = '.tpl-card[data-key="anniversary"]';

// Everything active or fetch-capable left in the thumbnails, read from the live DOM.
function activeInThumbs(page) {
  return page.evaluate((card) => {
    const bad = [];
    const DISALLOWED = new Set([
      'script',
      'foreignobject',
      'iframe',
      'frame',
      'frameset',
      'embed',
      'object',
      'a',
      'set',
      'animate',
      'animatetransform',
      'animatemotion',
      'style',
    ]);
    for (const thumb of document.querySelectorAll(card + ' .asset-thumb')) {
      for (const el of thumb.querySelectorAll('*')) {
        const tag = el.localName.toLowerCase();
        if (DISALLOWED.has(tag)) bad.push('<' + tag + '>');
        if (el.namespaceURI !== 'http://www.w3.org/2000/svg') bad.push('ns:' + el.namespaceURI);
        for (const a of el.attributes) {
          if (/^on/i.test(a.localName)) bad.push(tag + ' @' + a.name);
          if (a.localName === 'style') bad.push(tag + ' @style');
          const v = a.value.replace(/[\x00-\x20]+/g, '');
          if (/script:/i.test(v)) bad.push(tag + ' @' + a.name + '=' + a.value);
          if (/url\((?!['"]?#)/i.test(v)) bad.push(tag + ' @' + a.name + '=' + a.value);
        }
      }
    }
    return bad;
  }, CARD);
}

test('a real template thumbnail still renders through the allowlist', async ({ page }) => {
  await page.goto(`/admin-templates.html?key=${KEY}`);
  // filled-fronts, not clean-fronts: anniversary's clean fronts are pure vector, while
  // its filled fronts embed 16 data:image rasters — the richer thing to prove survives.
  const svg = page.locator(`${CARD} .asset[data-role="filled-fronts"] .asset-thumb svg`);
  await expect(svg).toHaveCount(1);
  await expect(svg).toBeVisible();
  const box = await svg.boundingBox();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);

  // The artwork itself survived: every data:image raster is still there, and the
  // url(#id) references real art draws through (clip paths, masks, filters) are kept.
  const art = await svg.evaluate((root) => ({
    images: Array.from(root.querySelectorAll('image')).map(
      (el) => el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    ),
    localUrls: Array.from(root.querySelectorAll('[clip-path],[mask],[filter]')).filter((el) =>
      ['clip-path', 'mask', 'filter'].some((n) => /^url\(#/.test(el.getAttribute(n) || ''))
    ).length,
  }));
  expect(art.images.length).toBeGreaterThan(0);
  for (const href of art.images) expect(href).toMatch(/^data:image\//);
  expect(art.localUrls).toBeGreaterThan(0);
  expect(await svg.locator('path').count()).toBeGreaterThan(0);
  expect(await activeInThumbs(page)).toEqual([]);
});

test('a hostile SVG leaves nothing active and fetches nothing', async ({ page, baseURL }) => {
  const EXT = 'https://example.invalid';
  const HOSTILE =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' +
    ` width="40" height="40" onload="window.__pwned='svg-onload'"` +
    ` style="background:url(${EXT}/root-bg.png)">` +
    `<style><script>window.__pwned="style-script"</script>rect{fill:url(${EXT}/css.svg#p)}</style>` +
    `<a href="javascript:window.__pwned='a-href'"><rect id="linked" width="10" height="10"/></a>` +
    `<set attributeName="href" to="javascript:window.__pwned='set-to'"/>` +
    `<animate attributeName="xlink:href" values="#a;javascript:window.__pwned='animate'"/>` +
    `<image width="1" height="1" xlink:href="javascript:window.__pwned='image-href'"` +
    ` onerror="window.__pwned='onerror'"/>` +
    `<image width="1" height="1" href="${EXT}/track.png"/>` +
    // Traversal out of /api/template-asset/ into an admin route.
    '<image width="1" height="1" href="/api/template-asset/../admin/templates?thumb-traversal=1"/>' +
    '<image width="1" height="1" xlink:href="/api/template-asset/%2e%2e/admin/templates?thumb-traversal=2"/>' +
    '<foreignObject width="9" height="9"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>' +
    `<g style="background:url(${EXT}/g-bg.png)" mask="url(${EXT}/mask.svg#m)"` +
    ` clip-path="url(${EXT}/clip.svg#c)" cursor="url(${EXT}/cursor.png), auto">` +
    `<rect width="20" height="20" fill="url(${EXT}/paint.svg#p)" stroke="url('${EXT}/stroke.svg#s')"/>` +
    '</g>' +
    `<rect id="keep" width="30" height="30" fill="#c00" onclick="window.__pwned='click'"/>` +
    '<use href="#keep"/>' +
    '</svg>';

  // Every request the page makes, recorded from before the first navigation.
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));

  // Stub the thumbnail response in the test: this exercises the page's own
  // allowlist, independent of the server sanitizer.
  await page.route('**/api/admin/templates/*/asset-svg/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: HOSTILE })
  );
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });

  await page.goto(`/admin-templates.html?key=${KEY}`);
  const thumbs = page.locator(`${CARD} .asset-thumb svg`);
  await expect(thumbs.first()).toBeVisible();

  // The benign parts still drew, so the thumbnail is not simply blank.
  await expect(page.locator(`${CARD} .asset-thumb #keep`).first()).toHaveCount(1);
  expect(await page.locator(`${CARD} .asset-thumb use`).count()).toBeGreaterThan(0);

  // Nothing active or fetch-capable survived, anywhere in the card's thumbnails.
  expect(await activeInThumbs(page)).toEqual([]);
  // The only kept href values are fragments (the <use>), never a URL.
  const hrefs = await page.evaluate((card) => {
    const out = [];
    for (const el of document.querySelectorAll(card + ' .asset-thumb *')) {
      for (const a of el.attributes) if (/^(href|src)$/i.test(a.localName)) out.push(a.value);
    }
    return out;
  }, CARD);
  for (const v of hrefs) expect(v).toMatch(/^#/);

  // And nothing ran: click the element that carried a handler, give any queued
  // event or resource load a moment, then check.
  await page.locator(`${CARD} .asset-thumb #keep`).first().click({ force: true });
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);

  // No request left the page's origin, and no request reached a path the thumbnail
  // named outside /api/template-asset/ (the traversal markers).
  const origin = new URL(baseURL).origin;
  expect(requests.filter((u) => new URL(u).origin !== origin)).toEqual([]);
  expect(requests.filter((u) => u.includes('thumb-traversal'))).toEqual([]);
});
