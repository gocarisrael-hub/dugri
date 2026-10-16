import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { previewRedesign } from './helpers/redesign.js';

// D's pages in redesign mode: how, timer, terms, unsubscribe, and the shared chrome (the consent chip). Each page is restyled
// only by its own site/css/rd/<page>.css, linked by the gate in the mode (docs/redesign-mode.md); the HTML and the scripts are
// the ones the live site runs. So every test here does two things: it checks the page took the redesign (the kit's classes,
// the heading face, no sideways scroll), and it runs the page's own flow again, because a restyle that hides or covers a
// control breaks the page without failing any of its existing specs, which run out of the mode.

test.beforeEach(({ page }) => previewRedesign(page));

const noSidewaysScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const fontOf = (loc) => loc.evaluate((el) => getComputedStyle(el).fontFamily);
const linked = (page, name) =>
  page.locator(`link[rel="stylesheet"][href^="/css/rd/${name}."]`).count();

test('how: the shell header and footer, kit titles and arrow buttons, the order links unchanged', async ({
  page,
}) => {
  await page.goto('/how.html');
  expect(await linked(page, 'how')).toBe(1);
  expect(await linked(page, 'chrome')).toBe(1);
  await expect(page.locator('header.rd-hdr')).toBeVisible();
  await expect(page.locator('body > nav.nav')).toBeHidden();
  // The page keeps its own footer, with its contacts, in the shared old-footer look (chrome.css).
  await expect(page.locator('footer.rd-ftr')).toHaveCount(0);
  await expect(page.locator('body > footer .foot-icon.fi-wa')).toBeVisible();

  const h1 = page.locator('#top h1');
  await expect(h1).toHaveClass(/\brd-title\b/);
  expect(await fontOf(h1)).toContain('Gveret Levin');
  // Body text in the round sans, never the heading face (the Two Faces Rule).
  expect(await fontOf(page.locator('.step h3').first())).toContain('M PLUS Rounded 1c');

  const cta = page.locator('#top .hero-cta .btn').first();
  await expect(cta).toHaveClass(/\brd-btn\b/);
  await expect(cta).toHaveClass(/\barrow\b/);
  await expect(cta).toHaveAttribute('href', 'products.html');
  // The kit's arrow, not the page's old shine: a static, unskewed mask.
  const arrow = await cta.evaluate((el) => {
    const s = getComputedStyle(el, '::after');
    return { position: s.position, transform: s.transform, mask: s.webkitMaskImage || s.maskImage };
  });
  expect(arrow.position).toBe('static');
  expect(arrow.transform).toBe('none');
  expect(arrow.mask).toContain('svg');

  // Content is simply there: no scroll-triggered entrance leaves a box invisible.
  for (const el of await page.locator('.step, .item').all()) {
    expect(await el.evaluate((n) => getComputedStyle(n).opacity)).toBe('1');
  }
  expect(await noSidewaysScroll(page)).toBe(0);
});

test('chrome: the consent chip is a paper pill with an ink line, and still closes', async ({
  page,
}) => {
  await page.goto('/how.html');
  const chip = page.locator('#cookieNotice');
  await expect(chip).toBeVisible();
  const look = await chip.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, border: s.borderTopColor, shadow: s.boxShadow };
  });
  expect(look.bg).toBe('rgb(255, 255, 255)');
  expect(look.border).toBe('rgb(0, 0, 0)');
  expect(look.shadow).toContain('3px 3px 0px');
  await chip.getByRole('button', { name: 'סגירה' }).click();
  await expect(chip).toHaveCount(0);
});

// The old site footer, restyled once in chrome.css for every page that carries it: the cream ground instead of black, ink
// text, and every owner-editable contact still there and reachable.
// (index.html is not here: in the mode it serves new.html, which has its own footer.)
for (const path of ['/products.html', '/product.html', '/how.html', '/terms.html']) {
  test(`chrome: the old footer on ${path} is on the ground, with every contact`, async ({
    page,
  }) => {
    await page.goto(path);
    const footer = page.locator('body > footer:not(.rd-ftr)');
    await footer.scrollIntoViewIfNeeded();
    const look = await footer.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, color: s.color };
    });
    expect(look.bg).toBe('rgba(0, 0, 0, 0)');
    expect(look.color).toBe('rgb(0, 0, 0)');
    for (const sel of ['.fi-wa', 'a[href^="tel:"]', '.fi-ig', 'a[href^="mailto:"]']) {
      await expect(footer.locator(sel).first()).toBeVisible();
    }
    for (const icon of await footer.locator('.foot-icon').all()) {
      const box = await icon.boundingBox();
      expect(box.width).toBeLessThanOrEqual(48);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    if (path !== '/how.html' && path !== '/terms.html') {
      await expect(footer.getByTestId('footer-b2b')).toBeVisible();
    }
    expect(await noSidewaysScroll(page)).toBe(0);
  });
}

test("chrome: pickup's short footer takes the same look, its contacts kept", async ({ page }) => {
  await page.goto('/pickup.html');
  const footer = page.locator('body > footer:not(.rd-ftr)');
  const bg = await footer.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgba(0, 0, 0, 0)');
  await expect(footer.locator('a[href^="https://wa.me/"]')).toBeVisible();
  await expect(footer.locator('a[href^="mailto:"]')).toBeVisible();
  await expect(footer.locator('a.back')).toBeVisible();
});

test('timer: a disc, no site header, and start / reset still work', async ({ page }) => {
  await page.goto('/timer.html');
  expect(await linked(page, 'timer')).toBe(1);
  await expect(page.locator('header.rd-hdr')).toHaveCount(0);
  const count = page.getByTestId('timer-count');
  await expect(count).toHaveText('60');
  expect(await fontOf(count)).toContain('M PLUS Rounded 1c');

  const toggle = page.getByTestId('timer-toggle');
  const reset = page.getByTestId('timer-reset');
  await expect(toggle).toHaveClass(/\brd-btn\b/);
  // The kit's pill must not outrank the page's own .hidden.
  await expect(reset).toBeHidden();
  await toggle.click();
  await expect
    .poll(async () => Number(await count.innerText()), { timeout: 5000 })
    .toBeLessThan(60);
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(count).toHaveText('60');
  await expect(reset).toBeHidden();
  expect(await noSidewaysScroll(page)).toBe(0);
});

test('terms: its own plain bar (no order button), the contents still jump, the footer is contained', async ({
  page,
}) => {
  await page.goto('/terms.html');
  expect(await linked(page, 'terms')).toBe(1);
  await expect(page.locator('header.rd-hdr')).toHaveCount(0);
  await expect(page.locator('.bar')).toBeVisible();
  await expect(page.locator('header.doc h1')).toHaveClass(/\brd-title\b/);
  await expect(page.locator('nav.toc')).toHaveClass(/\brd-box\b/);

  await page.locator('nav.toc a[href="#sec-11"]').click();
  await expect(page).toHaveURL(/#sec-11$/);
  await expect(page.locator('#sec-11 h2')).toBeInViewport();

  expect(await noSidewaysScroll(page)).toBe(0);
});

test('unsubscribe: a box, kit buttons as the script draws them, and stop / back still work', async ({
  page,
}) => {
  const SECRET = 'e2e-unsubscribe-secret'; // playwright.config.js
  const email = `rd-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const token = crypto.createHmac('sha256', SECRET).update(email).digest('hex').slice(0, 32);
  await page.goto(`/unsubscribe.html?e=${encodeURIComponent(email)}&t=${token}`);
  expect(await linked(page, 'unsubscribe')).toBe(1);
  await expect(page.locator('#card')).toHaveClass(/\brd-box\b/);
  await expect(page.locator('#title')).toHaveClass(/\brd-title\b/);

  const stop = page.locator('#stop');
  await expect(stop).toHaveClass(/\brd-btn\b/);
  await stop.click();
  await expect(page.locator('#title')).toHaveText('הפסקנו לשלוח לך מיילים');
  const undo = page.locator('#undo');
  await expect(undo).toHaveClass(/\brd-btn\b/);
  await expect(undo).toHaveClass(/\bghost\b/);
  await undo.click();
  await expect(page.locator('#title')).toHaveText('חזרת לרשימה');
  expect(await noSidewaysScroll(page)).toBe(0);
});
