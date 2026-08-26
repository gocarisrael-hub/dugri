// The word box closes at a full deck — 412 words, the number the counter has
// always shown as "מקסימום".
//
// The server refuses the 413th (tests/unit/deck-cap.test.js); this is about what
// the buyer sees. A page that keeps accepting words the server will throw away is
// the worse half of the bug: she types, the count does not move, and nothing says
// why.
import { test, expect } from '@playwright/test';

const CAP = 412;

// Seed a collection and fill it to `n` words through the API — 412 words through
// the form would be 412 round trips.
async function seedWith(request, n) {
  const c = await request
    .post('/api/collections', { data: { honoree_name: 'חפיסה מלאה', email: 'full@example.com' } })
    .then((r) => r.json());
  // The free quota parks words past its limit, so the order is placed and marked
  // pdf first — an unpaid collection would hit the OTHER lock and prove nothing.
  await request.post(`/api/collections/${c.id}/order`, {
    data: { owner_token: c.owner_token, version: 'pdf' },
  });
  const words = Array.from({ length: n }, (_, i) => 'מילה' + i);
  for (let i = 0; i < words.length; i += 400) {
    await request.post(`/api/collections/${c.id}/words`, {
      data: { words: words.slice(i, i + 400) },
    });
  }
  return c;
}

// Words parked against the free quota count toward the deck too — paying turns a
// held word into a printed one, so holding past 412 would only defer the
// overflow to the checkout. That is why 412 words posted at an UNPAID collection
// (50 stored, the rest held) still leaves the deck full.
test('the server refuses the 413th word and says the deck is full', async ({ request }) => {
  const c = await seedWith(request, CAP);
  const r = await request.post(`/api/collections/${c.id}/words`, {
    data: { words: ['אחת יותר מדי'] },
  });
  expect(r.ok()).toBeTruthy();
  const body = await r.json();
  expect(body).toMatchObject({ added: 0, full: 1, deck_words: CAP });
  // NOT the payment quota — this collection has an order, and conflating the two
  // is how a buyer gets told to pay for something paying cannot fix.
  expect(body.blocked).toBe(0);
});

// The E2E server cannot be walked into a PAID collection (an order goes paid only
// on a real money event, and there are no card credentials here), so a seeded
// collection parks most of its words against the free quota and its live count
// never approaches 412. The COUNT the server reports is therefore patched on its
// way to the browser: what these two tests are about is the page's own contract —
// close the box when the server says the deck is full, leave it open when it does
// not. The server's own rule is proven against the real store in
// tests/unit/deck-cap.test.js.
async function reportCount(page, count) {
  await page.route('**/api/collections/*', async (route) => {
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (!body || typeof body.count !== 'number') return route.fulfill({ response: res });
    return route.fulfill({ json: { ...body, count, free_limit_locked: false } });
  });
}

test('the add box closes, and says why, at a full deck', async ({ page, request }) => {
  const c = await seedWith(request, 3);
  await reportCount(page, CAP);
  await page.goto(`/collect.html?c=${c.id}&k=${c.owner_token}`);

  const veil = page.getByTestId('free-limit-lock');
  await expect(veil).toBeVisible();
  await expect(veil).toContainText('החפיסה מלאה');
  await expect(veil).toContainText(String(CAP));
  // Good news, not a paywall: paying changes nothing here, so no pay button.
  await expect(page.getByTestId('lock-pay-btn')).toBeHidden();
  // And the box really is inert, not merely veiled.
  await expect(page.locator('#addCard input').first()).toBeDisabled();
});

test('one word short, the box is still open', async ({ page, request }) => {
  const c = await seedWith(request, 3);
  await reportCount(page, CAP - 1);
  await page.goto(`/collect.html?c=${c.id}&k=${c.owner_token}`);
  await expect(page.getByTestId('free-limit-lock')).toBeHidden();
  await expect(page.locator('#addCard input').first()).toBeEnabled();
});
