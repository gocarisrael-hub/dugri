import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';
import { openCheckout } from './helpers/checkout.js';
import { previewRedesign } from './helpers/redesign.js';

// The word-collection page's WhatsApp help (css/wa-help.css) floated in the bottom-right corner, and on the owner's
// unpaid page the share box's buttons, the card-pay pill and the order button each scrolled under it. js/wa-help.js now
// docks it INTO the pay bar while the bar shows, the way the wizard docks it into its own bar, so nothing can be under
// it at any scroll position. Where there is no bar (a contributor, a paid order) it floats as before.
// wa-help-clearance.spec.js pins its size and the wizard.

const PHONE = { width: 390, height: 800 };

async function controlsUnderHelp(page) {
  return page.evaluate(() => {
    const help = document.querySelector('[data-testid="wa-help"]');
    if (!help) return ['no help button on the page'];
    const hs = getComputedStyle(help);
    if (hs.visibility === 'hidden' || hs.pointerEvents === 'none') return [];
    const out = [];
    for (const el of document.querySelectorAll(
      'button, a, input, select, textarea, [role="button"]'
    )) {
      if (help.contains(el) || el.contains(help)) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none')
        continue;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
      const top = document.elementFromPoint(cx, cy);
      if (top && (top === help || help.contains(top)))
        out.push(el.dataset.testid || el.id || el.tagName);
    }
    return out;
  });
}

async function makeCollection(request) {
  const res = await request.post('/api/collections', {
    data: {
      honoree_name: 'שירה',
      email: 'help@example.com',
      phone: '0521234567',
      design: 'פריז',
      theme: 'bachelorette',
      extra_fields: {},
      buyer_name: 'דנה כהן',
    },
  });
  expect(res.ok()).toBe(true);
  const { id, owner_token: k } = await res.json();
  return { id, k };
}

// The e2e server has no card credentials; flip card_enabled on the state response so the pay pill shows.
async function enableCard(page) {
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const body = await (await route.fetch()).json();
    body.card_enabled = true;
    return route.fulfill({ json: body });
  });
}

// Is the help inside the pay bar's box? Literally inside, so the opaque bar is all that is under it.
async function helpInBar(page) {
  return page.evaluate(() => {
    const help = document.querySelector('[data-testid="wa-help"]');
    const bar = document.querySelector('#payBar');
    if (!help || !bar) return 'missing';
    const h = help.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    if (!h.width || !h.height) return 'not shown';
    const inside =
      h.left >= b.left - 1 &&
      h.right <= b.right + 1 &&
      h.top >= b.top - 1 &&
      h.bottom <= b.bottom + 1;
    return inside && bar.contains(help)
      ? 'in bar'
      : `outside: help ${Math.round(h.top)}-${Math.round(h.bottom)}`;
  });
}

for (const mode of ['off', 'on']) {
  test.describe(`redesign mode ${mode}`, () => {
    test.beforeEach(async ({ page }) => {
      await stubFeatures(page, ALL_ON);
      if (mode === 'on') await previewRedesign(page);
      await page.setViewportSize(PHONE);
    });

    test("the owner's unpaid page: the help rides in the pay bar at every scroll stop", async ({
      page,
      request,
    }) => {
      await enableCard(page);
      const { id, k } = await makeCollection(request);
      await page.goto(`/collect.html?c=${id}&k=${k}`);
      await expect(page.getByTestId('pay-bar')).toBeVisible();
      await expect.poll(() => helpInBar(page)).toBe('in bar');
      const total = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight
      );
      const off = [];
      for (let y = 0; y <= total + 40; y += 40) {
        await page.evaluate((v) => window.scrollTo(0, v), y);
        const where = await helpInBar(page);
        // In the bar, the bar is what is under it: content behind the opaque bar is the bar's (the page reserves
        // its height), not the help's.
        if (where !== 'in bar') off.push(`@${y}: ${where}`);
      }
      expect(off).toEqual([]);
      // Still the help: a WhatsApp link, and it does not cover the pay button it shares the bar with.
      await expect(page.getByTestId('wa-help')).toHaveAttribute('href', /wa\.me\//);
      const [h, go] = await Promise.all([
        page.getByTestId('wa-help').boundingBox(),
        page.getByTestId('pay-bar-btn').boundingBox(),
      ]);
      expect(h.x + h.width <= go.x || go.x + go.width <= h.x, 'help overlaps the pay button').toBe(
        true
      );
    });

    test('the checkout: the pay pill is never under the help', async ({ page, request }) => {
      await enableCard(page);
      const { id, k } = await makeCollection(request);
      await page.goto(`/collect.html?c=${id}&k=${k}`);
      await openCheckout(page);
      await expect(page.locator('#cardPayBtn')).toBeVisible();
      await expect.poll(() => helpInBar(page)).toBe('in bar');
      // The pill anywhere on screen above the bar: the docked help is not over it.
      await page.locator('#cardPayBtn').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      expect(await controlsUnderHelp(page)).toEqual([]);
    });

    test('when the bar goes, the help goes back to its corner and floats', async ({
      page,
      request,
    }) => {
      await enableCard(page);
      const { id, k } = await makeCollection(request);
      await page.goto(`/collect.html?c=${id}&k=${k}`);
      await expect.poll(() => helpInBar(page)).toBe('in bar');
      await page.evaluate(() => document.getElementById('payBar').classList.add('hidden'));
      const help = page.getByTestId('wa-help');
      await expect(help).toBeVisible();
      await expect(help).not.toHaveClass(/wa-help--docked/);
      expect(await help.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
    });

    test("a contributor's page has no bar: the help floats in its corner", async ({
      page,
      request,
    }) => {
      const { id } = await makeCollection(request);
      await page.goto(`/collect.html?c=${id}`);
      const help = page.getByTestId('wa-help');
      await expect(help).toBeVisible();
      await expect(help).not.toHaveClass(/wa-help--docked/);
      expect(await help.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
    });
  });
}
