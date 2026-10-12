// @vitest-environment node
// The friend coupon end to end through the real app: the issue endpoint, the
// email it sends, the checkout taking the code like any coupon, the code spent
// ONLY when a payment settles, and the owner's admin list. The pure rules and
// the store are in friend-coupons.test.js.
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
const ADMIN_KEY = 'test-admin-key';
const STAFF_KEY = 'test-staff-key';
const BASE = 'https://staging.dugri.example';

let app;
let db;
let settings;
let server;
let base;
let mails; // bodies POSTed to Resend
let resendFails = false;
let nextGetTx = null;

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => '' };
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-friend-routes-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.STAFF_KEY = STAFF_KEY;
  process.env.RESEND_API_KEY = 're_test';
  process.env.NOTIFY_TO = 'owner@example.com';
  process.env.NOTIFY_FROM = 'Dugri <orders@example.com>';
  delete process.env.FRIEND_COUPON_RATE_LIMIT;
  for (const f of ['settings.js', 'db.js', 'notify.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('api.resend.com')) {
        if (resendFails) return { ok: false, status: 500, text: async () => 'down' };
        mails.push(JSON.parse(opts.body));
        return jsonRes({ id: 'm1' });
      }
      if (u.includes('/PaymentGW/init')) {
        return jsonRes({
          URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=tx-1',
          Error: { ErrCode: 0 },
        });
      }
      if (u.includes('/PaymentGW/GetTransaction')) return jsonRes(nextGetTx);
      // Anything else the app fires and forgets (Meta, WhatsApp) answers empty.
      return jsonRes({});
    })
  );

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
  for (const k of [
    'STAFF_KEY',
    'RESEND_API_KEY',
    'NOTIFY_TO',
    'NOTIFY_FROM',
    'PELECARD_TERMINAL',
    'PELECARD_USER',
    'PELECARD_PASSWORD',
  ]) {
    delete process.env[k];
  }
});

let ipSeq = 0;
beforeEach(() => {
  mails = [];
  resendFails = false;
  nextGetTx = null;
  ipSeq += 1;
});

// Each test is its own client unless it says otherwise: the issue endpoint
// allows five per client per hour, and the client is the rightmost
// X-Forwarded-For entry (server/payment-client-ip.js, one proxy hop).
async function call(method, urlPath, body, ip) {
  const res = await realFetch(base + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip || '10.1.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (p, b, ip) => call('POST', p, b || {}, ip);
const get = (p, ip) => call('GET', p, undefined, ip);
const key = (p, k = ADMIN_KEY) => p + (p.includes('?') ? '&' : '?') + 'key=' + k;

function party(name = 'שירה') {
  return db.createCollection(name);
}

describe('GET /api/friend-coupon', () => {
  it('says whether the offer is on and at what percent, from the settings', async () => {
    expect((await get('/api/friend-coupon')).body).toEqual({ enabled: true, percent: 5 });
    settings.set('friend_coupon', 'percent', 12);
    expect((await get('/api/friend-coupon')).body.percent).toBe(12);
    settings.reset('friend_coupon', 'percent');
  });
});

describe('POST /api/friend-coupon', () => {
  it('issues a code, emails it with the landing link, and shows it on screen', async () => {
    const c = party('שירה');
    const r = await post('/api/friend-coupon', {
      email: ' Noa.Cohen@Gmail.com',
      collection_id: c.id,
      marketing_consent: false,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, created: true, emailed: true, percent: 5 });
    expect(r.body.code).toMatch(/^NOA5-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);

    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.to).toEqual(['noa.cohen@gmail.com']);
    // The configured sender — no new domain or address for this mail.
    expect(m.from).toBe('Dugri <orders@example.com>');
    expect(m.subject).toBe('הקופון שלכם מדוגרי');
    const link =
      BASE +
      '/?coupon=' +
      r.body.code +
      '&utm_source=coupon&utm_medium=email&utm_campaign=friend_coupon';
    expect(m.text).toContain('תודה שהוספתם מילים למשחק של שירה.');
    expect(m.text).toContain('הקוד האישי שלכם: ' + r.body.code);
    expect(m.text).toMatch(
      /5% הנחה על המשחק הראשון שלכם\. לשימוש אחד, בתוקף עד \d\d\.\d\d\.\d{4}\./
    );
    expect(m.text).toContain('בונים את המשחק: ' + link);
    expect(m.html).toContain('href="' + link.replace(/&/g, '&amp;') + '"');
    expect(m.html).toContain('dashed');
    expect(m.html).toContain(r.body.code);

    const row = db.getFriendCouponByCode(r.body.code);
    expect(row.collection_id).toBe(c.id);
    expect(row.email_sent_at).toBeTruthy();
    expect(row.email_sends).toBe(1);
  });

  it('falls back to "החוגגים" when the party has no name', async () => {
    const c = party('');
    db.getCollection(c.id).honoree_name = '';
    const r = await post('/api/friend-coupon', { email: 'x1@x.co', collection_id: c.id });
    expect(r.status).toBe(200);
    expect(mails[0].text).toContain('למשחק של החוגגים.');
  });

  it('the same email twice gets the same code resent — and not shown to whoever asked', async () => {
    const c = party();
    const first = await post('/api/friend-coupon', { email: 'twice@x.co', collection_id: c.id });
    const again = await post('/api/friend-coupon', {
      email: 'TWICE@x.co',
      collection_id: party('אחר').id,
    });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, created: false, emailed: true, percent: 5 });
    expect(mails).toHaveLength(2);
    expect(mails[1].text).toContain(first.body.code);
    expect(db.listFriendCoupons({ q: 'twice@' })).toHaveLength(1);
    expect(db.getFriendCouponByCode(first.body.code).email_sends).toBe(2);
  });

  it('a used code is not resent; the answer says it is used', async () => {
    const c = party();
    const first = await post('/api/friend-coupon', { email: 'spent@x.co', collection_id: c.id });
    db.consumeFriendCoupon(first.body.code, 'some-order');
    mails = [];
    const again = await post('/api/friend-coupon', { email: 'spent@x.co', collection_id: c.id });
    expect(again.body).toEqual({ ok: true, created: false, used: true, emailed: false });
    expect(mails).toHaveLength(0);
  });

  it('refuses a bad email (400) and an unknown collection (404), creating nothing', async () => {
    const before = db.listFriendCoupons().length;
    const bad = await post('/api/friend-coupon', { email: 'noa@', collection_id: party().id });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_email');
    const ghost = await post('/api/friend-coupon', { email: 'ok@x.co', collection_id: 'nope' });
    expect(ghost.status).toBe(404);
    expect(ghost.body.error).toBe('no_collection');
    expect(db.listFriendCoupons().length).toBe(before);
    expect(mails).toHaveLength(0);
  });

  it('stores marketing consent only on a real true', async () => {
    const c = party();
    const yes = await post('/api/friend-coupon', {
      email: 'consent@x.co',
      collection_id: c.id,
      marketing_consent: true,
    });
    const row = db.getFriendCouponByCode(yes.body.code);
    expect(row.marketing_consent).toBe(true);
    expect(row.consent_at).toBeTruthy();
    const no = await post('/api/friend-coupon', {
      email: 'noconsent@x.co',
      collection_id: c.id,
      marketing_consent: 'yes',
    });
    expect(db.getFriendCouponByCode(no.body.code).marketing_consent).toBe(false);
  });

  it('a failed send keeps the row, still answers with the code, and is recorded', async () => {
    resendFails = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await post('/api/friend-coupon', { email: 'nomail@x.co', collection_id: party().id });
    warn.mockRestore();
    expect(r.status).toBe(200);
    expect(r.body.emailed).toBe(false);
    expect(r.body.code).toMatch(/^NOMAIL5-/);
    const row = db.getFriendCouponByCode(r.body.code);
    expect(row.email_failed_at).toBeTruthy();
    expect(row.email_sent_at).toBe(null);
  });

  it('the owner can switch the mail off like any other: the row is kept, the code shown', async () => {
    const tpl = settings.get('email', 'friend_coupon');
    settings.set('email', 'friend_coupon', { ...tpl, enabled: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await post('/api/friend-coupon', {
      email: 'mailoff@x.co',
      collection_id: party().id,
    });
    warn.mockRestore();
    settings.reset('email', 'friend_coupon');
    expect(r.body).toMatchObject({ created: true, emailed: false });
    expect(r.body.code).toMatch(/^MAILOFF5-/);
    expect(mails).toHaveLength(0);
  });

  it('is refused while the owner has the offer switched off', async () => {
    settings.set('friend_coupon', 'enabled', false);
    const r = await post('/api/friend-coupon', { email: 'off@x.co', collection_id: party().id });
    settings.reset('friend_coupon', 'enabled');
    expect(r.status).toBe(403);
    expect(db.getFriendCouponByEmail('off@x.co')).toBe(null);
  });

  it('copies the percent and expiry from the settings at issue time', async () => {
    settings.set('friend_coupon', 'percent', 10);
    settings.set('friend_coupon', 'expiry_days', 30);
    const r = await post('/api/friend-coupon', { email: 'ten@x.co', collection_id: party().id });
    settings.reset('friend_coupon', 'percent');
    settings.reset('friend_coupon', 'expiry_days');
    expect(r.body.code).toMatch(/^TEN10-/);
    const row = db.getFriendCouponByCode(r.body.code);
    expect(row.discount_percent).toBe(10);
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(30 * 86400000);
  });

  it('allows five per client per hour, and a spoofed X-Forwarded-For does not reset it', async () => {
    const c = party();
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      // The left entry is the client's own invention; the right one is what our
      // proxy saw, and that is the bucket.
      const ip = '203.0.113.' + i + ', 10.200.0.1';
      statuses.push(
        (await post('/api/friend-coupon', { email: 'rl' + i + '@x.co', collection_id: c.id }, ip))
          .status
      );
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    // Another client is unaffected.
    const other = await post(
      '/api/friend-coupon',
      { email: 'rl9@x.co', collection_id: c.id },
      '10.200.0.2'
    );
    expect(other.status).toBe(200);
  });
});

describe('at checkout', () => {
  async function friendCode(email) {
    const r = await post('/api/friend-coupon', { email, collection_id: party().id });
    return r.body.code;
  }
  function settle(id) {
    const token = db.getCollection(id).order.pelecard.sessions.slice(-1)[0].token;
    const s = db.getCollection(id).order.pelecard.sessions.slice(-1)[0];
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '000',
        AdditionalDetailsParamX: token,
        DebitTotal: s.charged_total * 100,
        DebitApproveNumber: '1234567',
      },
    };
    return post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
  }

  it('the preview takes a friend code typed in any case', async () => {
    const code = await friendCode('preview@x.co');
    const buyer = party('קונה');
    const r = await post('/api/collections/' + buyer.id + '/coupon/validate', {
      owner_token: buyer.owner_token,
      code: code.toLowerCase(),
    });
    expect(r.body).toEqual({ valid: true, discount_pct: 5 });
  });

  it('discounts the game, is spent only when the payment settles, then refuses a second order', async () => {
    const code = await friendCode('paid@x.co');
    const buyer = party('קונה');
    const init = await post('/api/collections/' + buyer.id + '/pay/init', {
      owner_token: buyer.owner_token,
      version: 'pickup',
      coupon: code.toLowerCase(),
    });
    expect(init.status).toBe(200);
    expect(init.body.charged).toBe(Math.round(199 * 0.95));
    // A window is open; nothing is spent yet.
    expect(db.getFriendCouponByCode(code).used_at).toBe(null);

    const cb = await settle(buyer.id);
    expect(cb.status).toBe(200);
    const order = db.getCollection(buyer.id).order;
    expect(order.paid).toBe(true);
    expect(order.coupon).toBe(code);
    const row = db.getFriendCouponByCode(code);
    expect(row.used_at).toBeTruthy();
    expect(row.order_id).toBe(buyer.id);

    // The purchase page reads the code back for GA's `coupon` parameter.
    const sum = await get('/api/collections/' + buyer.id + '/summary?k=' + buyer.owner_token);
    expect(sum.body.order.coupon).toBe(code);

    const next = party('עוד קונה');
    const again = await post('/api/collections/' + next.id + '/pay/init', {
      owner_token: next.owner_token,
      version: 'pickup',
      coupon: code,
    });
    expect(again.status).toBe(400);
    expect(again.body.reason).toBe('used');
  });

  it('an abandoned payment leaves the code unused', async () => {
    const code = await friendCode('abandon@x.co');
    const buyer = party('קונה');
    await post('/api/collections/' + buyer.id + '/pay/init', {
      owner_token: buyer.owner_token,
      version: 'pickup',
      coupon: code,
    });
    await post('/api/collections/' + buyer.id + '/pay/cancel', { owner_token: buyer.owner_token });
    // A declined charge on that window: the provider reports failure.
    const token = db.getCollection(buyer.id).order.pelecard.sessions[0].token;
    nextGetTx = {
      StatusCode: '033',
      ResultData: { TransactionId: 'tx-1', ShvaResult: '033', AdditionalDetailsParamX: token },
    };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    quiet.mockRestore();
    expect(db.getCollection(buyer.id).order.paid).toBe(false);
    expect(db.getFriendCouponByCode(code).used_at).toBe(null);
    expect(db.validateCoupon(code).valid).toBe(true);
  });

  it('two windows opened with one code: the first to settle spends it, the second is flagged', async () => {
    const code = await friendCode('race@x.co');
    const a = party('א');
    const b = party('ב');
    for (const o of [a, b]) {
      const r = await post('/api/collections/' + o.id + '/pay/init', {
        owner_token: o.owner_token,
        version: 'pickup',
        coupon: code,
      });
      expect(r.status).toBe(200);
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await settle(a.id);
    await settle(b.id);
    err.mockRestore();
    expect(db.getCollection(a.id).order.paid).toBe(true);
    expect(db.getCollection(b.id).order.paid).toBe(true);
    expect(db.getFriendCouponByCode(code).order_id).toBe(a.id);
    expect(db.getCollection(b.id).order.friend_coupon_conflict.code).toBe(code);
  });
});

describe('the admin list', () => {
  it('is the owner key only — neither the staff key nor a wrong one', async () => {
    expect((await get(key('/api/admin/friend-coupons', STAFF_KEY))).status).toBe(403);
    expect((await get(key('/api/admin/friend-coupons', 'wrong'))).status).toBe(403);
    expect((await post(key('/api/admin/friend-coupons/x/mark-used', STAFF_KEY))).status).toBe(403);
    expect((await post(key('/api/admin/friend-coupons/x/resend', STAFF_KEY))).status).toBe(403);
  });

  it('answers the summary and the rows, newest first, with the order and searchable', async () => {
    const r = await get(key('/api/admin/friend-coupons'));
    expect(r.status).toBe(200);
    const s = r.body.summary;
    expect(s.issued).toBe(db.listFriendCoupons().length);
    expect(s.used).toBe(db.listFriendCoupons().filter((x) => x.used_at).length);
    expect(s.percent).toBe(5);
    expect(s.enabled).toBe(true);
    // The paid order from "at checkout" is in the revenue at what it was CHARGED.
    expect(s.revenue).toBeGreaterThanOrEqual(Math.round(199 * 0.95));
    const dates = r.body.coupons.map((x) => x.created_at);
    expect([...dates].sort().reverse()).toEqual(dates);
    const paid = r.body.coupons.find((x) => x.email === 'paid@x.co');
    expect(paid.order_no).toMatch(/^DG-/);
    expect(paid.order_link).toMatch(/^\/collect\.html\?c=.+&k=.+/);

    const q = await get(key('/api/admin/friend-coupons?q=PAID@'));
    expect(q.body.coupons.map((x) => x.email)).toEqual(['paid@x.co']);
  });

  it('marks a code used by hand once, and resends the SAME code until it is used', async () => {
    const issued = await post('/api/friend-coupon', {
      email: 'support@x.co',
      collection_id: party().id,
    });
    const row = db.getFriendCouponByCode(issued.body.code);
    mails = [];
    const resent = await post(key('/api/admin/friend-coupons/' + row.id + '/resend'));
    expect(resent.status).toBe(200);
    expect(resent.body.emailed).toBe(true);
    expect(mails[0].text).toContain(issued.body.code);
    expect(resent.body.coupon.code).toBe(issued.body.code);

    const marked = await post(key('/api/admin/friend-coupons/' + row.id + '/mark-used'));
    expect(marked.status).toBe(200);
    expect(marked.body.coupon.used_manually).toBe(true);
    expect((await post(key('/api/admin/friend-coupons/' + row.id + '/mark-used'))).status).toBe(
      409
    );
    expect((await post(key('/api/admin/friend-coupons/' + row.id + '/resend'))).status).toBe(409);
    expect((await post(key('/api/admin/friend-coupons/nope/resend'))).status).toBe(404);
  });
});
