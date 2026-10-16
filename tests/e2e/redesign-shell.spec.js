import { test, expect } from '@playwright/test';
import { simulateRedesignGate } from './helpers/redesign.js';

// The redesign shell (css/redesign.css, js/redesign-shell.js) on a page not built in the redesign yet. What these pin:
// - the shared header stands in for the page's own header.hdr, which stays in the DOM hidden; the menu sheet opens, closes on Esc
//   and on ✕, marks the page it is on; the shared footer stands in for the page's own;
// - the bridge: a page that styles through tokens.css takes the redesign's ground and ink without an edit;
// - a page built in the redesign (new.html) is marked rd-native and left alone;
// - rd-kit.html shows every component and nothing scrolls sideways;
// - the menu still opens in a browser without <dialog> (Safari before 15.4).
// The server's gate is D's; here simulateRedesignGate does in the browser what it does, so these do not depend on its setting.

const sideways = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe('the shell on a page not built in the redesign', () => {
  test.beforeEach(async ({ page }) => {
    await simulateRedesignGate(page, /\/(pickup|new)\.html$/);
  });

  test('the shared header and footer stand in for the page’s own, and the page takes the new ground', async ({
    page,
  }) => {
    await page.goto('/pickup.html');
    await expect(page.locator('.rd-hdr')).toBeVisible();
    await expect(page.locator('header.hdr')).toHaveCount(1);
    await expect(page.locator('header.hdr')).toBeHidden();
    await expect(page.locator('.rd-ftr')).toBeVisible();
    await expect(page.locator('body > footer[data-rd-replaced]')).toBeHidden();
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
  test('shows every component, and its sheet and toast work', async ({ page }) => {
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
