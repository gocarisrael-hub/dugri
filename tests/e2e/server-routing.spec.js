import { test, expect } from '@playwright/test';

// Guards the Instagram-in-app-browser hardening: a missing asset must return a
// real 404 (not the HTML homepage), an unknown navigation route answers 301 to
// the home page with its query kept, and HTML is served no-cache so stale copies
// stop sticking.

test('missing asset returns 404, not the HTML homepage', async ({ request }) => {
  const res = await request.get('/assets/does-not-exist.png');
  expect(res.status()).toBe(404);
  expect(res.headers()['content-type'] || '').not.toContain('text/html');
});

// Owner decision 2026-11-16: an unknown extension-less path is a 301 to "/",
// not the home page served under the wrong address. The query survives — ads
// and bio links carry their utm/fbclid tags in it, and attribution reads them.
test('unknown extension-less route redirects home, keeping the query', async ({ request }) => {
  for (const [from, to] of [
    ['/some-unknown-route', '/'],
    ['/mesibat-ravkot?utm_source=ig&utm_campaign=x', '/?utm_source=ig&utm_campaign=x'],
    ['/a/b/c/?fbclid=abc', '/?fbclid=abc'],
  ]) {
    const res = await request.get(from, { maxRedirects: 0 });
    expect({ from, status: res.status(), location: res.headers()['location'] }).toEqual({
      from,
      status: 301,
      location: to,
    });
  }
});

test('an unknown asset with an extension is a plain-text 404, not a redirect', async ({
  request,
}) => {
  const res = await request.get('/no-such-image.png?utm_source=ig', { maxRedirects: 0 });
  expect(res.status()).toBe(404);
  expect(res.headers()['location']).toBeUndefined();
  expect(res.headers()['content-type'] || '').toContain('text/plain');
});

test('an unknown /api route is a JSON 404, never a redirect', async ({ request }) => {
  for (const p of ['/api/x', '/api/no/such/route?utm_source=ig']) {
    const res = await request.get(p, { maxRedirects: 0 });
    expect({ p, status: res.status() }).toEqual({ p, status: 404 });
    expect(res.headers()['content-type'] || '').toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not found' });
  }
});

// The real routes are untouched: a page, a live occasion page, an admin page,
// the box page a QR code prints, and the home page itself all answer 200.
test('real routes still answer 200, not the redirect', async ({ request }) => {
  for (const p of ['/', '/products', '/products.html', '/yom-huledet', '/box', '/admin.html']) {
    const res = await request.get(p, { maxRedirects: 0 });
    expect({ p, status: res.status() }).toEqual({ p, status: 200 });
    expect(await res.text()).toContain('<html');
  }
});

// A known occasion that is not live (the seasonal Valentine's page) keeps its own
// 404 from the occasion route; it never reaches the fallback's redirect.
test('a known but not-live occasion slug stays a 404', async ({ request }) => {
  const res = await request.get('/yom-haahava', { maxRedirects: 0 });
  expect(res.status()).toBe(404);
  expect(res.headers()['location']).toBeUndefined();
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
