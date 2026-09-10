// @vitest-environment node
//
// THE POINT OF A SERVER-SIDE REPORT: the sale reaches Meta from the payment
// itself, not from the buyer's confirmation page.
//
// A buyer who closes the tab the moment the card clears has still bought the
// deck — and that is exactly the buyer this feature exists for, since the same
// browser that never renders the confirmation page is the one whose pixel was
// blocked. So these tests drive the REAL PeleCard callback (a request made by
// PeleCard's server, with no browser anywhere in it) and assert that Meta is
// told, with a payload it will actually accept.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const realFetch = globalThis.fetch;
const PIXEL = '1234567890123456';
const AD = 'https://dugri-israel.co.il/?fbclid=IwAR_click_id&utm_source=instagram';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1';

let app;
let db;
let settings;
let server;
let base;
let sent; // everything Meta would have received
let nextInit;
let nextGetTx;
let graphRefuses; // make Meta refuse the next event

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-capi-cb-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.META_CAPI_TOKEN = 'EAA-test-token';
  delete process.env.META_CAPI_TEST_CODE;
  for (const f of [
    'db.js',
    'settings.js',
    'pelecard.js',
    'attribution.js',
    'meta-capi.js',
    'index.js',
  ])
    delete require.cache[require.resolve(path.join(serverDir, f))];
  settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery']) settings.set('pricing', v + '_enabled', true);
  settings.set('analytics', 'meta_pixel_id', PIXEL);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal('fetch', async (url, opts) => {
    const u = String(url);
    if (u.includes('graph.facebook.com')) {
      sent.push({ url: u, body: JSON.parse(opts.body) });
      if (graphRefuses) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'Invalid parameter' } }),
        };
      }
      return jsonRes({ events_received: 1 });
    }
    if (u.includes('/PaymentGW/init')) return jsonRes(nextInit);
    if (u.includes('/PaymentGW/GetTransaction')) return jsonRes(nextGetTx);
    throw new Error('unexpected fetch ' + u);
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (server) server.close();
  delete process.env.META_CAPI_TOKEN;
});

beforeEach(() => {
  sent = [];
  nextInit = { URL: 'https://gateway21.pelecard.biz/PaymentGW?tx=1', Error: { ErrCode: 0 } };
  nextGetTx = null;
  graphRefuses = false;
});

async function post(urlPath, body, headers = {}) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const settle = () => vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), { timeout: 2000 });

/**
 * One order taken all the way through a card payment, exactly as the browser
 * and PeleCard would: pay/init from the BUYER's request (cookies, user agent,
 * the ad they landed on), then the callback from PELECARD's server.
 */
async function payByCard({ cookie = '', landing = AD } = {}) {
  const c = db.createCollection('שירה', { email: 'shira@example.com', phone: '052-244-1334' });
  await post(
    '/api/collections/' + c.id + '/pay/init',
    { owner_token: c.owner_token, version: 'pdf', landing, source_url: 'https://dugri.example/c' },
    { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) }
  );
  const token = db.getCollection(c.id).order.pelecard.sessions[0].token;
  nextGetTx = {
    StatusCode: '000',
    ResultData: {
      TransactionId: 'tx-1',
      ShvaResult: '000',
      AdditionalDetailsParamX: token,
      DebitTotal: 7900,
      DebitApproveNumber: '86-001-006',
    },
  };
  // PeleCard's own server calling us. No cookies, no user agent, no browser.
  await post('/api/payment/callback', { transactionId: 'tx-1' });
  return db.getCollection(c.id);
}

describe('the sale is reported without the buyer’s browser', () => {
  it('reports the purchase from the payment callback, tab open or not', async () => {
    const c = await payByCard({ cookie: '_fbp=fb.1.111.222; _fbc=fb.1.999.RealClick' });
    await settle();
    expect(sent).toHaveLength(1);
    const event = sent[0].body.data[0];
    expect(event.event_name).toBe('Purchase');
    expect(event.event_id).toBe(db.orderRef(c));
    expect(event.custom_data).toEqual({ value: 79, currency: 'ILS' });
    // Captured from the BUYER's pay/init and carried to a callback that has none
    // of it: Meta's own cookies, their browser, the page they paid from.
    expect(event.user_data.fbc).toBe('fb.1.999.RealClick');
    expect(event.user_data.fbp).toBe('fb.1.111.222');
    expect(event.user_data.client_user_agent).toBe(UA);
    expect(event.user_data.client_ip_address).toBeTruthy();
    expect(event.event_source_url).toBe('https://dugri.example/c');
  });

  it('never leaves user_data empty — Meta rejects the whole event without it', async () => {
    // The buyer this feature is FOR: no fbclid in the URL, no _fbp, no _fbc,
    // contact matching off. There must still be a match key in the payload.
    const c = await payByCard({ landing: 'https://dugri-israel.co.il/' });
    await settle();
    const user = sent[0].body.data[0].user_data;
    expect(Object.keys(user).length).toBeGreaterThan(0);
    expect(user.fbc).toBeUndefined();
    // external_id: our own order number, hashed like every other identifier, so
    // Meta always has one key to match on even when the browser gave it none.
    const sha = (v) => require('node:crypto').createHash('sha256').update(v).digest('hex');
    expect(user.external_id).toEqual([sha(db.orderRef(c).toLowerCase())]);
    expect(user.client_user_agent).toBe(UA);
  });

  it('stamps a rebuilt click id with when the click was SEEN, not with the sale', async () => {
    const c = await payByCard();
    await settle();
    const seenAt = db.getCollection(c.id).order.pelecard.meta_ctx.seen_at;
    // The purchase instant would be the wrong answer: the touch that produced a
    // sale is routinely days old, and presenting it as just-observed makes the
    // synthesised _fbc disagree with the one the browser really holds.
    expect(sent[0].body.data[0].user_data.fbc).toBe('fb.1.' + seenAt + '.IwAR_click_id');
  });

  it('reports the sale ONCE — the confirmation page cannot double it', async () => {
    const c = await payByCard();
    await settle();
    await post('/api/track', { kind: 'purchase', landing: AD, collection: c.id, k: c.owner_token });
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(1);
    expect(db.getCollection(c.id).order.meta_reported_at).toBeTruthy();
  });

  // A stamp that says "reported" when Meta refused the event is a sale written
  // off on the strength of a timeout. The claim is handed back, and the
  // confirmation page — which knows things the callback did not — tries again.
  it('lets the sale be retried when Meta refused it', async () => {
    graphRefuses = true;
    const c = await payByCard();
    await settle();
    await vi.waitFor(() => expect(db.getCollection(c.id).order.meta_reported_at).toBeUndefined());
    graphRefuses = false;
    await post('/api/track', { kind: 'purchase', landing: AD, collection: c.id, k: c.owner_token });
    await vi.waitFor(() => expect(sent.length).toBe(2), { timeout: 2000 });
    expect(db.getCollection(c.id).order.meta_reported_at).toBeTruthy();
  });

  it('reports a free (100% coupon) order from the request that paid it', async () => {
    db.createCoupon({ code: 'ALLFREE', discount_pct: 100, valid_until: null });
    const c = db.createCollection('דנה', { email: 'dana@example.com' });
    const r = await post(
      '/api/collections/' + c.id + '/pay/init',
      { owner_token: c.owner_token, version: 'pdf', coupon: 'ALLFREE', landing: AD },
      { 'User-Agent': UA }
    );
    expect(r.body.paid).toBe(true);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.data[0].user_data.client_user_agent).toBe(UA);
  });
});

describe('a buyer’s device details are stored only for a shop that reports', () => {
  it('keeps nothing when the Conversions API is not armed', async () => {
    settings.set('analytics', 'meta_pixel_id', '');
    try {
      const c = db.createCollection('בלי מטא');
      await post(
        '/api/collections/' + c.id + '/pay/init',
        { owner_token: c.owner_token, version: 'pdf', landing: AD },
        { 'User-Agent': UA }
      );
      expect(db.getCollection(c.id).order.pelecard.meta_ctx).toBeUndefined();
    } finally {
      settings.set('analytics', 'meta_pixel_id', PIXEL);
    }
  });
});
