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
// The URL a real buyer is actually on when she pays, and the reason the query
// string is stripped everywhere: `k` is her owner token, which reads AND writes
// her order. Meta must never see it and the store must never keep it.
const TOKEN = '1a8a4d03-5172-42b9-a778-6617cd68d995';
const PAY_PAGE = `https://dugri-israel.co.il/collect.html?c=b842e299-dead-beef&k=${TOKEN}`;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1';
const ADMIN_KEY = 'test-admin-key';

let app;
let db;
let settings;
let server;
let base;
let sent; // everything Meta would have received
let nextInit;
let nextGetTx;
let graphFails; // http status Meta should answer with (0 = accept)
let graphError; // the error object inside that answer (code/type/message)
let graphThrows; // make the request to Meta reject outright (dns, socket)

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
  process.env.ADMIN_KEY = ADMIN_KEY;
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
      if (graphThrows) throw new Error('getaddrinfo ENOTFOUND graph.facebook.com');
      if (graphFails) {
        return {
          ok: false,
          status: graphFails,
          // The BODY is what says which failure this is. Meta answers a 4xx for
          // an expired token and for throttling alike, so a test that only sets
          // a status cannot tell the two apart — and neither could the code.
          json: async () => ({ error: { message: 'Invalid parameter', ...graphError } }),
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
  graphFails = 0;
  graphError = {};
  graphThrows = false;
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
async function startPayment({
  cookie = '',
  landing = AD,
  sourceUrl = PAY_PAGE,
  referer,
  ip,
  cfIp,
} = {}) {
  const c = db.createCollection('שירה', { email: 'shira@example.com', phone: '052-244-1334' });
  await post(
    '/api/collections/' + c.id + '/pay/init',
    {
      owner_token: c.owner_token,
      version: 'pdf',
      landing,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
    },
    {
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(referer ? { Referer: referer } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
      ...(cfIp ? { 'CF-Connecting-IP': cfIp } : {}),
    }
  );
  return c;
}

/** The rest of it: PeleCard's own server telling us the card cleared. */
async function completePayment(c) {
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

async function payByCard(opts = {}) {
  return completePayment(await startPayment(opts));
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
    expect(event.event_source_url).toBe('https://dugri-israel.co.il/collect.html');
    // The test client connects over loopback, and ::ffff:127.0.0.1 is nobody's
    // address — Meta would try to match on it. It is dropped, not sent.
    expect(event.user_data.client_ip_address).toBeUndefined();
  });

  // THE ADDRESS WE HAND AN AD PLATFORM MUST NOT BE ONE THE CALLER CHOSE.
  //
  // `trust proxy` is on, so req.ip is the leftmost X-Forwarded-For entry, and
  // Cloudflare APPENDS to that header rather than replacing it — so whatever a
  // client writes there arrives ahead of the address Cloudflare actually saw. A
  // buyer (or a bot) could pick the IP attached to their own purchase.
  it('sends the address Cloudflare saw, in its bare form', async () => {
    await completePayment(await startPayment({ cfIp: '203.0.113.7' }));
    await settle();
    expect(sent[0].body.data[0].user_data.client_ip_address).toBe('203.0.113.7');
  });

  it('refuses an address the client wrote into X-Forwarded-For', async () => {
    // Exactly the request a spoofer makes: a forwarded-for of their choosing and
    // no CF-Connecting-IP, because that one is Cloudflare's to set.
    await completePayment(await startPayment({ ip: '198.51.100.9' }));
    await settle();
    expect(sent[0].body.data[0].user_data.client_ip_address).toBeUndefined();
    expect(JSON.stringify(sent[0].body)).not.toContain('198.51.100.9');
  });

  it('believes Cloudflare over the client when both are present', async () => {
    await completePayment(await startPayment({ ip: '198.51.100.9', cfIp: '203.0.113.7' }));
    await settle();
    expect(sent[0].body.data[0].user_data.client_ip_address).toBe('203.0.113.7');
  });

  // An office NAT, a VPN concentrator, a container network. Matching on one of
  // these makes every buyer behind it look like the same person — the same
  // reason loopback is dropped, and just as much nobody's address.
  it('drops a private address rather than matching everyone behind it', async () => {
    for (const priv of ['10.0.0.4', '192.168.1.20', '172.20.5.5', '127.0.0.1', '::1']) {
      sent = [];
      // A public address in the header the CLIENT controls, so a fallback to it
      // would be visible — nothing may be sent, not the private one and not the
      // one the caller would like us to believe.
      await completePayment(await startPayment({ cfIp: priv, ip: '203.0.113.7' }));
      await settle();
      expect(sent[0].body.data[0].user_data.client_ip_address).toBeUndefined();
      expect(JSON.stringify(sent[0].body)).not.toContain('203.0.113.7');
    }
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
    const started = await startPayment();
    // Read while the report is still owed: the details are dropped the moment
    // Meta has the sale, which is the point of the test below.
    const seenAt = db.getCollection(started.id).order.pelecard.meta_ctx.seen_at;
    await completePayment(started);
    await settle();
    // The purchase instant would be the wrong answer: the touch that produced a
    // sale is routinely days old, and presenting it as just-observed makes the
    // synthesised _fbc disagree with the one the browser really holds.
    expect(sent[0].body.data[0].user_data.fbc).toBe('fb.1.' + seenAt + '.IwAR_click_id');
  });

  it('reports the sale ONCE — the confirmation page cannot double it', async () => {
    const c = await payByCard();
    await settle();
    await vi.waitFor(() => expect(db.getCollection(c.id).order.meta_report.ok).toBe(true));
    // Deterministic, not a timer: the fetch stub records the call synchronously,
    // so by the time /api/track has ANSWERED, any second send it was going to
    // make has already been counted. An absence proved by setTimeout is a CI
    // flake with a date on it.
    const r = await post('/api/track', {
      kind: 'purchase',
      landing: AD,
      collection: c.id,
      k: c.owner_token,
    });
    expect(r.status).toBe(204);
    expect(sent).toHaveLength(1);
  });

  // A stamp that says "reported" when Meta could not be reached is a sale
  // written off on the strength of a timeout. The claim is handed back, and the
  // confirmation page — which knows things the callback did not — tries again.
  it('lets the sale be retried when the send failed transiently', async () => {
    graphFails = 500;
    const c = await payByCard();
    await settle();
    await vi.waitFor(() => expect(db.getCollection(c.id).order.meta_report.at).toBeUndefined());
    graphFails = 0;
    await post('/api/track', { kind: 'purchase', landing: AD, collection: c.id, k: c.owner_token });
    await vi.waitFor(() => expect(sent.length).toBe(2), { timeout: 2000 });
    expect(db.getCollection(c.id).order.meta_report.ok).toBe(true);
  });

  // The opposite case, and it must NOT behave the same way. A revoked token or
  // a deleted pixel answers 400 to every attempt: retrying it once per
  // confirmation-page reload, forever, buys nothing and costs a whole-store
  // write each time.
  it('stops retrying an error that will never come out differently', async () => {
    graphFails = 400;
    const c = await payByCard();
    await settle();
    await vi.waitFor(() => expect(db.getCollection(c.id).order.meta_report.permanent).toBe(true));
    for (let i = 0; i < 3; i++) {
      await post('/api/track', {
        kind: 'purchase',
        landing: AD,
        collection: c.id,
        k: c.owner_token,
      });
    }
    expect(sent).toHaveLength(1);
  });

  // The whole promise of a fail-soft side-effect: the buyer's payment is not
  // the ad platform's to break. PeleCard must be answered whatever Meta does —
  // including refusing to resolve at all.
  it('answers the payment callback even when the send rejects outright', async () => {
    graphThrows = true;
    const c = db.createCollection('רותם', { email: 'rotem@example.com' });
    await post(
      '/api/collections/' + c.id + '/pay/init',
      { owner_token: c.owner_token, version: 'pdf', landing: AD },
      { 'User-Agent': UA }
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
    const r = await post('/api/payment/callback', { transactionId: 'tx-1' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    // And the money still landed, whatever Meta did with its copy.
    expect(db.getCollection(c.id).order.paid).toBe(true);
    await vi.waitFor(() => expect(db.getCollection(c.id).order.meta_report.at).toBeUndefined());
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

// THE OWNER TOKEN IS A CREDENTIAL. collect.html is opened as ?c=<id>&k=<token>,
// and that token reads her order AND writes it — the address, the words, the
// version, the price she is charged. Anything that carries it out of this server
// is a security bug, and an advertising platform's event log is about the worst
// place for it: everyone on the ad account can read it.
describe('the buyer’s owner token never leaves', () => {
  it('strips the query from the page url, whatever the client sends', async () => {
    const c = await payByCard();
    await settle();
    const raw = JSON.stringify(sent[0].body);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain('k=');
    expect(sent[0].body.data[0].event_source_url).toBe('https://dugri-israel.co.il/collect.html');
    expect(JSON.stringify(db.getCollection(c.id).order)).not.toContain(TOKEN);
  });

  // The same leak by the other door: a client that sends no source_url at all
  // still hands us the full referring URL, because no Referrer-Policy is set.
  it('strips it out of the Referer header too', async () => {
    const c = await payByCard({ sourceUrl: '', referer: PAY_PAGE });
    await settle();
    expect(JSON.stringify(sent[0].body)).not.toContain(TOKEN);
    expect(sent[0].body.data[0].event_source_url).toBe('https://dugri-israel.co.il/collect.html');
    expect(JSON.stringify(db.getCollection(c.id).order)).not.toContain(TOKEN);
  });

  // And the third door: the LANDING url. It is whatever page this browser first
  // arrived on, which for a buyer who was sent her own link is that same
  // tokenised URL. Only Meta's click id is worth keeping, so only it is kept.
  it('keeps the click id out of the landing url, and nothing else from it', async () => {
    const started = await startPayment({ landing: PAY_PAGE + '&fbclid=IwAR_from_link' });
    const stored = db.getCollection(started.id).order.pelecard.meta_ctx;
    expect(stored.fbclid).toBe('IwAR_from_link');
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    await completePayment(started);
    await settle();
    expect(sent[0].body.data[0].user_data.fbc).toContain('IwAR_from_link');
    expect(JSON.stringify(sent[0].body)).not.toContain(TOKEN);
  });
});

describe('a buyer’s device details are kept for one report and no longer', () => {
  it('drops them once Meta has the sale', async () => {
    const c = await payByCard({ cookie: '_fbp=fb.1.111.222' });
    await settle();
    await vi.waitFor(() => expect(db.getCollection(c.id).order.pelecard.meta_ctx).toBeUndefined());
    // The outcome is kept — that is the record that stops a second send — but
    // the IP and the user-agent are not part of it.
    expect(db.getCollection(c.id).order.meta_report.ok).toBe(true);
    expect(JSON.stringify(db.getCollection(c.id).order)).not.toContain(UA);
  });

  it('never hands them to the admin orders API', async () => {
    const c = db.createCollection('לפני התשלום');
    await post(
      '/api/collections/' + c.id + '/pay/init',
      { owner_token: c.owner_token, version: 'pdf', landing: AD },
      { 'User-Agent': UA }
    );
    // Still owed a report, so the store legitimately holds them right now.
    expect(db.getCollection(c.id).order.pelecard.meta_ctx.ua).toBe(UA);
    const res = await realFetch(base + '/api/admin/collections?key=' + ADMIN_KEY);
    const body = await res.json();
    const row = body.collections.find((x) => x.id === c.id);
    expect(row.order.pelecard.meta_ctx).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(UA);

    // AND THEY DO NOT STAY. This checkout is never going to be paid — the buyer
    // opened the card form and walked away, which is what most people who open
    // one do. No payment means no report, and the report finishing used to be
    // the only thing that deleted these, so they would have sat here for good:
    // in an order the admin API deliberately will not show her, so she could
    // not have found them to clear them either.
    db.getCollection(c.id).order.pelecard.meta_ctx.seen_at = Date.now() - 25 * 60 * 60 * 1000;
    expect(app.locals.metaCtxSweep()).toBeGreaterThanOrEqual(1);
    expect(db.getCollection(c.id).order.pelecard.meta_ctx).toBeUndefined();
    expect(JSON.stringify(db.getCollection(c.id).order)).not.toContain(UA);
    // The payment handshake itself survives — a late callback verifies its
    // amount against those sessions.
    expect(db.getCollection(c.id).order.pelecard.sessions).toHaveLength(1);
  });

  it('keeps nothing at all when the Conversions API is not armed', async () => {
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

  // The state the site actually ships in: a pixel id set by the owner in the
  // admin, and NO token, because the token is an environment secret nobody has
  // filled in yet. Nothing may be sent, and nothing may be kept.
  it('keeps nothing and sends nothing with no META_CAPI_TOKEN — the shipped state', async () => {
    const token = process.env.META_CAPI_TOKEN;
    delete process.env.META_CAPI_TOKEN;
    try {
      const c = await payByCard();
      expect(c.order.paid).toBe(true);
      expect(sent).toHaveLength(0);
      expect(db.getCollection(c.id).order.pelecard.meta_ctx).toBeUndefined();
      expect(db.getCollection(c.id).order.meta_report).toBeUndefined();
    } finally {
      process.env.META_CAPI_TOKEN = token;
    }
  });
});

// A SEND THAT DIED IN FLIGHT. The claim is taken before the request leaves —
// it has to be, or two callers would send the same sale — so a deploy inside
// the six-second timeout leaves an order claimed and never reported. For the
// buyer this feature exists for, the one who closed the tab, no confirmation
// page is ever coming to notice. The sweep at the next boot is what does.
describe('a report that died in flight is picked up again', () => {
  it('re-sends an order left claimed but never finished', async () => {
    const c = await payByCard();
    await settle();
    // Rewind it into the state a killed process leaves behind: claimed long
    // ago, no outcome recorded.
    const stored = db.getCollection(c.id);
    stored.order.meta_report = { at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    expect(db.staleMetaReports()).toContain(c.id);

    const before = sent.length;
    // Earlier tests in this file deliberately leave their own unfinished
    // reports behind, so the sweep legitimately picks up more than this one.
    expect(app.locals.metaCapiSweep()).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(db.getCollection(c.id).order.meta_report.ok).toBe(true));
    expect(sent.some((x) => x.body.data[0].event_id === db.orderRef(c))).toBe(true);
    // And it is not swept a second time.
    expect(db.staleMetaReports()).not.toContain(c.id);
  });

  it('leaves an in-flight send alone, and never sweeps a sale nobody claimed', async () => {
    const fresh = await payByCard();
    await settle();
    db.getCollection(fresh.id).order.meta_report = { at: new Date().toISOString() };
    expect(db.staleMetaReports()).not.toContain(fresh.id);

    // An order paid before the API was ever armed carries no report record. It
    // must NOT be swept: arming the API would otherwise fire the whole back
    // catalogue at Meta as if every old sale had just happened.
    const old = db.createCollection('מלפני', { email: 'old@example.com' });
    db.setOrder(old.id, old.owner_token, { version: 'pdf' });
    db.markPaid(old.id, { charged_total: 79 });
    expect(db.getCollection(old.id).order.meta_report).toBeUndefined();
    expect(db.staleMetaReports()).not.toContain(old.id);
  });

  it('does not sweep a sale too old to be worth reporting', async () => {
    const c = await payByCard();
    await settle();
    const stored = db.getCollection(c.id);
    stored.order.meta_report = { at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    stored.order.paid_at = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(db.staleMetaReports()).not.toContain(c.id);
  });
});

// A REFUSAL AND A "NOT NOW" ARRIVE LOOKING THE SAME. Meta's Graph API answers a
// plain 400 both for a request it will never accept and for the two things most
// likely to actually go wrong here — throttling, and a token that is expired or
// scoped wrong. Only the error CODE separates them, which is why the code is
// what the classification reads. (Meta's own error reference: "Error handling
// should be done using only the Error Codes.")
describe('a 400 is not automatically final', () => {
  const failWith = async (error) => {
    graphFails = 400;
    graphError = error;
    const c = await payByCard();
    await settle();
    await vi.waitFor(() => expect(db.getCollection(c.id).order.meta_report).toBeTruthy());
    graphFails = 0;
    graphError = {};
    return c;
  };

  // THE MOST LIKELY MISTAKE THE FIRST TIME THE API IS ARMED: a token that has
  // expired, or was minted without the right scope. Writing that off as final
  // would lose every sale made before it is noticed — the sweep excludes a
  // permanent mark and /api/track refuses to re-claim it.
  it('keeps retrying an expired access token (code 190)', async () => {
    const c = await failWith({
      message: 'Error validating access token: Session has expired',
      type: 'OAuthException',
      code: 190,
    });
    const report = db.getCollection(c.id).order.meta_report;
    expect(report.permanent).toBeUndefined();
    expect(report.at).toBeUndefined();
    // Which is what lets a fixed token recover the sale.
    const before = sent.length;
    await post('/api/track', { kind: 'purchase', landing: AD, collection: c.id, k: c.owner_token });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before), { timeout: 2000 });
    expect(db.getCollection(c.id).order.meta_report.ok).toBe(true);
  });

  // A throttle is identified by its CODE, not by a 429: 4 is app-level, 17
  // user-level and 32 page-level (Meta's Graph API rate-limiting docs), 613 the
  // ad-account limit, and 80000–80014 the business-use-case series.
  it('keeps retrying a throttle that arrives as a 400 with a rate-limit code', async () => {
    for (const code of [4, 17, 32, 613, 80004]) {
      const c = await failWith({ message: '(#' + code + ') rate limit', code });
      expect(db.getCollection(c.id).order.meta_report.permanent).toBeUndefined();
      expect(db.staleMetaReports()).toContain(c.id);
    }
  });

  // And the case the classification exists for is still classified: a payload
  // Meta will reject identically every time. Retrying it once per confirmation
  // reload, forever, buys nothing and costs a whole-store write each time.
  it('still writes off a request that is simply wrong (code 100)', async () => {
    const c = await failWith({
      message: 'Invalid parameter',
      type: 'GraphMethodException',
      code: 100,
    });
    expect(db.getCollection(c.id).order.meta_report.permanent).toBe(true);
  });
});

// "The token was wrong and I fixed it." Without a door out of a permanent mark
// there is no way back from that: claimMetaReport refuses, the boot sweep
// excludes it, and nothing else clears it — the sales are lost short of editing
// the store by hand.
describe('the owner can hand a written-off sale back', () => {
  const retry = (body = {}) => post('/api/admin/meta-capi/retry?key=' + ADMIN_KEY, body);

  it('clears the mark and re-sends the sale', async () => {
    graphFails = 400;
    graphError = { message: 'Invalid parameter', code: 100 };
    const c = await payByCard();
    await settle();
    await vi.waitFor(() => expect(db.getCollection(c.id).order.meta_report.permanent).toBe(true));
    graphFails = 0;
    graphError = {};

    const before = sent.length;
    const r = await retry({ collection: c.id });
    expect(r.status).toBe(200);
    expect(r.body.ids).toEqual([c.id]);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before), { timeout: 2000 });
    await vi.waitFor(() => expect(db.getCollection(c.id).order.meta_report.ok).toBe(true));
    expect(sent.some((x) => x.body.data[0].event_id === db.orderRef(db.getCollection(c.id)))).toBe(
      true
    );
  });

  it('is closed without the admin key', async () => {
    expect((await post('/api/admin/meta-capi/retry', {})).status).toBe(403);
  });
});

// WHEN THE SALE HAPPENED, NOT WHEN WE GOT ROUND TO TELLING META. Meta rejects a
// Purchase whose event_time is more than seven days old and processes none of
// the request — so a report resurrected days later that stamps itself with the
// send would both misdate the sale and make the seven-day sweep window
// meaningless, since the event would always look brand new.
describe('a swept report is dated at the sale', () => {
  it('sends the payment instant, not the moment of the retry', async () => {
    const c = await payByCard();
    await settle();
    const stored = db.getCollection(c.id);
    const paidAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    stored.order.paid_at = paidAt;
    stored.order.meta_report = { at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };

    const before = sent.length;
    expect(app.locals.metaCapiSweep()).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before));
    const ref = db.orderRef(stored);
    const event = sent.slice(before).find((x) => x.body.data[0].event_id === ref).body.data[0];
    expect(event.event_time).toBe(Math.floor(Date.parse(paidAt) / 1000));
    // Not the send. Three days apart is well outside any rounding.
    expect(event.event_time).toBeLessThan(Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60);
  });
});
