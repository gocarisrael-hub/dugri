import { test, expect } from '@playwright/test';
import { previewRedesign } from './helpers/redesign.js';

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
  test('its order button goes straight to the wizard’s title step on that design, and is counted', async ({
    page,
  }) => {
    await page.goto('/new.html');
    await openDesign(page, 'marriage');
    // the analytics queue is gone once the page navigates: keep a copy of it as the click finishes bubbling
    await page.evaluate(() =>
      window.addEventListener('click', () =>
        sessionStorage.setItem('dl', JSON.stringify(window.dataLayer.map((a) => Array.from(a))))
      )
    );
    await page.locator('#floodOrder').click();
    await expect(page).toHaveURL(/\/options\.html\?design=marriage&step=2$/);
    await expect(page.locator('#nameStepTitle')).toBeVisible();
    await expect(page.locator('.design[data-design-id="marriage"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const dl = JSON.parse(await page.evaluate(() => sessionStorage.getItem('dl')));
    expect(dl).toContainEqual([
      'event',
      'order_started',
      expect.objectContaining({ cta: 'design_view', design: 'marriage' }),
    ]);
  });

  test('is a modal: focus moves in, Tab stays inside, Esc closes and focus returns', async ({
    page,
  }) => {
    await page.goto('/new.html');
    const tile = await openDesign(page);
    await expect(page.locator('#floodX')).toBeFocused();
    await expect(page.locator('#floodName')).toHaveText('פריז');
    await expect(page.locator('#floodOrder')).toHaveAttribute(
      'href',
      'options.html?design=bachelorette&step=2'
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

test.describe('the cookie chip', () => {
  test('never covers the WhatsApp button, and the button comes back down when it goes', async ({
    page,
  }) => {
    await page.goto('/new.html'); // a fresh browser: the one-time chip shows
    const chip = page.locator('#cookieNotice');
    await expect(chip).toBeVisible();
    const fab = page.locator('#waFab');
    // wait for the lift's 0.2 s glide to settle
    await expect
      .poll(async () => (await fab.boundingBox()).y)
      .toBeLessThan((await chip.boundingBox()).y - 8);
    const hit = await page.evaluate(() => {
      const at = (el) => {
        const r = el.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      };
      const fab = document.getElementById('waFab'),
        close = document.querySelector('#cookieNotice button');
      return { fab: !!at(fab) && !!at(fab).closest('#waFab'), close: at(close) === close };
    });
    expect(hit).toEqual({ fab: true, close: true });
    const lifted = (await fab.boundingBox()).y;
    await page.locator('#cookieNotice button').click();
    await expect(chip).toHaveCount(0);
    await expect.poll(async () => (await fab.boundingBox()).y).toBeGreaterThan(lifted + 20);
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

test.describe('the reviews', () => {
  test('every review is a white card with a hard shadow, its tag on a line above the quote', async ({
    page,
  }) => {
    await page.goto('/new.html');
    const cards = await page.locator('#track > button').evaluateAll((els) =>
      els.map((e) => {
        const cs = getComputedStyle(e);
        const tag = e.querySelector('.tag').getBoundingClientRect();
        const ttl = e.querySelector('.ttl').getBoundingClientRect();
        return { bg: cs.backgroundColor, shadow: cs.boxShadow, stacked: tag.bottom <= ttl.top + 1 };
      })
    );
    expect(cards.length).toBeGreaterThanOrEqual(8);
    for (const c of cards) {
      expect(['rgb(255, 255, 255)', 'rgb(255, 233, 240)']).toContain(c.bg); // paper, or the pink "hot" card
      expect(c.shadow).not.toBe('none');
      expect(c.stacked).toBe(true);
    }
  });
});

// The owner's Mac runs an old Safari: no WebP (so macOS 10.15 or older), no <dialog> before 15.4, no replaceChildren before 14.
// Here a current engine is made to lack the same: every WebP comes back undecodable and the dialog API is removed.
test.describe('in an old Safari', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const D = window.HTMLDialogElement.prototype;
      delete D.showModal;
      delete D.show;
      delete D.close;
      delete window.Element.prototype.replaceChildren;
    });
    await page.route(/\.webp$/, (route) =>
      route.fulfill({ status: 200, contentType: 'image/webp', body: 'not a webp' })
    );
  });

  test('every picture shows, from its JPEG or PNG twin', async ({ page }) => {
    await page.goto('/new.html');
    // the logos load lazily, off screen: ask for them now, so each one has had its try
    await page
      .locator('#track img')
      .evaluateAll((els) => els.forEach((i) => (i.loading = 'eager')));
    await page.waitForLoadState('networkidle');
    const imgs = await page
      .locator('.deck img, #strip .dz:not([aria-hidden]) img, #track img')
      .evaluateAll((els) => els.map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth })));
    expect(imgs.length).toBeGreaterThan(10);
    for (const i of imgs) {
      expect(i.w, i.src).toBeGreaterThan(0);
      expect(i.src).not.toMatch(/\.webp$/);
    }
    await openDesign(page);
    await page.waitForLoadState('networkidle');
    // the board is the biggest picture: give each one time to fail, swap and arrive
    await expect
      .poll(() =>
        page
          .locator('#flood img')
          .evaluateAll((els) =>
            els.map((i) => `${(i.currentSrc || i.src).split('/').pop()} ${i.naturalWidth > 0}`)
          )
      )
      .toEqual([
        expect.stringMatching(/^bachelorette\.jpg true$/),
        // on a 2x/3x screen the cards fall back to their sharp JPEG twins
        expect.stringMatching(/^bachelorette-f1(@2x)?\.jpg true$/),
        expect.stringMatching(/^bachelorette-b1(@2x)?\.jpg true$/),
      ]);
  });

  test('a design, a review and the menu open and close; nothing shows while closed', async ({
    page,
  }) => {
    await page.goto('/new.html');
    expect(
      await page.evaluate(() => document.documentElement.classList.contains('no-dialog'))
    ).toBe(true);
    for (const id of ['#sheet', '#flood', '#menu']) await expect(page.locator(id)).toBeHidden();
    await openDesign(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#flood')).toBeHidden();
    await page
      .locator('#track > button.rc')
      .nth(2)
      .evaluate((b) => b.click());
    await expect(page.locator('#sheet')).toBeVisible();
    await page.locator('#sheetX').click();
    await expect(page.locator('#sheet')).toBeHidden();
    await expect(page.locator('.dlg-bd')).toHaveCount(0);
    // the dimmed page closes it too (a synthetic mouse in WebKit under load can lose a real click there; tests/unit/home-legacy.test.js
    // pins the backdrop's own wiring)
    await page
      .locator('#track > button.rc')
      .nth(2)
      .evaluate((b) => b.click());
    await expect(page.locator('#sheet')).toBeVisible();
    await page.locator('.dlg-bd').dispatchEvent('click');
    await expect(page.locator('#sheet')).toBeHidden();
    await page.locator('#menuBtn').click();
    await expect(page.locator('#menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#menu')).toBeHidden();
    await expect(page.locator('#menuBtn')).toHaveAttribute('aria-expanded', 'false');
  });

  test('the questions page shows the live questions', async ({ page }) => {
    await page.route('**/api/faq', (route) =>
      route.fulfill({ json: { items: [{ q: 'שאלה חיה?', a: 'תשובה חיה.' }] } })
    );
    await page.goto('/new-faq.html');
    await expect(page.locator('#faqList details')).toHaveCount(1);
    await expect(page.locator('#faqList summary')).toHaveText('שאלה חיה?');
  });
});

test.describe('the questions page', () => {
  test('the homepage links to it from the menu and the footer, and it shows the live FAQ', async ({
    page,
  }) => {
    await page.route('**/api/faq', (route) =>
      route.fulfill({
        json: {
          items: [
            { q: 'שאלה ראשונה?', a: 'תשובה.' },
            { q: 'שאלה שנייה?', a: 'עוד תשובה.' },
          ],
        },
      })
    );
    await page.goto('/new.html');
    await expect(page.locator('#faq')).toHaveCount(0);
    await page.locator('footer a[href="new-faq.html"]').click();
    await expect(page).toHaveURL(/\/new-faq\.html$/);
    await expect(page.locator('h1')).toHaveText('שאלות נפוצות');
    await expect(page.locator('#faqList summary')).toHaveText(['שאלה ראשונה?', 'שאלה שנייה?']);
    // the menu is bound by a module script: a click before the page has loaded is lost under a busy machine
    await page.waitForLoadState('load');
    await page.locator('#menuBtn').click();
    await expect(page.locator('#menu a[aria-current="page"]')).toHaveAttribute(
      'href',
      'new-faq.html'
    );
    await page.locator('#menu a[href="new.html#recs"]').click();
    await expect(page).toHaveURL(/\/new\.html#recs$/);
    await page.waitForLoadState('load');
    await page.locator('#menuBtn').click();
    await page.locator('#menu a[href="new-faq.html"]').click();
    await expect(page).toHaveURL(/\/new-faq\.html$/);
  });

  test('is private', async ({ page }) => {
    const res = await page.goto('/new-faq.html');
    expect(res.headers()['x-robots-tag'] || '').toMatch(/noindex/);
    expect(await page.locator('meta[name="robots"]').getAttribute('content')).toMatch(/noindex/);
    const sx = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sx).toBe(0);
  });
});

test.describe('the site footer', () => {
  test('in redesign mode the homepage at / has the live footer: contacts and every link', async ({
    page,
  }) => {
    await previewRedesign(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/\brd-native\b/); // / is new.html in the mode
    for (const id of [
      'footer-wordlists',
      'footer-terms',
      'footer-pickup',
      'footer-faq',
      'footer-timer',
    ])
      await expect(page.getByTestId(id), id).toBeVisible();
    await expect(page.locator('footer a[href^="mailto:"]')).toBeVisible();
    await expect(page.locator('footer a[href^="tel:"]').first()).toBeVisible();
    await page.getByTestId('footer-wordlists').click();
    await expect(page).toHaveURL(/wordlists\.html/);
  });

  test('the questions page has the same footer', async ({ page }) => {
    await page.goto('/new-faq.html');
    await expect(page.getByTestId('footer-wordlists')).toHaveAttribute('href', 'wordlists.html');
    await expect(page.getByTestId('footer-terms')).toBeVisible();
  });

  for (const path of ['/new.html', '/new-faq.html'])
    test(`${path}: no business line (the page has its own section), the tag line right under the icons`, async ({
      page,
    }) => {
      await page.goto(path);
      const contact = page.locator('footer .ft-contact');
      await expect(contact).toBeVisible();
      await expect(page.getByTestId('footer-b2b')).toHaveCount(0);
      await expect(page.locator('footer')).not.toContainText('לעסקים');
      expect(
        await contact.evaluate((c) => [...c.children].map((e) => e.className.split(' ')[0]))
      ).toEqual(['ft-icons', 'ft-tag', 'ft-lines']);
      // and on screen too: icons, then the tag line, then the phone and mail
      const y = async (sel) => (await contact.locator(sel).boundingBox()).y;
      expect(await y('.ft-tag')).toBeGreaterThan(await y('.ft-icons'));
      expect(await y('.ft-lines')).toBeGreaterThan(await y('.ft-tag'));
    });
});
