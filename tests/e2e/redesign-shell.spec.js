import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// The redesign shell (css/redesign.css, js/redesign-shell.js) on a page not built in the redesign yet. What these pin:
// - the shared header stands in for the page's own header.hdr, which stays in the DOM hidden; the menu sheet opens, closes on Esc
//   and on ✕, marks the page it is on; the page keeps its own footer (the owner's contacts) unless it asks for the shared one;
// - the bridge: a page that styles through tokens.css takes the redesign's ground and ink without an edit;
// - a page built in the redesign (new.html) is marked rd-native and left alone;
// - rd-kit.html shows every component and nothing scrolls sideways;
// - the menu still opens in a browser without <dialog> (Safari before 15.4).
// Through the real gate (server/redesign-gate.js): ?rd=1 sets the preview cookie, as when the owner previews.

const sideways = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe('the shell on a page not built in the redesign', () => {
  test.beforeEach(async ({ page }) => {
    await previewRedesign(page);
  });

  test('?rd=1 turns the mode on through the gate: the class, the stylesheet and the shell, on every page after', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto('/pickup.html?rd=1');
    await expect(page.locator('html')).toHaveClass(/(^|\s)rd(\s|$)/);
    await expect(page.locator('head link[rel="stylesheet"][href*="/css/redesign."]')).toHaveCount(
      1
    );
    await expect(page.locator('head script[src*="/js/redesign-shell."]')).toHaveCount(1);
    await expect(page.locator('.rd-hdr')).toBeVisible();
    await page.goto('/products.html'); // the cookie carries the mode
    await expect(page.locator('.rd-hdr')).toBeVisible();
    await page.goto('/products.html?rd=0');
    await expect(page.locator('html')).not.toHaveClass(/(^|\s)rd(\s|$)/);
    await expect(page.locator('.rd-hdr')).toHaveCount(0);
    await expect(page.locator('header.hdr')).toBeVisible();
  });

  test('the shared header stands in for the page’s own, the page keeps its footer, and takes the new ground', async ({
    page,
  }) => {
    await page.goto('/pickup.html');
    await expect(page.locator('.rd-hdr')).toBeVisible();
    await expect(page.locator('header.hdr')).toHaveCount(1);
    await expect(page.locator('header.hdr')).toBeHidden();
    await expect(page.locator('.rd-ftr')).toHaveCount(0);
    await expect(page.locator('body > footer')).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 241, 222)');
    await expect(page.locator('body')).toHaveCSS('padding-top', '0px');
    expect(await sideways(page)).toBe(0);
  });

  test('the menu opens, marks this page, and closes on Esc and on ✕', async ({ page }) => {
    await page.goto('/pickup.html');
    await page.locator('#rdMenuBtn').click();
    await expect(page.locator('#rdMenu')).toBeVisible();
    await expect(page.locator('#rdMenuBtn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#rdMenu a[aria-current="page"]')).toHaveAttribute(
      'href',
      'pickup.html'
    );
    await page.keyboard.press('Escape');
    await expect(page.locator('#rdMenu')).toBeHidden();
    await expect(page.locator('#rdMenuBtn')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#rdMenuBtn').click();
    await page.locator('#rdMenuX').click();
    await expect(page.locator('#rdMenu')).toBeHidden();
  });

  test('a page built in the redesign is left alone', async ({ page }) => {
    await page.goto('/new.html');
    await expect(page.locator('html')).toHaveClass(/\brd-native\b/);
    await expect(page.locator('.rd-hdr, .rd-ftr, #rdMenu')).toHaveCount(0);
    await expect(page.locator('#menuBtn')).toBeVisible();
  });

  test('without <dialog> (Safari before 15.4) the menu still opens and closes', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const D = window.HTMLDialogElement.prototype;
      delete D.showModal;
      delete D.show;
      delete D.close;
    });
    await page.goto('/pickup.html');
    await expect(page.locator('#rdMenu')).toBeHidden();
    await page.locator('#rdMenuBtn').click();
    await expect(page.locator('#rdMenu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#rdMenu')).toBeHidden();
  });
});

test.describe('rd-kit.html', () => {
  test('an element the page hides with the hidden attribute stays hidden, whatever shell class it wears', async ({
    page,
  }) => {
    await page.goto('/rd-kit.html');
    await page.evaluate(() => {
      const main = document.querySelector('main');
      main.insertAdjacentHTML(
        'beforeend',
        '<div class="rd-box" id="h1" hidden>x</div><a class="rd-btn" id="h2" hidden>x</a>' +
          '<div class="rd-card" id="h3" hidden>x</div><h2 class="rd-title" id="h4" hidden>x</h2>' +
          '<button class="kit-go" id="h5" hidden>x</button>' // mapped to .rd-btn by --rd-as-btn
      );
    });
    await expect(page.locator('#h5')).toHaveClass(/\brd-btn\b/);
    for (const id of ['#h1', '#h2', '#h3', '#h4', '#h5'])
      await expect(page.locator(id)).toBeHidden();
    await page.locator('#h1').evaluate((e) => (e.hidden = false)); // and shows again when the page un-hides it
    await expect(page.locator('#h1')).toBeVisible();
  });

  test('an element the page hides with its own .hidden class stays hidden too, and shows when the class goes', async ({
    page,
  }) => {
    await page.goto('/rd-kit.html');
    await page.evaluate(() => {
      document
        .querySelector('main')
        .insertAdjacentHTML(
          'beforeend',
          '<a class="rd-btn hidden" id="c1">x</a><div class="rd-box hidden" id="c2">x</div>' +
            '<button class="kit-go hidden" id="c3">x</button>' +
            '<span class="rd-tag visually-hidden" id="c4">x</span><span class="rd-tag is-hidden" id="c5">x</span>'
        );
    });
    await expect(page.locator('#c3')).toHaveClass(/\brd-btn\b/);
    for (const id of ['#c1', '#c2', '#c3']) await expect(page.locator(id)).toBeHidden();
    for (const id of ['#c4', '#c5']) await expect(page.locator(id)).toBeVisible(); // only the exact class
    await page.locator('#c1').evaluate((e) => e.classList.remove('hidden'));
    await expect(page.locator('#c1')).toBeVisible();
  });

  test('shows every component, takes a page’s own element into one from CSS, and its sheet and toast work', async ({
    page,
  }) => {
    const res = await page.goto('/rd-kit.html');
    expect(res.headers()['x-robots-tag'] || '').toMatch(/noindex/);
    for (const sel of [
      '.rd-hdr',
      '.rd-ftr',
      '.rd-btn.secondary',
      '.rd-field.invalid .err',
      '.rd-select select',
      '.rd-check',
      '.rd-card.hot',
      '.rd-chip[aria-pressed="true"]',
      '.rd-price s',
      '.rd-steps li[aria-current="step"]',
      '.rd-empty',
    ])
      await expect(page.locator(sel).first(), sel).toBeVisible();
    await expect(page.locator('.rd-btn').first()).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('#kitMapped')).toHaveClass(/\brd-btn\b/); // --rd-as-btn: '.kit-go'
    await expect(page.locator('#kitMapped')).toHaveCSS('border-radius', '999px');
    await expect(page.locator('h1.rd-title')).toHaveCSS('text-shadow', /rgb\(255, 122, 169\)/);
    await expect(page.locator('.rd-hdr')).toBeVisible(); // --rd-header: top
    await expect(page.locator('.rd-card').first()).toHaveCSS(
      'box-shadow',
      /rgb\(0, 0, 0\) 6px 7px 0px/
    );
    expect(await sideways(page)).toBe(0);
    await page.locator('#kitSheetBtn').click();
    await expect(page.locator('#kitSheet')).toBeVisible();
    await page.locator('#kitSheetX').click();
    await expect(page.locator('#kitSheet')).toBeHidden();
    await page.locator('#kitToastBtn').click();
    await expect(page.locator('.rd-toast')).toHaveText('נשמר');
    await expect(page.locator('.rd-toast')).toBeVisible();
  });
});
