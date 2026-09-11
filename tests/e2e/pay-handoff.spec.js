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

    await page.goto(`/collect.html?c=${id}&k=${owner_token}`);
    // about:blank never says anything to anyone.
    await openPayment(page, 'about:blank');
    await expect(page.locator('#payModal')).toBeVisible();

    paid = true;
    await page.waitForURL(/pay-success\.html/, { timeout: 20000 });
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
});
