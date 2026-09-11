import { test, expect } from '@playwright/test';

// GETTING OUT OF A PAID CHECKOUT, when the payment frame is on a DIFFERENT
// ADDRESS from the page around it.
//
// That is not a hypothetical: PeleCard returns the frame to PUBLIC_BASE_URL, and
// in production that was the Railway hostname while buyers browsed the real
// domain. The old code compared origins and threw every completed payment away
// in silence — 35 of 41 orders in one twelve-day stretch never reached the
// confirmation page, which is also the only place a sale is reported to Google
// and to Meta.
//
// The e2e server answers on both `localhost` and `127.0.0.1`, which the browser
// treats as two different origins. That is the whole fixture: same server, same
// files, genuinely cross-origin — exactly the shape of the production bug.
const uniq = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

async function seedOrder(request, name) {
  const create = await request.post('/api/collections', {
    data: { honoree_name: name, email: `${name}@example.com`, phone: '0522441334' },
  });
  const { id, owner_token } = await create.json();
  await request.post(`/api/collections/${id}/order`, {
    data: { owner_token, version: 'pickup' },
  });
  return { id, owner_token };
}

const otherOrigin = (url) => `http://127.0.0.1:${new URL(url).port}`;

// Open the payment window through the checkout's OWN button, with the gateway
// stubbed out: the e2e server has no card credentials, but every line of the
// page's behaviour after "the gateway gave us a URL" is exactly the real one —
// including the watcher that finishes the checkout when no message arrives.
// The e2e server runs without card credentials on purpose, so the collection
// reports card_enabled:false and the checkout hides its card button. Reporting
// it as configured is the only fiction here — everything after "the gateway
// handed us a URL" is the page's real behaviour.
async function cardPaymentAvailable(page, id) {
  await page.route(`**/api/collections/${id}?**`, async (route) => {
    const resp = await route.fetch();
    const body = await resp.json();
    body.card_enabled = true;
    await route.fulfill({ response: resp, json: body });
  });
}

// GA events are pushed to window.dataLayer, and the last thing the handoff does
// is navigate to the confirmation page — which wipes it. Mirror every event name
// into sessionStorage (same origin, survives the navigation) so the funnel step
// can still be read once the buyer has landed.
async function recordEvents(page) {
  await page.addInitScript(() => {
    const layer = (window.dataLayer = window.dataLayer || []);
    const push = layer.push.bind(layer);
    layer.push = (...args) => {
      try {
        const a = args[0];
        if (a && a[0] === 'event') {
          const seen = JSON.parse(sessionStorage.getItem('e2e:ga') || '[]');
          seen.push(a[1]);
          sessionStorage.setItem('e2e:ga', JSON.stringify(seen));
        }
      } catch {
        /* private mode */
      }
      return push(...args);
    };
  });
}

const recordedEvents = (page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('e2e:ga') || '[]'));

async function openPayment(page, frameUrl) {
  await page.route('**/pay/init', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: frameUrl }),
    })
  );
  // The checkout lives on its own tab, and is a collapsed <details> inside it —
  // its button has no size until both are open. This is the buyer's own route.
  await page.getByTestId('tab-pay').click();
  const panel = page.locator('#payPanel');
  await expect(panel).toBeVisible();
  if (!(await panel.evaluate((el) => el.open))) {
    await panel.locator('summary').first().click();
  }
  const btn = page.locator('#cardPayBtn');
  await expect(btn).toBeVisible();
  await btn.click();
  // Deliberately NOT asserting the frame's src here: when the handoff works the
  // modal is closed and the frame blanked within milliseconds, so checking it
  // would be a race against the very success we are testing for.
}

test.describe('the way out of a card payment', () => {
  test('a frame on another address still ends the checkout', async ({ page, request }) => {
    const { id, owner_token } = await seedOrder(request, uniq('cross'));
    await cardPaymentAvailable(page, id);
    await page.goto(`/collect.html?c=${id}&k=${owner_token}`);
    await expect(page.locator('#payModal')).toBeHidden();

    // Open the payment window at the OTHER origin, exactly as PeleCard would
    // when PUBLIC_BASE_URL names a different host than the buyer is on.
    const done = otherOrigin(page.url()) + '/pay-done.html';
    await openPayment(page, done);

    // pay-done announces success; the checkout must accept it despite the
    // origins differing, and hand the buyer to the confirmation page.
    await page.waitForURL(/pay-success\.html/, { timeout: 15000 });
  });

  test('a frame that reports failure closes the window and stays put', async ({
    page,
    request,
  }) => {
    const { id, owner_token } = await seedOrder(request, uniq('failed'));
    await cardPaymentAvailable(page, id);
    await page.goto(`/collect.html?c=${id}&k=${owner_token}`);
    const done = otherOrigin(page.url()) + '/pay-done.html?error=1';
    await openPayment(page, done);

    await expect(page.locator('#payModal')).toBeHidden({ timeout: 15000 });
    // Nobody is sent to a confirmation page for a payment that did not happen.
    expect(page.url()).toContain('collect.html');
  });

  // THE GUARANTEE. Even with no message at all — a frame that never loads, a
  // browser that blocks the announcement, a buyer who closed the window — the
  // page watches the order and finishes the checkout once the server says paid.
  test('the checkout finishes even when no message ever arrives', async ({ page, request }) => {
    const { id, owner_token } = await seedOrder(request, uniq('silent'));

    // The order flips to paid on the server's side of the world; here we make
    // the collection read back as paid, which is all this page can see.
    let paid = false;
    await page.route(`**/api/collections/${id}?**`, async (route) => {
      const resp = await route.fetch();
      const body = await resp.json();
      body.card_enabled = true;
      if (paid) body.paid = true;
      await route.fulfill({ response: resp, json: body });
    });

    await recordEvents(page);
    await page.goto(`/collect.html?c=${id}&k=${owner_token}`);
    // about:blank never says anything to anyone.
    await openPayment(page, 'about:blank');
    await expect(page.locator('#payModal')).toBeVisible();

    paid = true;
    await page.waitForURL(/pay-success\.html/, { timeout: 20000 });

    // AND IT REPORTS THE SALE. This route home is the primary one for exactly
    // the buyers this change rescues, so a silent one would go on
    // under-reporting the funnel step the whole fix exists to repair — the
    // postMessage path and the free-coupon path both fire it.
    expect(await recordedEvents(page)).toContain('card_pay_done');
  });

  test('and it still finishes after the buyer closes the window by hand', async ({
    page,
    request,
  }) => {
    const { id, owner_token } = await seedOrder(request, uniq('closed'));
    let paid = false;
    await page.route(`**/api/collections/${id}?**`, async (route) => {
      const resp = await route.fetch();
      const body = await resp.json();
      body.card_enabled = true;
      if (paid) body.paid = true;
      await route.fulfill({ response: resp, json: body });
    });

    await page.goto(`/collect.html?c=${id}&k=${owner_token}`);
    await openPayment(page, 'about:blank');
    await page.locator('#payModalClose').click();
    await expect(page.locator('#payModal')).toBeHidden();

    // They had already paid — the commonest shape of the original bug.
    paid = true;
    await page.waitForURL(/pay-success\.html/, { timeout: 20000 });
  });

  // THE SAME MODAL SELLS A SECOND THING, and it is sold on an order that is
  // ALREADY PAID — db.shippingUpgrade refuses with 'no paid order' otherwise.
  // A watcher armed here would therefore see isPaid() on its very first tick,
  // blank the live PeleCard frame and march the buyer off to the confirmation
  // page 2.5 seconds after the window opened, and the upgrade could never be
  // bought at all.
  test('the delivery upgrade keeps its payment window', async ({ page, request }) => {
    const { id, owner_token } = await seedOrder(request, uniq('upgrade'));
    await page.route(`**/api/collections/${id}?**`, async (route) => {
      const resp = await route.fetch();
      const body = await resp.json();
      body.card_enabled = true;
      body.paid = true; // the upgrade is only ever offered on a paid order
      body.shipping_upgrade = { offered: true, reason: null, fee: 39, paid: false, address: null };
      await route.fulfill({ response: resp, json: body });
    });
    // Inert on purpose: the real pay-done.html announces itself the moment it
    // loads, which would be a race rather than a test.
    await page.route('**/shipping/init**', (route) =>
      route.fulfill({ json: { url: 'about:blank#dugri-upgrade', charged: 39 } })
    );

    await page.goto(`/collect.html?c=${id}&k=${owner_token}`);
    await page.getByTestId('tab-finish').click();
    await page.getByTestId('ship-add-summary').click();
    await page.getByTestId('ship-street').fill('הרצל 12');
    await page.getByTestId('ship-city').fill('תל אביב');
    await page.getByTestId('ship-postal').fill('6100000');
    await page.getByTestId('ship-add-btn').click();
    await expect(page.locator('#payModal')).toBeVisible();

    // Past the first tick, and the second. The window must still be the live
    // gateway window, and the buyer must still be on their collection.
    await page.waitForTimeout(6000);
    await expect(page.locator('#payModal')).toBeVisible();
    await expect(page.locator('#payFrame')).toHaveAttribute('src', 'about:blank#dugri-upgrade');
    expect(page.url()).toContain('collect.html');
  });

  // The watcher goes on running for up to ten minutes after the modal closed,
  // which is precisely when the owner is back on her words fixing one. render()
  // detaches the focused editor, and a detach fires blur → commit: her
  // half-typed text would be saved over the word. The five-second background
  // poll has always stepped around this; so must the watcher.
  test('a word being edited survives the watcher', async ({ page, request }) => {
    const { id, owner_token } = await seedOrder(request, uniq('editing'));
    await request.post(`/api/collections/${id}/words`, { data: { words: ['הדייט מטבריה'] } });
    await cardPaymentAvailable(page, id);

    await page.goto(`/collect.html?c=${id}&k=${owner_token}`);
    // Arm the watcher the buyer's own way, then close the window by hand.
    await openPayment(page, 'about:blank');
    await expect(page.locator('#payModal')).toBeVisible();
    await page.locator('#payModalClose').click();
    await expect(page.locator('#payModal')).toBeHidden();

    await page.getByTestId('tab-words').click();
    await page.locator('.word', { hasText: 'הדייט מטבריה' }).getByTestId('word-text').click();
    const editor = page.getByTestId('word-edit-input');
    await expect(editor).toBeVisible();
    await editor.fill('הדייט מטב'); // mid-correction, nothing committed

    // Three watcher ticks.
    await page.waitForTimeout(8000);
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue('הדייט מטב');

    // And nothing was written behind her back.
    const stored = await request.get(`/api/collections/${id}`).then((r) => r.json());
    expect(stored.words.map((w) => w.text)).toEqual(['הדייט מטבריה']);
  });
});
