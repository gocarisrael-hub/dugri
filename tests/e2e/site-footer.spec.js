import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

// One footer in redesign mode: new.html's, on every page the shell gives it to (js/redesign-shell.js, the B block of
// css/redesign.css). The store, a design page and the terms show it in place of their own; pickup keeps its help above it; the
// word lists end with it (a buyer's collection does not: its checkout has a fixed pay bar). On a wide screen its three groups sit centred, as new.html's do, and the
// business section above new.html's footer is centred too. tests/unit/site-footer.test.js pins the markup and rules.

test.beforeEach(async ({ page }) => {
  await previewRedesign(page);
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

const sideways = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const PAGES = [
  ['/products.html', 'replace'],
  ['/product.html?design=bachelorette', 'replace'],
  ['/terms.html', 'replace'],
  ['/pickup.html', 'end'],
  ['/wordlists.html', 'end'],
];

for (const width of [390, 1440]) {
  for (const [path, how] of PAGES) {
    test(`${path} at ${width}: new.html's footer, every contact and link, ${how === 'replace' ? 'in place of its own' : 'at the end'}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      const ftr = page.locator('body > footer.rd-ftr');
      await expect(ftr).toHaveCount(1);
      await ftr.scrollIntoViewIfNeeded();
      await expect(ftr).toBeVisible();
      if (how === 'replace') await expect(page.locator('body > footer:not(.rd-ftr)')).toBeHidden();
      for (const sel of [
        '.ft-icon.wa',
        'a[href="tel:+972552441334"]',
        'a[href^="https://instagram.com/"]',
        'a[href^="mailto:"]',
      ])
        await expect(ftr.locator(sel).first()).toBeVisible();
      for (const id of [
        'footer-faq',
        'footer-pickup',
        'footer-wordlists',
        'footer-timer',
        'footer-terms',
      ])
        await expect(ftr.getByTestId(id)).toBeVisible();
      await expect(ftr).not.toContainText('לעסקים');
      // new.html's look: 46 px round icons, the top line, the round sans
      for (const icon of await ftr.locator('.ft-icon').all()) {
        const box = await icon.boundingBox();
        expect(Math.round(box.width)).toBe(46);
      }
      await expect(ftr).toHaveCSS('border-top-style', 'solid');
      expect(await ftr.evaluate((e) => getComputedStyle(e).fontFamily)).toContain(
        'M PLUS Rounded 1c'
      );
      if (width === 1440) {
        // the three groups as one, centred on the page
        const mid = await ftr.evaluate((f) => {
          const kids = [...f.children].map((c) => c.getBoundingClientRect());
          const l = Math.min(...kids.map((r) => r.left)),
            r = Math.max(...kids.map((r) => r.right));
          return (l + r) / 2 - document.documentElement.clientWidth / 2;
        });
        expect(Math.abs(mid)).toBeLessThan(24);
      }
      expect(await sideways(page)).toBe(0);
    });
  }
}

test("an owner's edit to new.html's footer shows on every page's footer", async ({ page }) => {
  await page.route('**/api/content?page=index.html', (route) =>
    route.fulfill({ json: { overrides: { 'index-footer-tag': { text: 'תייגו אותנו בסטורי' } } } })
  );
  for (const path of ['/new.html', '/products.html', '/pickup.html']) {
    await page.goto(path);
    await expect(page.locator('footer .ft-tag').last()).toHaveText('תייגו אותנו בסטורי');
  }
  // read-only away from new.html: no inline-edit key on the shell's footer
  await expect(page.locator('footer.rd-ftr [data-edit]')).toHaveCount(0);
});

test('new.html at 1440: the business section and the footer sit centred', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/new.html');
  const off = await page.evaluate(() => {
    const c = document.documentElement.clientWidth / 2;
    const mid = (r) => (r.left + r.right) / 2 - c;
    const biz = document.querySelector('.biz-in').getBoundingClientRect();
    const f = [...document.querySelector('footer.site-ft').children].map((x) =>
      x.getBoundingClientRect()
    );
    return {
      biz: mid(biz),
      bizHeading: mid(document.querySelector('#biz h2').getBoundingClientRect()),
      footer: (Math.min(...f.map((r) => r.left)) + Math.max(...f.map((r) => r.right))) / 2 - c,
    };
  });
  expect(Math.abs(off.biz)).toBeLessThan(4);
  expect(Math.abs(off.bizHeading)).toBeLessThan(4);
  expect(Math.abs(off.footer)).toBeLessThan(24);
});
