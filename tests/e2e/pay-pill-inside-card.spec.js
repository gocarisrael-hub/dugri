// The card-pay pill sits inside its pay card on a phone. It used to be width:100% on top of the card's 16px side inset
// (`.pay-collapse > :not(.pay-summary)`), so it ran 32px past the card's edge and the card's overflow:hidden cut it off,
// and with the notes after it hidden it sat flush on the card's rounded bottom edge.
import { test, expect } from '@playwright/test';
import { openCheckout } from './helpers/checkout.js';

async function makeCollection(request) {
  const res = await request.post('/api/collections', {
    data: {
      honoree_name: 'שירה',
      email: 'pill@example.com',
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

// The e2e server has no card credentials, so the pill is hidden; flip card_enabled on the state response the way
// collect.spec.js's enableCardButton does. (The `*` never spans `/`: only the base GET is touched.)
async function enableCard(page) {
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const body = await (await route.fetch()).json();
    body.card_enabled = true;
    return route.fulfill({ json: body });
  });
}

for (const width of [360, 390]) {
  test(`the card-pay pill stays inside its card at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 800 });
    await enableCard(page);
    const { id, k } = await makeCollection(request);
    await page.goto(`/collect.html?c=${id}&k=${k}`);
    await openCheckout(page);

    const pill = page.locator('#cardPayBtn');
    await expect(pill).toBeVisible();
    // Both rects in ONE read, polled: the card is still settling when the pill first shows (late price and note
    // renders grow it), and two separate reads could pair the pill's final place with the card's earlier height.
    const rects = () =>
      page.evaluate(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect().toJSON();
        return { b: r('#cardPayBtn'), card: r('#payPanel') };
      });
    await expect
      .poll(
        async () => {
          const { b, card } = await rects();
          return b.bottom <= card.bottom - 8;
        },
        { message: 'bottom edge inside the card' }
      )
      .toBe(true);
    const { b: r, card: c } = await rects();
    const b = { x: r.left, y: r.top, width: r.width, height: r.height };
    const card = { x: c.left, y: c.top, width: c.width, height: c.height };
    expect(b.x, 'left edge inside the card').toBeGreaterThanOrEqual(card.x + 8);
    expect(b.x + b.width, 'right edge inside the card').toBeLessThanOrEqual(
      card.x + card.width - 8
    );
    expect(b.y + b.height, 'bottom edge inside the card').toBeLessThanOrEqual(
      card.y + card.height - 8
    );
    // Still the full-width call to action, not a shrunk button.
    expect(b.width).toBeGreaterThan(card.width - 48);

    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sw, 'the page scrolls sideways').toBeLessThanOrEqual(0);
  });
}

// Brought into view (a tap that scrolls to it, a focus), the pill lands above what is pinned to the foot of the screen:
// the sticky pay bar and the WhatsApp help button lifted over it. It used to stop flush with the viewport's foot, half
// under the bar, with the help button on its end.
for (const width of [360, 390]) {
  test(`scrolled to, the card-pay pill clears the pay bar and the help button at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await enableCard(page);
    const { id, k } = await makeCollection(request);
    await page.goto(`/collect.html?c=${id}&k=${k}`);
    await openCheckout(page);
    await expect(page.getByTestId('pay-bar')).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#cardPayBtn').evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
    const m = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      return {
        pill: r('#cardPayBtn').bottom,
        bar: r('#payBar').top,
        help: r('.wa-help').top,
      };
    });
    expect(m.pill, 'the pill ends above the pay bar').toBeLessThanOrEqual(m.bar);
    expect(m.pill, 'the pill ends above the help button').toBeLessThanOrEqual(m.help);
  });
}
