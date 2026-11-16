import { test, expect } from '@playwright/test';
import { ALL_ON, stubFeatures } from './feature-flags.js';
import { openCheckout } from './helpers/checkout.js';

// THE MISSING-ADDRESS ERROR STAYS UNTIL THE BUYER ACTS.
//
// Tapping pay with delivery ticked and no address shows "נא למלא רחוב, עיר ומיקוד
// למשלוח." in #payErr. The page polls the collection every 5s, and each poll
// re-renders the checkout through refreshPay(), which used to hide #payErr
// unconditionally: the message vanished 4-5s later with no buyer action, and
// focus stayed on the pay button (staging QA, 2026-11-16). Now it stays until
// the buyer fills the address (or changes what she is buying), the page takes
// her to the first empty field, and the empty fields read aria-invalid.
//
// Also here: the page logs no "APPLY …" debug lines (it used to, once per poll).

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test.beforeEach(async ({ page }) => {
  await stubFeatures(page, ALL_ON);
  await page.route('**/api/pricing', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        store: { now: 199, was: 239 },
        sale: { on: false, label: '', banner: '' },
        versions: {
          pdf: { enabled: false, price: 79 },
          pickup: { enabled: true, price: 199 },
          delivery: { enabled: true, price: 199 },
          custom: { enabled: false, price: 599 },
        },
        delivery_fee: 39,
      }),
    })
  );
  await page.route('**/api/preview', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        card: PNG,
        back: PNG,
        board: PNG,
        warning: null,
        word_font: null,
        word_font_options: [],
      }),
    })
  );
  // The E2E server has no card provider, so the pay button is hidden; switch it
  // on in the collection GET (the glob's `*` never spans `/`).
  await page.route('**/api/collections/*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    const body = await resp.json();
    body.card_enabled = true;
    return route.fulfill({ json: body });
  });
});

async function createCollection(page, name) {
  await page.goto('/options.html');
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#customTitleInput', name);
  await page.getByTestId('next-btn').click();
  await page.getByTestId('next-btn').click();
  await page.fill('#ownerEmail', 'addr-err@example.com');
  await page.fill('#ownerPhone', '0521234567');
  await page.fill('#buyerNameInput', 'דנה כהן');
  await page.getByTestId('next-btn').click();
  await page.waitForURL(/collect\.html\?c=.+&k=.+/);
  await openCheckout(page);
}

// One background poll: the next collection GET answering, then a beat for the
// render it triggers.
async function waitOnePoll(page) {
  await page.waitForResponse(
    (r) => r.request().method() === 'GET' && /\/api\/collections\/[^/?]+(\?|$)/.test(r.url()),
    { timeout: 12000 }
  );
  await page.waitForTimeout(500);
}

test('the missing-address error survives a poll, points at the street, and clears once filled', async ({
  page,
}) => {
  await createCollection(page, 'Address error');
  await page.locator('input[name="payVersion"][value="pickup"]').check();
  await page.locator('#shipToggle').check();
  await expect(page.locator('#addressForm')).toBeVisible();

  // Nothing may reach the gateway from this test.
  let inits = 0;
  await page.route('**/api/collections/*/pay/init', (route) => {
    inits++;
    return route.fulfill({ status: 503, json: { error: 'card payment not configured' } });
  });

  await page.locator('#cardPayBtn').click();
  const err = page.locator('#payErr');
  await expect(err).toBeVisible();
  await expect(err).toHaveText('נא למלא רחוב, עיר ומיקוד למשלוח.');
  await expect(page.locator('#addrStreet')).toBeFocused();
  for (const sel of ['#addrStreet', '#addrCity', '#addrPostal']) {
    await expect(page.locator(sel)).toHaveAttribute('aria-invalid', 'true');
  }
  // The optional fields are never marked.
  await expect(page.locator('#addrApt')).not.toHaveAttribute('aria-invalid', /.*/);

  // A background poll re-renders the checkout and must leave the error alone.
  await waitOnePoll(page);
  await expect(err).toBeVisible();
  await expect(err).toHaveText('נא למלא רחוב, עיר ומיקוד למשלוח.');

  // Partly filled: the filled field loses its mark, the error stays.
  await page.fill('#addrStreet', 'הרצל 12');
  await expect(page.locator('#addrStreet')).not.toHaveAttribute('aria-invalid', /.*/);
  await expect(page.locator('#addrCity')).toHaveAttribute('aria-invalid', 'true');
  await expect(err).toBeVisible();

  // Fully filled: the error goes.
  await page.fill('#addrCity', 'תל אביב');
  await page.fill('#addrPostal', '6100000');
  await expect(err).toBeHidden();
  for (const sel of ['#addrStreet', '#addrCity', '#addrPostal']) {
    await expect(page.locator(sel)).not.toHaveAttribute('aria-invalid', /.*/);
  }
  expect(inits).toBe(0);
});

test('a second tap with only the city missing focuses the city', async ({ page }) => {
  await createCollection(page, 'Address city');
  await page.locator('input[name="payVersion"][value="pickup"]').check();
  await page.locator('#shipToggle').check();
  await page.fill('#addrStreet', 'הרצל 12');
  await page.fill('#addrPostal', '6100000');
  await page.locator('#cardPayBtn').click();
  await expect(page.locator('#payErr')).toBeVisible();
  await expect(page.locator('#addrCity')).toBeFocused();
  await expect(page.locator('#addrCity')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#addrStreet')).not.toHaveAttribute('aria-invalid', /.*/);

  // Unticking delivery is a real change of what she buys: the error goes with it.
  await page.locator('#shipToggle').uncheck();
  await expect(page.locator('#payErr')).toBeHidden();
});

test('the collect page logs no APPLY debug lines, on load or on a poll', async ({ page }) => {
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await createCollection(page, 'No debug log');
  await waitOnePoll(page);
  expect(logs.filter((t) => /APPLY/.test(t))).toEqual([]);
});
