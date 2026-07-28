import { test, expect } from '@playwright/test';

// Guards the Instagram-in-app-browser hardening: a missing asset must return a
// real 404 (not the HTML homepage), unknown navigation routes still fall back to
// the landing page, and HTML is served no-cache so stale copies stop sticking.

test('missing asset returns 404, not the HTML homepage', async ({ request }) => {
  const res = await request.get('/assets/does-not-exist.png');
  expect(res.status()).toBe(404);
  expect(res.headers()['content-type'] || '').not.toContain('text/html');
});

test('unknown extension-less route falls back to the landing page', async ({ request }) => {
  const res = await request.get('/some-unknown-route');
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('<html');
});

test('HTML is served with no-cache', async ({ request }) => {
  const res = await request.get('/');
  expect(res.headers()['cache-control'] || '').toContain('no-cache');
});

// Public social-proof counter: no admin key, shape { count }, and count is a
// number at least the fixed base (23) — base plus however many orders are paid.
test('GET /api/stats/orders returns { count } >= 23 with no auth', async ({ request }) => {
  const res = await request.get('/api/stats/orders');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(typeof body.count).toBe('number');
  expect(body.count).toBeGreaterThanOrEqual(23);
  // Only the aggregate is exposed — no order details leak out.
  expect(Object.keys(body)).toEqual(['count']);
});

// The two order-artifact downloads (deck + board) are API routes, not pages. If
// one were ever un-registered or registered AFTER the SPA catch-all, the fallback
// above would answer it with the landing page — HTTP 200 and HTML — and the
// customer's download link would quietly hand them the homepage under a .pdf
// filename. Assert both still answer as an API for an unknown collection.
for (const artifact of ['pdf', 'board']) {
  test(`the ${artifact} download answers as an API, not the SPA fallback`, async ({ request }) => {
    const res = await request.get(`/api/collections/no-such-collection/${artifact}?t=x`);
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type'] || '').toContain('application/json');
  });

  test(`the admin ${artifact} download refuses without a key, as an API`, async ({ request }) => {
    const res = await request.get(`/api/admin/collections/no-such-collection/${artifact}`);
    expect(res.status()).toBe(403);
    expect(res.headers()['content-type'] || '').toContain('application/json');
  });
}
