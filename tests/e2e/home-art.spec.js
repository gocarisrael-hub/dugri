// @ts-check
// new.html with an uploaded design whose pictures the server has rendered (server/home-art.js; off in the E2E server,
// so /api/custom-designs is extended here with a `home` the way the deployed server sends it). What these pin:
// - the strip, the deck and the tapped view draw the rendered pictures, cut to the card's box, from their srcsets;
// - a rendered picture that will not load goes back to the design's template picture.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'site');
const REV = '0123456789abcdef';
const u = (role, w) => `/home-art/brand-new/${REV}/${role}-${w}.webp`;
const ladder = (role, ws) => ({
  src: u(role, ws[0]),
  srcset: ws.map((w) => `${u(role, w)} ${w}w`).join(', '),
});
const HOME = {
  front: ladder('front', [400, 800, 1200]),
  back: ladder('back', [400, 800, 1200]),
  board: ladder('board', [1200, 2000, 3000]),
};
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 299 416"><rect width="299" height="416" fill="#c0ffee"/></svg>';

async function withBrandNew(page, { artLoads }) {
  await page.route('**/api/custom-designs', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.designs.push({
      id: 'brand-new',
      name: 'חדש',
      theme: 'brand-new',
      custom: true,
      public: true,
      language: 'english',
      extra_fields: [],
      img: {
        front: '/api/template-image/brand-new/front',
        back: '/api/template-image/brand-new/back',
      },
      home: HOME,
    });
    await route.fulfill({ response: res, json: body });
  });
  await page.route('**/api/template-image/brand-new/*', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: SVG })
  );
  await page.route('**/home-art/brand-new/**', (route) => {
    if (!artLoads) return route.fulfill({ status: 404, body: 'Not found' });
    const board = route.request().url().includes('/board-');
    // a real print-shaped picture: a card a little taller than the page's 400:564 box
    const file = board
      ? 'assets/home/boards/birthday@2x.webp'
      : 'assets/home/cards/birthday-f1@2x.webp';
    return route.fulfill({
      contentType: 'image/webp',
      body: fs.readFileSync(path.join(SITE, file)),
    });
  });
}

const tile = (page) => page.locator('#strip .dz:not([aria-hidden])[data-k="brand-new"] img');

test('the strip and the tapped view draw an uploaded design’s rendered pictures, cut to the card', async ({
  page,
}) => {
  await withBrandNew(page, { artLoads: true });
  await page.goto('/new.html');
  await expect(tile(page)).toHaveAttribute('src', u('front', 400));
  await expect(tile(page)).toHaveAttribute('srcset', HOME.front.srcset);
  await tile(page).scrollIntoViewIfNeeded();
  await expect.poll(() => tile(page).evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
  expect(await tile(page).evaluate((i) => getComputedStyle(i).objectFit)).toBe('cover');

  await page.locator('#strip .dz:not([aria-hidden])[data-k="brand-new"]').click();
  await expect(page.locator('#flood')).toHaveAttribute('open', '');
  await expect(page.locator('#tableau .bd')).toHaveAttribute('srcset', HOME.board.srcset);
  await expect(page.locator('#tableau .fr')).toHaveAttribute('srcset', HOME.front.srcset);
  await expect(page.locator('#tableau .bk')).toHaveAttribute('srcset', HOME.back.srcset);
  await expect
    .poll(() =>
      page
        .locator('#tableau img')
        .evaluateAll((els) => els.map((i) => new URL(i.currentSrc).pathname.split('/')[1]))
    )
    .toEqual(['home-art', 'home-art', 'home-art']);
});

test('a rendered picture that will not load goes back to the design’s template picture', async ({
  page,
}) => {
  await withBrandNew(page, { artLoads: false });
  await page.goto('/new.html');
  await tile(page).scrollIntoViewIfNeeded();
  await expect(tile(page)).toHaveAttribute('src', '/api/template-image/brand-new/front');
  await expect(tile(page)).not.toHaveAttribute('srcset', /./);
  await expect(tile(page)).not.toHaveAttribute('data-fallback', /./); // used once: nothing loops
  await expect.poll(() => tile(page).evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);
});
