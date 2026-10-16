import { test, expect } from '@playwright/test';

// The redesigned homepage (new.html), private until the owner switches / to it. What these pin:
// - the deck deals real cards, and the strip lists the live designs under their live names;
// - a tapped design is a real modal: focus moves in, Tab stays inside, Esc closes it and focus goes back to the design;
// - the price in it is the server's live price (and the old price only during a sale);
// - the menu sheet keeps focus inside and closes on Esc;
// - the business form: validation on the page, then each reply of POST /api/business-lead (ok, invalid, rate, failure);
// - nothing scrolls the page sideways.

// Built-in designs only, so the counts don't depend on which templates the test server holds.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/custom-designs', (route) => route.fulfill({ json: { designs: [] } }));
});

const realTiles = (page) => page.locator('#strip .dz:not([aria-hidden])');
const focusIsInside = (page, sel) =>
  page.evaluate((s) => !!document.activeElement && !!document.activeElement.closest(s), sel);

async function openDesign(page, id = 'bachelorette') {
  const tile = page.locator(`#strip .dz:not([aria-hidden])[data-k="${id}"]`);
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await expect(page.locator('#flood')).toHaveAttribute('open', '');
  return tile;
}

test.describe('the deck and the designs', () => {
  test('deals a real card on arrival and one more per tap', async ({ page }) => {
    await page.goto('/new.html');
    const cards = page.locator('#stage .card');
    await expect(cards).toHaveCount(1);
    await page.locator('#deck').click();
    await expect(cards).toHaveCount(2);
    for (const src of await page
      .locator('#stage .card img.f')
      .evaluateAll((els) => els.map((e) => e.getAttribute('src'))))
      expect(src).toMatch(/^assets\/home\/cards\/[a-z-]+-f\d\.webp$/);
    await expect(page.locator('#said')).toContainText('קלף מהעיצוב');
  });

  test('lists every public built-in design under its live name', async ({ page }) => {
    await page.route('**/api/design-names', (route) =>
      route.fulfill({ json: { names: { bachelorette: 'שם מהאדמין' }, fields: {} } })
    );
    await page.goto('/new.html');
    await expect(realTiles(page)).toHaveCount(6);
    await expect(
      page.locator('#strip .dz:not([aria-hidden])[data-k="bachelorette"] .nm')
    ).toHaveText('שם מהאדמין');
  });

  test('shows a public custom design the page has no art for, from its own template card', async ({
    page,
  }) => {
    await page.route('**/api/custom-designs', (route) =>
      route.fulfill({
        json: {
          designs: [
            {
              id: 'brand-new',
              name: 'עיצוב חדש',
              img: { front: '/api/template-image/brand-new/front' },
            },
          ],
        },
      })
    );
    await page.goto('/new.html');
    const tile = page.locator('#strip .dz:not([aria-hidden])[data-k="brand-new"]');
    await expect(tile.locator('.nm')).toHaveText('עיצוב חדש');
    await expect(tile.locator('img')).toHaveAttribute('src', '/api/template-image/brand-new/front');
  });
});

test.describe('a tapped design', () => {
  test('is a modal: focus moves in, Tab stays inside, Esc closes and focus returns', async ({
    page,
  }) => {
    await page.goto('/new.html');
    const tile = await openDesign(page);
    await expect(page.locator('#floodX')).toBeFocused();
    await expect(page.locator('#floodName')).toHaveText('פריז');
    await expect(page.locator('#floodOrder')).toHaveAttribute(
      'href',
      'product.html?design=bachelorette'
    );
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await focusIsInside(page, '#flood')).toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    expect(await focusIsInside(page, '#flood')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#flood')).not.toHaveAttribute('open', '');
    await expect(tile).toBeFocused();
  });

  test('closes with its ✕ and shows the board and both sides of the card', async ({ page }) => {
    await page.goto('/new.html');
    await openDesign(page, 'marriage');
    await expect(page.locator('#tableau .bd')).toHaveCount(1);
    await expect(page.locator('#tableau .fr')).toHaveAttribute(
      'src',
      'assets/home/cards/marriage-f1.webp'
    );
    await expect(page.locator('#tableau .bk')).toHaveAttribute(
      'src',
      'assets/home/cards/marriage-b1.webp'
    );
    await page.locator('#floodX').click();
    await expect(page.locator('#flood')).not.toHaveAttribute('open', '');
  });

  test('shows the live price from the test server', async ({ page, request }) => {
    const p = await (await request.get('/api/pricing')).json();
    await page.goto('/new.html');
    await openDesign(page);
    await expect(page.locator('#floodPrice')).toHaveText(new RegExp(`^${p.store.now} ₪`));
  });

  test('shows the old price only during a sale', async ({ page }) => {
    await page.route('**/api/pricing', (route) =>
      route.fulfill({
        json: {
          store: { now: 199, was: 239 },
          sale: { on: true, label: 'מבצע', banner: 'מבצע' },
          versions: {
            pdf: { enabled: false, price: 79 },
            pickup: { enabled: true, price: 199 },
            delivery: { enabled: true, price: 199 },
            custom: { enabled: false, price: 599 },
          },
          delivery_fee: 0,
        },
      })
    );
    await page.goto('/new.html');
    await openDesign(page);
    await expect(page.locator('#floodPrice')).toContainText('199 ₪');
    await expect(page.locator('#floodPrice s')).toHaveText('239 ₪');
  });
});

test.describe('a tapped design without a price', () => {
  test('never shows a typed-in price when the live one cannot be read', async ({ page }) => {
    await page.route('**/api/pricing', (route) => route.fulfill({ status: 500, body: 'down' }));
    await page.goto('/new.html');
    await openDesign(page);
    await expect(page.locator('#floodPrice')).toBeHidden();
    await expect(page.locator('#floodOrder')).toBeVisible();
  });
});

test.describe('the menu', () => {
  test('keeps focus inside and closes on Esc, back to the ≡', async ({ page }) => {
    await page.goto('/new.html');
    await page.locator('#menuBtn').click();
    await expect(page.locator('#menu')).toHaveAttribute('open', '');
    await expect(page.locator('#menuBtn')).toHaveAttribute('aria-expanded', 'true');
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      expect(await focusIsInside(page, '#menu')).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#menu')).not.toHaveAttribute('open', '');
    await expect(page.locator('#menuBtn')).toBeFocused();
  });

  test('a section link closes it and goes there', async ({ page }) => {
    await page.goto('/new.html');
    await page.locator('#menuBtn').click();
    await page.locator('#menu a[href="#biz"]').click();
    await expect(page.locator('#menu')).not.toHaveAttribute('open', '');
    await expect(page.locator('#h-biz')).toBeFocused();
  });
});

test.describe('the business form', () => {
  const fill = async (
    page,
    { name = 'דנה כהן', company = 'אלביט', phone = '054-123-4567' } = {}
  ) => {
    await page.locator('#lName').fill(name);
    await page.locator('#lCo').fill(company);
    await page.locator('#lTel').fill(phone);
  };
  const send = (page) => page.locator('#lead button[type=submit]').click();

  test('an empty send flags all three fields and focuses the first', async ({ page }) => {
    let posted = 0;
    await page.route('**/api/business-lead', (route) => {
      posted++;
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/new.html');
    await send(page);
    for (const id of ['lName', 'lCo', 'lTel'])
      await expect(page.locator('#' + id)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#lName')).toBeFocused();
    await expect(page.locator('#lTelE')).toHaveText('כתבו מספר טלפון');
    expect(posted).toBe(0);
  });

  test('a bad phone flags only the phone, with an example that reads left to right', async ({
    page,
  }) => {
    await page.goto('/new.html');
    await fill(page, { phone: '12345' });
    await send(page);
    await expect(page.locator('#lTel')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#lName')).toHaveAttribute('aria-invalid', 'false');
    await expect(page.locator('#lTelE')).toContainText('⁦054‑123‑4567⁩');
  });

  test('a good send posts the lead and shows the thank-you', async ({ page }) => {
    let body = null;
    await page.route('**/api/business-lead', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto('/new.html');
    await fill(page);
    await send(page);
    await expect(page.locator('#leadOk')).toBeVisible();
    await expect(page.locator('#leadOk')).toBeFocused();
    await expect(page.locator('#lead')).toBeHidden();
    expect(body).toEqual({
      name: 'דנה כהן',
      company: 'אלביט',
      phone: '054-123-4567',
      website: '',
      source: '/new.html',
    });
  });

  test("the server's field errors show inline", async ({ page }) => {
    await page.route('**/api/business-lead', (route) =>
      route.fulfill({ status: 400, json: { error: 'invalid', fields: { company: 'too_long' } } })
    );
    await page.goto('/new.html');
    await fill(page);
    await send(page);
    await expect(page.locator('#lCoE')).toHaveText('שם החברה ארוך מדי');
    await expect(page.locator('#lCo')).toBeFocused();
    await expect(page.locator('#leadOk')).toBeHidden();
  });

  for (const [status, json, text] of [
    [500, { error: 'not stored' }, 'משהו השתבש'],
    [429, { error: 'too many attempts' }, 'נסו שוב בעוד שעה'],
  ]) {
    test(`a ${status} keeps what was typed and offers WhatsApp`, async ({ page }) => {
      await page.route('**/api/business-lead', (route) => route.fulfill({ status, json }));
      await page.goto('/new.html');
      await fill(page);
      await send(page);
      await expect(page.locator('#leadErr')).toBeVisible();
      await expect(page.locator('#leadErrText')).toContainText(text);
      await expect(page.locator('#leadErr a')).toHaveAttribute('href', /^https:\/\/wa\.me\//);
      await expect(page.locator('#lName')).toHaveValue('דנה כהן');
      await expect(page.locator('#leadOk')).toBeHidden();
    });
  }

  test('a network failure is the same friendly error', async ({ page }) => {
    await page.route('**/api/business-lead', (route) => route.abort());
    await page.goto('/new.html');
    await fill(page);
    await send(page);
    await expect(page.locator('#leadErr')).toBeVisible();
  });
});

test.describe('the page', () => {
  for (const width of [360, 390, 1440]) {
    test(`never scrolls sideways at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/new.html');
      await page.waitForLoadState('load');
      const { sw, iw, sx } = await page.evaluate(async () => {
        const out = { sw: document.documentElement.scrollWidth, iw: window.innerWidth, sx: 0 };
        for (const y of [0, document.body.scrollHeight / 2, document.body.scrollHeight]) {
          window.scrollTo({ left: 600, top: y, behavior: 'instant' });
          await new Promise((r) => requestAnimationFrame(r));
          out.sx = Math.max(out.sx, window.scrollX);
        }
        return out;
      });
      expect(sw).toBe(iw);
      expect(sx).toBe(0);
    });
  }

  test('is private and loads no Google font', async ({ page }) => {
    const hosts = new Set();
    page.on('request', (r) => hosts.add(new URL(r.url()).host));
    const res = await page.goto('/new.html');
    await page.waitForLoadState('load');
    expect(await page.locator('meta[name="robots"]').first().getAttribute('content')).toMatch(
      /noindex/
    );
    expect(res.headers()['x-robots-tag'] || '').toMatch(/noindex/);
    expect([...hosts].some((h) => /fonts\.(googleapis|gstatic)\.com/.test(h))).toBe(false);
    expect(
      await page.evaluate(() => document.fonts.check('16px "M PLUS Rounded 1c"', 'שלום'))
    ).toBe(true);
  });

  test('under reduced motion on a wide screen the designs are a still grid with no marks over it', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/new.html');
    await expect(page.locator('#strip')).toHaveCSS('display', 'grid');
    const shown = await page
      .locator('#order .pl')
      .evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').length);
    expect(shown).toBe(0);
  });
});
