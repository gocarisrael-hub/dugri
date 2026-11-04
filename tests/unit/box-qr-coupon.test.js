// @vitest-environment node
// THE BOX QR: the QR on a printed game's box sticker, and the ONE personal code
// per order that whoever holds the box claims with it. The codes are friend-
// coupon rows with `source: 'qr'` (server/friend-coupons.js), so this file holds
// what is NEW about them — the token, the one-per-order rule, the scan page's
// API that never says a claimed code twice, "not on the order it came from",
// the sticker wiring, the admin section and the staff key — and reuses the
// friend coupon's own pipeline (validate, spend on paid, the double-use guard)
// through the real app.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import jsQR from 'jsqr';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const rules = require(path.join(serverDir, 'friend-coupons.js'));
const boxQr = require(path.join(serverDir, 'box-qr.js'));

const realFetch = globalThis.fetch;
const ADMIN_KEY = 'test-admin-key';
const STAFF_KEY = 'test-staff-key';
const BASE = 'https://staging.dugri.example';

// Rasterise an SVG that server/box-qr.js drew, from its OWN markup (the viewBox
// and the run-length path), not from the encoder: what is decoded is exactly
// what the sticker prints. 4 px per module.
function decodeSvg(svg) {
  const total = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)[1]);
  const S = 4;
  const w = total * S;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  const re = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;
  let m;
  while ((m = re.exec(svg))) {
    const [x, y, run] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let yy = y * S; yy < (y + 1) * S; yy++) {
      for (let xx = x * S; xx < (x + run) * S; xx++) {
        const i = (yy * w + xx) * 4;
        px[i] = px[i + 1] = px[i + 2] = 0;
      }
    }
  }
  const r = jsQR(px, w, w);
  return r ? r.data : null;
}

describe('the rules', () => {
  it('the token is 128 bits from the CSPRNG, base64url, 22 characters', () => {
    const calls = [];
    const fake = (n) => {
      calls.push(n);
      return Buffer.alloc(n, 0xfb);
    };
    const t = rules.makeBoxToken(fake);
    expect(calls).toEqual([16]);
    expect(t).toBe(Buffer.alloc(16, 0xfb).toString('base64url'));
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const x = rules.makeBoxToken();
      expect(x).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(rules.isBoxTokenShape(x)).toBe(true);
      seen.add(x);
    }
    expect(seen.size).toBe(500);
    for (const bad of ['', 'short', 'x'.repeat(23), 'a/b+c'.padEnd(22, 'a'), null, 42]) {
      expect(rules.isBoxTokenShape(bad)).toBe(false);
    }
  });

  it('the URL is built from PUBLIC_BASE_URL, never a typed domain', () => {
    const t = rules.makeBoxToken();
    expect(rules.boxQrUrl(BASE + '/', t)).toBe(BASE + '/box?t=' + t);
    expect(rules.boxQrUrl('https://dugri-israel.co.il', t)).toBe(
      'https://dugri-israel.co.il/box?t=' + t
    );
    expect(rules.boxQrUrl(null, t)).toBe(null);
    expect(rules.boxQrUrl(BASE, 'not-a-token')).toBe(null);
  });

  it('expiry is in calendar months', () => {
    expect(rules.expiresAtForMonths('2026-11-04T10:00:00.000Z', 6)).toBe(
      '2027-05-04T10:00:00.000Z'
    );
    expect(rules.expiresAtForMonths('2026-01-15T00:00:00.000Z', 1)).toBe(
      '2026-02-15T00:00:00.000Z'
    );
  });

  it('the QR the server draws decodes to the URL', () => {
    const url = BASE + '/box?t=' + rules.makeBoxToken();
    const svg = boxQr.svgFor(url);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(decodeSvg(svg)).toBe(url);
    // The production origin too (a longer URL is a bigger symbol).
    const prod = 'https://dugri-israel.co.il/box?t=' + rules.makeBoxToken();
    expect(decodeSvg(boxQr.svgFor(prod))).toBe(prod);
    expect(boxQr.svgFor('')).toBe(null);
  });
});

let app;
let db;
let settings;
let server;
let base;
let mails;
let nextGetTx = null;
let fakePy;
let captureDir;

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => '' };
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-box-qr-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.STAFF_KEY = STAFF_KEY;
  process.env.RESEND_API_KEY = 're_test';
  process.env.NOTIFY_TO = 'owner@example.com';
  process.env.NOTIFY_FROM = 'Dugri <orders@example.com>';
  delete process.env.BOX_QR_RATE_LIMIT;
  // The sticker renderer, replaced by a stub that keeps the batch it was handed
  // and writes a token PDF: what is under test here is what the SERVER sends it.
  // (The real render, and the QR scanning off it, is generator/test_pickup_stickers.py.)
  captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-box-qr-py-'));
  fakePy = path.join(captureDir, 'fake-python.sh');
  fs.writeFileSync(
    fakePy,
    '#!/bin/sh\ncp "$2" "' + captureDir + '/last.json"\nprintf "%%PDF-1.4 fake" > "$3"\n'
  );
  fs.chmodSync(fakePy, 0o755);
  process.env.PYTHON = fakePy;
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
    'PYTHON',
  ]) {
    delete process.env[k];
  }
});

let ipSeq = 0;
beforeEach(() => {
  mails = [];
  nextGetTx = null;
  ipSeq += 1;
});

async function call(method, urlPath, body, ip) {
  const res = await realFetch(base + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip || '10.7.' + Math.floor(ipSeq / 250) + '.' + (ipSeq % 250),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, text };
}
const post = (p, b, ip) => call('POST', p, b || {}, ip);
const get = (p, ip) => call('GET', p, undefined, ip);
const key = (p, k = ADMIN_KEY) => p + (p.includes('?') ? '&' : '?') + 'key=' + k;

// A paid self-collection order — a box exists — with its QR token minted, as
// printing its sticker does.
function boxOrder(name = 'שירה', { version = 'pickup' } = {}) {
  const c = db.createCollection(name, { theme: 'anniversary', phone: '0527275047' });
  db.setOrder(
    c.id,
    c.owner_token,
    {
      version,
      address:
        version === 'delivery'
          ? { street: 'הרצל 12', city: 'תל אביב', postal: '6100000' }
          : undefined,
    },
    { admin: version === 'delivery' }
  );
  db.markPaid(c.id, { method: 'pelecard' });
  const token = db.ensureBoxQrToken(c.id);
  return { c: db.getCollection(c.id), token };
}

function party(name = 'קונה') {
  return db.createCollection(name);
}

function settle(id) {
  const s = db.getCollection(id).order.pelecard.sessions.slice(-1)[0];
  nextGetTx = {
    StatusCode: '000',
    ResultData: {
      TransactionId: 'tx-1',
      ShvaResult: '000',
      AdditionalDetailsParamX: s.token,
      DebitTotal: s.charged_total * 100,
      DebitApproveNumber: '1234567',
    },
  };
  return post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
}

describe('the token', () => {
  it('is minted once per order and reused: a reprint is the same QR', () => {
    const { c, token } = boxOrder();
    expect(rules.isBoxTokenShape(token)).toBe(true);
    expect(c.order.box_qr.token).toBe(token);
    expect(db.ensureBoxQrToken(c.id)).toBe(token);
    expect(db.getCollectionByBoxQrToken(token).id).toBe(c.id);
    expect(db.getCollectionByBoxQrToken(rules.makeBoxToken())).toBe(null);
    expect(db.getCollectionByBoxQrToken('../etc')).toBe(null);
  });

  it('no order, no token', () => {
    expect(db.ensureBoxQrToken('nope')).toBe(null);
    expect(db.ensureBoxQrToken(party().id)).toBe(null);
  });
});

describe('the scan page API', () => {
  it('an unclaimed box: open, with the words and the percent, and nothing about the order', async () => {
    const { c, token } = boxOrder('נועה המסתורית');
    const r = await get('/api/box-qr/' + token);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('open');
    expect(r.body.percent).toBe(10);
    expect(r.body.expiry_months).toBe(6);
    expect(r.body.copy.title).toBe('החזקתם דוגרי ביד? מגיע לכם 10%');
    expect(r.body.copy.body).toContain('קוד אחד לכל קופסה, בתוקף ל-6 חודשים.');
    expect(r.text).not.toContain('נועה המסתורית');
    expect(r.text).not.toContain(c.id);
    expect(r.text).not.toContain(c.owner_token);
  });

  it('an unknown or malformed token is a 404', async () => {
    expect((await get('/api/box-qr/' + rules.makeBoxToken())).status).toBe(404);
    expect((await get('/api/box-qr/short')).status).toBe(404);
    expect((await post('/api/box-qr/' + rules.makeBoxToken(), { email: 'a@b.co' })).status).toBe(
      404
    );
  });

  it('a cancelled order’s box earns nothing', async () => {
    const { c, token } = boxOrder();
    db.getCollection(c.id).cancelled = true;
    expect((await get('/api/box-qr/' + token)).status).toBe(404);
  });

  it('claims ONE code: on screen once, by mail with the box QR’s own words and link', async () => {
    const { c, token } = boxOrder();
    const r = await post('/api/box-qr/' + token, {
      email: ' Dana.Levi@Gmail.com',
      marketing_consent: true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, created: true, emailed: true, percent: 10 });
    expect(r.body.code).toMatch(/^DANA10-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);

    const row = db.getFriendCouponByCode(r.body.code);
    expect(row).toMatchObject({
      source: 'qr',
      email: 'dana.levi@gmail.com',
      collection_id: c.id,
      discount_percent: 10,
      marketing_consent: true,
    });
    expect(row.expires_at).toBe(rules.expiresAtForMonths(row.created_at, 6));

    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.to).toEqual(['dana.levi@gmail.com']);
    expect(m.subject).toBe('הקוד שלכם מהקופסה של דוגרי');
    const link =
      BASE + '/?coupon=' + r.body.code + '&utm_source=coupon&utm_medium=email&utm_campaign=box_qr';
    expect(m.text).toContain('בונים משחק חדש: ' + link);
    expect(m.text).toMatch(/10% הנחה על המשחק הבא שלכם\. לשימוש אחד, בתוקף עד \d\d\.\d\d\.\d{4}\./);
    // The scanner may be anyone the game was handed to: the party is not named.
    expect(m.text).not.toContain('שירה');
  });

  it('after the claim it says "claimed" to everyone and NEVER says the code again', async () => {
    const { c, token } = boxOrder();
    const first = await post('/api/box-qr/' + token, { email: 'first@x.co' });
    const code = first.body.code;
    mails = [];

    // A second person, another address: told it was claimed, and that is all.
    const second = await post('/api/box-qr/' + token, { email: 'second@x.co' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, claimed: true });
    expect(second.text).not.toContain(code);
    // The SAME address again gets no more than anyone else.
    const same = await post('/api/box-qr/' + token, { email: 'first@x.co' });
    expect(same.body).toEqual({ ok: true, claimed: true });
    // Nothing was mailed — not to the new address, not to the claimer.
    expect(mails).toHaveLength(0);

    const look = await get('/api/box-qr/' + token);
    expect(look.body.state).toBe('claimed');
    expect(look.text).not.toContain(code);
    expect(look.text).not.toContain('first@x.co');

    // One code for the order, whatever was asked.
    expect(
      db.listFriendCoupons({ source: 'qr' }).filter((r) => r.collection_id === c.id)
    ).toHaveLength(1);
    expect(db.getFriendCouponByEmail('second@x.co')).toBe(null);
  });

  it('two claims racing for one box: one code', async () => {
    const { c, token } = boxOrder();
    const [a, b] = await Promise.all([
      post('/api/box-qr/' + token, { email: 'race1@x.co' }),
      post('/api/box-qr/' + token, { email: 'race2@x.co' }),
    ]);
    const made = [a, b].filter((r) => r.body.created);
    expect(made).toHaveLength(1);
    expect([a, b].filter((r) => r.body.claimed)).toHaveLength(1);
    expect(
      db.listFriendCoupons({ source: 'qr' }).filter((r) => r.collection_id === c.id)
    ).toHaveLength(1);
  });

  it('a reprinted sticker (same token) cannot mint a second code, nor can a new token', async () => {
    const { c, token } = boxOrder();
    await post('/api/box-qr/' + token, { email: 'once@x.co' });
    // Even if the order's token were somehow replaced, the rule is keyed by the
    // ORDER, not by the token.
    db.getCollection(c.id).order.box_qr = null;
    const fresh = db.ensureBoxQrToken(c.id);
    expect(fresh).not.toBe(token);
    const again = await post('/api/box-qr/' + fresh, { email: 'twice@x.co' });
    expect(again.body).toEqual({ ok: true, claimed: true });
  });

  it('consent is recorded only on a real true', async () => {
    const { token } = boxOrder();
    const r = await post('/api/box-qr/' + token, { email: 'noc@x.co', marketing_consent: 'yes' });
    expect(db.getFriendCouponByCode(r.body.code).marketing_consent).toBe(false);
  });

  it('a bad email is a 400 and claims nothing', async () => {
    const { c, token } = boxOrder();
    const r = await post('/api/box-qr/' + token, { email: 'nope@' });
    expect(r.status).toBe(400);
    expect(db.getQrCouponForCollection(c.id)).toBe(null);
  });

  it('switched off: the page says so and no code is issued', async () => {
    const { c, token } = boxOrder();
    settings.set('box_qr', 'enabled', false);
    const look = await get('/api/box-qr/' + token);
    const claim = await post('/api/box-qr/' + token, { email: 'off@x.co' });
    settings.reset('box_qr', 'enabled');
    expect(look.body.state).toBe('disabled');
    expect(claim.status).toBe(403);
    expect(db.getQrCouponForCollection(c.id)).toBe(null);
  });

  it('percent and months are copied from the settings when the code is claimed', async () => {
    settings.set('box_qr', 'percent', 15);
    settings.set('box_qr', 'expiry_months', 2);
    const { token } = boxOrder();
    const r = await post('/api/box-qr/' + token, { email: 'fifteen@x.co' });
    settings.reset('box_qr', 'percent');
    settings.reset('box_qr', 'expiry_months');
    expect(r.body.code).toMatch(/^FIFTEEN15-/);
    const row = db.getFriendCouponByCode(r.body.code);
    expect(row.discount_percent).toBe(15);
    expect(row.expires_at).toBe(rules.expiresAtForMonths(row.created_at, 2));
  });

  it('allows five claims per client per hour; a spoofed X-Forwarded-For does not reset it', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const { token } = boxOrder();
      const ip = '203.0.113.' + i + ', 10.201.0.1';
      statuses.push((await post('/api/box-qr/' + token, { email: 'rl' + i + '@x.co' }, ip)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const { token } = boxOrder();
    expect((await post('/api/box-qr/' + token, { email: 'rl9@x.co' }, '10.201.0.2')).status).toBe(
      200
    );
  });
});

describe('the terms a box promises', () => {
  it('are frozen with the token: a later settings change cannot shrink a printed promise', async () => {
    const c = db.createCollection('שירה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    db.markPaid(c.id, { method: 'pelecard' });
    // Minted (as the sticker does) while the offer is 10% for 6 months…
    const token = db.ensureBoxQrToken(c.id, { percent: 10, months: 6 });
    expect(db.getCollection(c.id).order.box_qr).toMatchObject({ percent: 10, months: 6 });
    // …then the owner moves it to 5% for 2 months.
    settings.set('box_qr', 'percent', 5);
    settings.set('box_qr', 'expiry_months', 2);
    try {
      const look = await get('/api/box-qr/' + token);
      expect(look.body.percent).toBe(10);
      expect(look.body.expiry_months).toBe(6);
      expect(look.body.copy.title).toBe('החזקתם דוגרי ביד? מגיע לכם 10%');
      const r = await post('/api/box-qr/' + token, { email: 'frozen@x.co' });
      expect(r.body.code).toMatch(/^FROZEN10-/);
      const row = db.getFriendCouponByCode(r.body.code);
      expect(row.discount_percent).toBe(10);
      expect(row.expires_at).toBe(rules.expiresAtForMonths(row.created_at, 6));
    } finally {
      settings.reset('box_qr', 'percent');
      settings.reset('box_qr', 'expiry_months');
    }
  });

  it('a box minted with no terms reads today’s settings', () => {
    const { c } = boxOrder();
    expect(db.boxQrTerms(c.id, { percent: 7, months: 3 })).toEqual({ percent: 7, months: 3 });
  });

  it('an UNPAID order’s token opens nothing and claims nothing', async () => {
    const c = db.createCollection('לא שולם');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    const token = db.ensureBoxQrToken(c.id, { percent: 10, months: 6 });
    expect((await get('/api/box-qr/' + token)).status).toBe(404);
    expect((await post('/api/box-qr/' + token, { email: 'unpaid@x.co' })).status).toBe(404);
    expect(db.getQrCouponForCollection(c.id)).toBe(null);
  });
});

describe('at checkout', () => {
  async function qrCode(email) {
    const { c, token } = boxOrder();
    const r = await post('/api/box-qr/' + token, { email });
    return { code: r.body.code, source: c };
  }

  it('is refused on the order whose box it came from', async () => {
    const { code, source } = await qrCode('own@x.co');
    expect(db.validateCoupon(code, { collectionId: source.id })).toEqual({
      valid: false,
      reason: 'own_order',
    });
    const r = await post('/api/collections/' + source.id + '/coupon/validate', {
      owner_token: source.owner_token,
      code,
    });
    expect(r.body).toEqual({ valid: false, reason: 'own_order' });
    // …and taken on any other.
    const other = party();
    const ok = await post('/api/collections/' + other.id + '/coupon/validate', {
      owner_token: other.owner_token,
      code: code.toLowerCase(),
    });
    expect(ok.body).toEqual({ valid: true, discount_pct: 10 });
  });

  it('is spent only when the next order is PAID; the order and the owner’s receipt say QR', async () => {
    const { code } = await qrCode('next@x.co');
    const buyer = party();
    const init = await post('/api/collections/' + buyer.id + '/pay/init', {
      owner_token: buyer.owner_token,
      version: 'pickup',
      coupon: code,
    });
    expect(init.status).toBe(200);
    expect(init.body.charged).toBe(Math.round(199 * 0.9));
    expect(db.getFriendCouponByCode(code).used_at).toBe(null);

    mails = [];
    await settle(buyer.id);
    const order = db.getCollection(buyer.id).order;
    expect(order.paid).toBe(true);
    expect(order.coupon).toBe(code);
    expect(order.coupon_source).toBe('qr');
    const row = db.getFriendCouponByCode(code);
    expect(row.used_at).toBeTruthy();
    expect(row.order_id).toBe(buyer.id);

    // The owner's "payment received" mail names it.
    const owner = mails.find(
      (m) => (m.to || []).includes('owner@example.com') && /קופון QR/.test(m.text || '')
    );
    expect(owner && owner.text).toContain('קופון QR מהקופסה: ' + code);

    // Spent: a second order is refused.
    const next = party();
    const again = await post('/api/collections/' + next.id + '/pay/init', {
      owner_token: next.owner_token,
      version: 'pickup',
      coupon: code,
    });
    expect(again.status).toBe(400);
    expect(again.body.reason).toBe('used');
  });

  it('two windows with one code: the first to settle spends it, the second is flagged', async () => {
    const { code } = await qrCode('dbl@x.co');
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
    expect(db.getFriendCouponByCode(code).order_id).toBe(a.id);
    expect(db.getCollection(b.id).order.friend_coupon_conflict.code).toBe(code);
    expect(db.getCollection(b.id).order.coupon_source).toBe('qr');
  });

  it('expires after its months', async () => {
    const { code } = await qrCode('old@x.co');
    const row = db.getFriendCouponByCode(code);
    expect(db.validateFriendCoupon(code, Date.parse(row.expires_at) - 1000).valid).toBe(true);
    expect(db.validateFriendCoupon(code, Date.parse(row.expires_at) + 1000)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });
});

describe('one shop, one namespace of codes', () => {
  it('a QR code is minted around every code another kind already holds', () => {
    // Force the random half: the first draw collides with an owner coupon's
    // compact form, the second with a voucher-free one.
    const { c } = boxOrder();
    db.createCoupon({ code: 'UNIQ10AAAA', discount_pct: 10 });
    const seq = [0, 0, 0, 0, 1, 1, 1, 1];
    const real = require('crypto').randomInt;
    const spy = vi
      .spyOn(require('crypto'), 'randomInt')
      .mockImplementation((n) => (seq.length ? seq.shift() : real(n)));
    const r = db.issueQrCoupon({
      collectionId: c.id,
      email: 'uniq@x.co',
      percent: 10,
      expiryMonths: 6,
    });
    spy.mockRestore();
    expect(r.coupon.code).toBe('UNIQ10-BBBB');
  });

  it('an owner coupon cannot take a personal code’s compact form', async () => {
    const { token } = boxOrder();
    const r = await post('/api/box-qr/' + token, { email: 'clash@x.co' });
    const compact = r.body.code.replace('-', '');
    expect(db.createCoupon({ code: compact, discount_pct: 50 })).toEqual({ error: 'duplicate' });
  });

  it('claiming a box does not use up the friend offer for that email', () => {
    const { c } = boxOrder();
    db.issueQrCoupon({ collectionId: c.id, email: 'both@x.co', percent: 10, expiryMonths: 6 });
    expect(db.getFriendCouponByEmail('both@x.co')).toBe(null);
    const friend = db.issueFriendCoupon({
      email: 'both@x.co',
      collectionId: party().id,
      percent: 5,
      expiryDays: 90,
    });
    expect(friend.created).toBe(true);
    expect(friend.coupon.source).toBe(undefined);
  });
});

describe('the sticker', () => {
  function produced(title) {
    const c = db.createCollection('שירה', {
      theme: 'anniversary',
      custom_title: title,
      buyer_name: 'אופק',
      phone: '0527275047',
    });
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    db.markPaid(c.id, { method: 'pelecard' });
    db.setProduction(c.id, { state: 'generated', pages: 208 });
    db.setProductionReleased(c.id, true);
    return c;
  }
  const lastBatch = () => JSON.parse(fs.readFileSync(path.join(captureDir, 'last.json'), 'utf8'));

  it('carries the order’s QR and line; the token is minted on first print and reused', async () => {
    // Only this test's order on tonight's sheet.
    for (const x of db.listAllCollections())
      if (x.order && x.order.paid) db.setOrderReady(x.id, true);
    const c = produced('קופסה עם QR');
    expect(db.getCollection(c.id).order.box_qr).toBeUndefined();

    const r1 = await realFetch(base + '/api/admin/stickers?key=' + ADMIN_KEY);
    expect(r1.status).toBe(200);
    const token = db.getCollection(c.id).order.box_qr.token;
    expect(rules.isBoxTokenShape(token)).toBe(true);
    const [label] = lastBatch();
    expect(label.title).toBe('קופסה עם QR');
    expect(label.qr_line).toBe('סרקו ל-10% הנחה');
    expect(decodeSvg(label.qr_svg)).toBe(BASE + '/box?t=' + token);

    // Reprint: same token, same QR.
    await realFetch(base + '/api/admin/stickers?key=' + ADMIN_KEY);
    expect(db.getCollection(c.id).order.box_qr.token).toBe(token);
    expect(decodeSvg(lastBatch()[0].qr_svg)).toBe(BASE + '/box?t=' + token);
    db.setOrderReady(c.id, true);
  });

  it('switched off: no QR printed and no token minted', async () => {
    const c = produced('בלי QR');
    settings.set('box_qr', 'enabled', false);
    const res = await realFetch(base + '/api/admin/stickers?key=' + ADMIN_KEY);
    settings.reset('box_qr', 'enabled');
    expect(res.status).toBe(200);
    const label = lastBatch().find((l) => l.title === 'בלי QR');
    expect(label.qr_svg).toBeUndefined();
    expect(db.getCollection(c.id).order.box_qr).toBeUndefined();
    db.setOrderReady(c.id, true);
  });

  it('prints the percent frozen on the order, not today’s setting', async () => {
    const c = produced('קופסה מוקפאת');
    db.ensureBoxQrToken(c.id, { percent: 10, months: 6 });
    settings.set('box_qr', 'percent', 5);
    const res = await realFetch(base + '/api/admin/stickers?key=' + ADMIN_KEY);
    settings.reset('box_qr', 'percent');
    expect(res.status).toBe(200);
    expect(lastBatch().find((l) => l.title === 'קופסה מוקפאת').qr_line).toBe('סרקו ל-10% הנחה');
    db.setOrderReady(c.id, true);
  });

  it('a failing token mint or save never costs the night its stickers', async () => {
    const c = produced('קופסה בלי QR בגלל תקלה');
    const mint = vi.spyOn(db, 'ensureBoxQrToken').mockImplementation(() => {
      throw new Error('disk full');
    });
    const flush = vi.spyOn(db, 'flushBoxQrTokens').mockImplementation(() => {
      throw new Error('disk full');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try {
      res = await realFetch(base + '/api/admin/stickers?key=' + ADMIN_KEY);
    } finally {
      mint.mockRestore();
      flush.mockRestore();
    }
    const logged = err.mock.calls.map((a) => a.join(' ')).join('\n');
    err.mockRestore();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    const label = lastBatch().find((l) => l.title === 'קופסה בלי QR בגלל תקלה');
    expect(label).toBeTruthy();
    expect(label.qr_svg).toBeUndefined();
    expect(logged).toContain('printed without a QR');
    db.setOrderReady(c.id, true);
  });

  it('a delivery box gets our label (with the QR) after HFD’s only when the owner turns it on', () => {
    const printable = [
      {
        kind: 'delivery',
        boxes: 1,
        shipments: [{ box: 1, shipment_number: '77' }],
        label: { title: 'משלוח', qr_svg: '<svg/>' },
        own_label: true,
      },
    ];
    const files = new Map([['77', '/tmp/hfd-77.pdf']]);
    expect(app.stickerEntries(printable, files)).toEqual([
      { pdf: '/tmp/hfd-77.pdf' },
      { title: 'משלוח', qr_svg: '<svg/>', head: 'משלוח' },
    ]);
    printable[0].own_label = false;
    expect(app.stickerEntries(printable, files)).toEqual([{ pdf: '/tmp/hfd-77.pdf' }]);
  });
});

describe('the admin', () => {
  it('the coupons page’s QR section: its own rows, summary and settings — owner key only', async () => {
    const { c, token } = boxOrder();
    const r = await post('/api/box-qr/' + token, { email: 'adminlist@x.co' });
    const list = await get(key('/api/admin/friend-coupons?source=qr&q=adminlist'));
    expect(list.status).toBe(200);
    expect(list.body.coupons).toHaveLength(1);
    expect(list.body.coupons[0]).toMatchObject({
      code: r.body.code,
      source: 'qr',
      box_order_no: db.orderRef(c),
    });
    expect(list.body.summary).toMatchObject({
      enabled: true,
      percent: 10,
      expiry_months: 6,
      delivery_label: false,
    });
    expect(list.body.summary.issued).toBe(db.listFriendCoupons({ source: 'qr' }).length);
    // The friend section does not list it.
    const friends = await get(key('/api/admin/friend-coupons?q=adminlist'));
    expect(friends.body.coupons).toHaveLength(0);
    // The staff key sees neither.
    expect((await get(key('/api/admin/friend-coupons?source=qr', STAFF_KEY))).status).toBe(403);
  });

  it('the summary counts QR codes and the revenue they brought, apart from the friend codes', () => {
    const rows = [
      { code: 'A10-AAAA', source: 'qr', used_at: 'x' },
      { code: 'B10-BBBB', source: 'qr', used_at: null },
      { code: 'C5-CCCC', used_at: 'x' },
    ];
    const cols = [
      { order: { paid: true, coupon: 'A10-AAAA', charged_total: 179 } },
      { order: { paid: true, coupon: 'C5-CCCC', charged_total: 189 } },
    ];
    expect(rules.summarize(rows, cols, 'qr')).toEqual({
      issued: 2,
      used: 1,
      conversion: 0.5,
      orders: 1,
      revenue: 179,
    });
    expect(rules.summarize(rows, cols, 'friend')).toMatchObject({ issued: 1, revenue: 189 });
  });

  it('the owner can fetch an order’s box link; the staff key cannot', async () => {
    const { c, token } = boxOrder();
    const r = await get(key('/api/admin/collections/' + c.id + '/box-qr'));
    expect(r.body).toEqual({
      path: '/box?t=' + token,
      url: BASE + '/box?t=' + token,
      claimed: false,
    });
    for (const p of ['/box-qr', '/BOX-QR', '/box-qr/']) {
      const s = await get(key('/api/admin/collections/' + c.id + p, STAFF_KEY));
      expect(s.status).toBe(403);
    }
    // No box, no link: an unpaid order.
    const unpaid = party();
    db.setOrder(unpaid.id, unpaid.owner_token, { version: 'pickup' });
    expect((await get(key('/api/admin/collections/' + unpaid.id + '/box-qr'))).status).toBe(409);
  });

  it('the staff key’s orders list carries no box token and no coupon source', async () => {
    const { code } = await (async () => {
      const { token } = boxOrder();
      return (await post('/api/box-qr/' + token, { email: 'staffview@x.co' })).body;
    })();
    const buyer = party('קונה לצוות');
    await post('/api/collections/' + buyer.id + '/pay/init', {
      owner_token: buyer.owner_token,
      version: 'pickup',
      coupon: code,
    });
    await settle(buyer.id);
    const { token } = boxOrder('קופסה לצוות');
    const staff = await get(key('/api/admin/collections', STAFF_KEY));
    expect(staff.status).toBe(200);
    expect(staff.text).not.toContain(token);
    expect(staff.text).not.toContain(code);
    expect(staff.text).not.toContain('coupon_source');
    expect(staff.text).not.toContain('box_qr');
    // The owner sees both.
    const owner = await get(key('/api/admin/collections'));
    expect(owner.text).toContain(token);
    const paid = owner.body.collections.find((x) => x.id === buyer.id);
    expect(paid.order.coupon_source).toBe('qr');
  });
});
