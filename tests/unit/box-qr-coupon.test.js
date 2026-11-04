// @vitest-environment node
// THE BOX QR: ONE static QR for everyone, on the box art, opens /box; whoever
// types the PHONE NUMBER an order was placed with gets ONE personal code per
// PRODUCED order of that number, shown on screen and mailed to the order's
// address. The codes are friend-coupon rows with `source: 'qr'`
// (server/friend-coupons.js), so this file holds what is NEW about them — the
// phone rule, eligibility, one per produced order oldest first, the neutral
// no-match, the rate limits, "not on the order it came from", the admin
// section, its downloadable QR and the staff key — and reuses the friend
// coupon's own pipeline (validate, spend on paid, the double-use guard) through
// the real app. Also: the stickers carry nothing of it.
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
// what the owner downloads. 4 px per module.
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
  it('a phone number is the checkout’s: dashes, spaces, +972 and 972 are one number', () => {
    for (const v of [
      '0527275047',
      '052-7275047',
      '052-727-5047',
      ' 052 727 5047 ',
      '+972527275047',
      '+972 52-727-5047',
      '972527275047',
      '00972527275047',
      '+972 052 727 5047',
      '(052) 727.5047',
    ]) {
      expect(rules.normPhone(v)).toBe('0527275047');
    }
    for (const bad of ['', '12345', 'abc', '05272750', null, undefined, 42]) {
      expect(rules.normPhone(bad)).toBe('');
    }
  });

  it('an order earns a code only when paid, not cancelled and PRODUCED (generated AND released)', () => {
    const made = { state: 'generated', released_at: '2026-11-01T10:00:00.000Z' };
    expect(rules.orderEarnsQrCode({ order: { paid: true, production: made } })).toBe(true);
    // The collection's mirror counts as well as the order's record.
    expect(rules.orderEarnsQrCode({ order: { paid: true }, production: made })).toBe(true);
    expect(rules.orderEarnsQrCode({ order: { paid: false, production: made } })).toBe(false);
    expect(
      rules.orderEarnsQrCode({ cancelled: true, order: { paid: true, production: made } })
    ).toBe(false);
    // Built by the buyer's סיום but not released by the owner: not yet.
    expect(
      rules.orderEarnsQrCode({ order: { paid: true, production: { state: 'generated' } } })
    ).toBe(false);
    expect(
      rules.orderEarnsQrCode({
        order: { paid: true, production: { state: 'needs_design', released_at: 'x' } },
      })
    ).toBe(false);
    expect(rules.orderEarnsQrCode({ order: { paid: true } })).toBe(false);
    expect(rules.orderEarnsQrCode(null)).toBe(false);
  });

  it('the email is masked to two letters and the domain', () => {
    expect(rules.maskEmail('hadar.levi@gmail.com')).toBe('ha***@gmail.com');
    expect(rules.maskEmail(' Ab@x.co')).toBe('a***@x.co');
    expect(rules.maskEmail('a@x.co')).toBe('a***@x.co');
    expect(rules.maskEmail('')).toBe(null);
    expect(rules.maskEmail(null)).toBe(null);
  });

  it('a QR code carries TWELVE random characters (59 bits); a friend code keeps its four', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const code = rules.makeQrCode(10);
      expect(code).toMatch(/^DUGRI10(?:-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}){3}$/);
      expect(code.replace(/^DUGRI10/, '').replace(/-/g, '')).toHaveLength(12);
      expect(rules.isQrCodeShape(code)).toBe(true);
      expect(rules.percentInCode(code)).toBe(10);
      seen.add(code);
    }
    expect(seen.size).toBe(2000);
    // log2(31^12) — the space a guesser of one percent's codes has to walk.
    expect(12 * Math.log2(31)).toBeGreaterThan(59);
    // Every draw is one of 31 from the CSPRNG.
    const calls = [];
    rules.makeQrCode(5, {
      randomInt: (n) => {
        calls.push(n);
        return 0;
      },
    });
    expect(calls).toEqual(Array(12).fill(31));
    // Friend codes: unchanged.
    expect(rules.makeCode('noa@x.co', 5)).toMatch(/^NOA5-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
  });

  it('personal-code shapes, in any case and with or without dashes, are what the miss limiter counts', () => {
    for (const yes of [
      'DUGRI10-K7Q2-ABCD-EFGH',
      'dugri10k7q2abcdefgh',
      ' dugri10 k7q2 abcd efgh ',
      'NOA5-K7Q2',
      'noa5k7q2',
    ]) {
      expect(rules.looksLikePersonalCode(yes)).toBe(true);
    }
    for (const no of ['SUMMER10', 'WELCOME', 'DUGRI10-K7Q2-ABCD', '', null]) {
      expect(rules.looksLikePersonalCode(no)).toBe(false);
    }
  });

  it('the page URL is built from PUBLIC_BASE_URL, never a typed domain', () => {
    expect(rules.boxPageUrl(BASE + '/')).toBe(BASE + '/box');
    expect(rules.boxPageUrl('https://dugri-israel.co.il')).toBe('https://dugri-israel.co.il/box');
    expect(rules.boxPageUrl(null)).toBe(null);
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
    for (const url of [BASE + '/box', 'https://dugri-israel.co.il/box']) {
      const svg = boxQr.svgFor(url);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(decodeSvg(svg)).toBe(url);
    }
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
  // and writes a token PDF: what is under test here is that the SERVER sends it
  // the labels it sent before the box QR existed (the real render is
  // generator/test_pickup_stickers.py).
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

// A distinct buyer phone per call, so each test owns its numbers.
let phoneSeq = 1000000;
const newPhone = () => '054' + String(phoneSeq++).padStart(7, '0');

// An order: paid and PRODUCED (deck generated and released) unless told not to.
// `created_at` is set by hand where a test needs a known oldest-first order.
function order({
  phone = newPhone(),
  email = 'hadar.levi@gmail.com',
  name = 'שירה',
  version = 'pickup',
  paid = true,
  generated = true,
  released = true,
  cancelled = false,
  createdAt,
} = {}) {
  const c = db.createCollection(name, { theme: 'anniversary', phone, email });
  db.setOrder(c.id, c.owner_token, { version });
  if (paid) db.markPaid(c.id, { method: 'pelecard' });
  if (generated) db.setProduction(c.id, { state: 'generated', pages: 208 });
  if (generated && released) db.setProductionReleased(c.id, true);
  const live = db.getCollection(c.id);
  if (cancelled) live.cancelled = true;
  if (createdAt) live.created_at = createdAt;
  return live;
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

const claim = (phone, extra = {}, ip) => post('/api/box-qr', { phone, ...extra }, ip);
const qrRowsFor = (id) =>
  db.listFriendCoupons({ source: 'qr' }).filter((r) => r.collection_id === id);

describe('the scan page API', () => {
  it('GET: open, with the owner’s words and today’s percent, and nothing about any order', async () => {
    const r = await get('/api/box-qr');
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('open');
    expect(r.body.percent).toBe(10);
    expect(r.body.expiry_months).toBe(6);
    expect(r.body.copy.title).toBe('תודה שבחרתם בדוגרי! מגיע לכם 10% הנחה לפעם הבאה');
    expect(r.body.copy.lead).toBe(
      'הקלידו את מספר הטלפון שאיתו הזמנתם, ותקבלו קוד אישי של 10% הנחה למשחק הבא. ' +
        'הקוד בתוקף ל-6 חודשים. ושוב תודה :)'
    );
    expect(r.body.copy.consent).toBe('אשמח לקבל מדוגרי עדכונים והטבות במייל');
    expect(r.body.copy.no_match).toContain('נסו את המספר שנתתם כשהזמנתם');
    // {email} is the page's to fill, with the masked address it is given.
    expect(r.body.copy.emailed).toContain('{email}');
  });

  it('a produced order’s number gets ONE code: on screen, and mailed to the ORDER’s address', async () => {
    const c = order({ phone: '052-727-5047', email: ' Hadar.Levi@Gmail.com' });
    // Typed the other way round from how it was stored.
    const r = await claim('+972 52 727 5047', { marketing_consent: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      created: true,
      emailed: true,
      email: 'ha***@gmail.com',
      percent: 10,
    });
    // Not read from the address: the prefix would spell out what the mask hides.
    expect(r.body.code).toMatch(/^DUGRI10(?:-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}){3}$/);
    expect(r.text).not.toContain('hadar.levi');
    expect(r.text).not.toContain(c.id);
    expect(r.text).not.toContain('שירה');

    const row = db.getFriendCouponByCode(r.body.code);
    expect(row).toMatchObject({
      source: 'qr',
      email: 'hadar.levi@gmail.com',
      collection_id: c.id,
      discount_percent: 10,
      marketing_consent: true,
    });
    expect(row.expires_at).toBe(rules.expiresAtForMonths(row.created_at, 6));

    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.to).toEqual(['hadar.levi@gmail.com']);
    expect(m.subject).toBe('הקוד שלכם מהקופסה של דוגרי');
    const link =
      BASE + '/?coupon=' + r.body.code + '&utm_source=coupon&utm_medium=email&utm_campaign=box_qr';
    expect(m.text).toContain('בונים משחק חדש: ' + link);
    expect(m.text).toMatch(/10% הנחה על המשחק הבא שלכם\. לשימוש אחד, בתוקף עד \d\d\.\d\d\.\d{4}\./);
    expect(m.text).not.toContain('שירה');
  });

  it('a number with no order: a neutral "not found", nothing issued, nothing mailed', async () => {
    const r = await claim(newPhone());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, found: false });
    expect(mails).toHaveLength(0);
  });

  it('unpaid, cancelled, unproduced and unreleased orders all answer exactly like no order', async () => {
    const cases = [
      order({ paid: false }),
      order({ cancelled: true }),
      order({ generated: false }),
      order({ released: false }),
    ];
    for (const c of cases) {
      const r = await claim(c.owner_phone);
      expect(r.body).toEqual({ ok: true, found: false });
      expect(qrRowsFor(c.id)).toHaveLength(0);
    }
    expect(mails).toHaveLength(0);
  });

  it('a PDF order counts once its PDF is released', async () => {
    settings.set('pricing', 'pdf_enabled', true);
    let pdf;
    try {
      pdf = order({ version: 'pdf', released: false });
    } finally {
      settings.reset('pricing', 'pdf_enabled');
    }
    expect(pdf.order.version).toBe('pdf');
    expect((await claim(pdf.owner_phone)).body).toEqual({ ok: true, found: false });
    db.setProductionReleased(pdf.id, true);
    const r = await claim(pdf.owner_phone);
    expect(r.body.created).toBe(true);
    expect(qrRowsFor(pdf.id)).toHaveLength(1);
  });

  it('one code per PRODUCED order, oldest first; then "all claimed" and the codes are never said again', async () => {
    const phone = newPhone();
    const newer = order({ phone, createdAt: '2026-10-20T10:00:00.000Z' });
    const older = order({ phone, createdAt: '2026-09-01T10:00:00.000Z' });
    // Same number, not produced: earns nothing, and does not count.
    const pending = order({ phone, generated: false, createdAt: '2026-08-01T10:00:00.000Z' });

    const first = await claim(phone);
    expect(first.body.created).toBe(true);
    expect(db.getFriendCouponByCode(first.body.code).collection_id).toBe(older.id);

    const second = await claim(phone.slice(0, 3) + '-' + phone.slice(3));
    expect(second.body.created).toBe(true);
    expect(db.getFriendCouponByCode(second.body.code).collection_id).toBe(newer.id);
    expect(second.body.code).not.toBe(first.body.code);

    mails = [];
    const third = await claim(phone);
    expect(third.status).toBe(200);
    expect(third.body).toEqual({ ok: true, all_claimed: true });
    expect(third.text).not.toContain(first.body.code);
    expect(third.text).not.toContain(second.body.code);
    expect(mails).toHaveLength(0);
    expect(qrRowsFor(pending.id)).toHaveLength(0);

    // A newly produced order of the same number earns its own code.
    db.setProduction(pending.id, { state: 'generated', pages: 208 });
    db.setProductionReleased(pending.id, true);
    const fourth = await claim(phone);
    expect(fourth.body.created).toBe(true);
    expect(db.getFriendCouponByCode(fourth.body.code).collection_id).toBe(pending.id);
  });

  it('two claims racing for one order: one code', async () => {
    const c = order();
    const [a, b] = await Promise.all([
      claim(c.owner_phone, {}, '10.88.0.1'),
      claim(c.owner_phone, {}, '10.88.0.2'),
    ]);
    expect([a, b].filter((r) => r.body.created)).toHaveLength(1);
    expect([a, b].filter((r) => r.body.all_claimed)).toHaveLength(1);
    expect(qrRowsFor(c.id)).toHaveLength(1);
  });

  it('an order with no email: the code is on screen, nothing is mailed, no address is shown', async () => {
    const c = order({ email: '' });
    const r = await claim(c.owner_phone);
    expect(r.body).toMatchObject({ created: true, emailed: false, email: null });
    expect(r.body.code).toMatch(/^DUGRI10-/);
    expect(mails).toHaveLength(0);
    expect(db.getFriendCouponByCode(r.body.code).marketing_consent).toBe(false);
  });

  it('consent is recorded only on a real true', async () => {
    const c = order();
    const r = await claim(c.owner_phone, { marketing_consent: 'yes' });
    expect(db.getFriendCouponByCode(r.body.code).marketing_consent).toBe(false);
  });

  it('an unticked box (consent false) is recorded as false', async () => {
    const c = order();
    const r = await claim(c.owner_phone, { marketing_consent: false });
    expect(r.body.created).toBe(true);
    expect(db.getFriendCouponByCode(r.body.code).marketing_consent).toBe(false);
  });

  it('not a phone number is a 400 and claims nothing', async () => {
    for (const phone of ['12', 'abc', '', undefined]) {
      expect((await post('/api/box-qr', { phone })).status).toBe(400);
    }
    expect((await post('/api/box-qr', { phone: ['0527275047'] })).status).toBe(400);
  });

  it('switched off: the page says so and no code is issued', async () => {
    const c = order();
    settings.set('box_qr', 'enabled', false);
    let look;
    let r;
    try {
      look = await get('/api/box-qr');
      r = await claim(c.owner_phone);
    } finally {
      settings.reset('box_qr', 'enabled');
    }
    expect(look.body.state).toBe('disabled');
    expect(r.status).toBe(403);
    expect(qrRowsFor(c.id)).toHaveLength(0);
  });

  it('percent and months are copied from the settings when the code is claimed', async () => {
    const c = order();
    settings.set('box_qr', 'percent', 15);
    settings.set('box_qr', 'expiry_months', 2);
    let r;
    try {
      r = await claim(c.owner_phone);
    } finally {
      settings.reset('box_qr', 'percent');
      settings.reset('box_qr', 'expiry_months');
    }
    expect(r.body.code).toMatch(/^DUGRI15-/);
    const row = db.getFriendCouponByCode(r.body.code);
    expect(row.discount_percent).toBe(15);
    expect(row.expires_at).toBe(rules.expiresAtForMonths(row.created_at, 2));
  });
});

describe('the rate limits', () => {
  it('five claims per client per hour, MISSES INCLUDED; a spoofed X-Forwarded-For does not reset it', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const ip = '203.0.113.' + i + ', 10.201.0.1';
      statuses.push((await claim(newPhone(), {}, ip)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    // Even a real produced order is refused to that client now…
    const c = order();
    expect((await claim(c.owner_phone, {}, '10.201.0.1')).status).toBe(429);
    expect(qrRowsFor(c.id)).toHaveLength(0);
    // …and another client is not affected.
    expect((await claim(c.owner_phone, {}, '10.201.0.2')).body.created).toBe(true);
  });

  it('five attempts per phone number per hour, from any number of clients, however it is typed', async () => {
    const phone = newPhone();
    const spellings = [
      phone,
      '+972' + phone.slice(1),
      phone.slice(0, 3) + '-' + phone.slice(3),
      '972' + phone.slice(1),
      phone,
      phone,
    ];
    const statuses = [];
    for (let i = 0; i < spellings.length; i++) {
      statuses.push((await claim(spellings[i], {}, '10.202.0.' + i)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    // The number's own produced order is locked out for the hour too.
    order({ phone });
    expect((await claim(phone, {}, '10.202.1.1')).status).toBe(429);
    // A different number is not.
    expect((await claim(newPhone(), {}, '10.202.1.2')).status).toBe(200);
  });
});

describe('at checkout', () => {
  async function qrCode() {
    const source = order();
    const r = await claim(source.owner_phone);
    return { code: r.body.code, source };
  }

  it('is refused on the order that earned it', async () => {
    const { code, source } = await qrCode();
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

  it('is taken however it is typed: any case, with or without its dashes', async () => {
    const { code } = await qrCode();
    const other = party();
    for (const typed of [
      code.toLowerCase(),
      code.replace(/-/g, ''),
      ' ' + code.replace(/-/g, ' '),
    ]) {
      const r = await post('/api/collections/' + other.id + '/coupon/validate', {
        owner_token: other.owner_token,
        code: typed,
      });
      expect(r.body).toEqual({ valid: true, discount_pct: 10 });
    }
    // …and charged as the code it is.
    const init = await post('/api/collections/' + other.id + '/pay/init', {
      owner_token: other.owner_token,
      version: 'pickup',
      coupon: code.replace(/-/g, '').toLowerCase(),
    });
    expect(init.status).toBe(200);
    expect(init.body.charged).toBe(Math.round(199 * 0.9));
    await settle(other.id);
    expect(db.getCollection(other.id).order.coupon).toBe(code);
    expect(db.getFriendCouponByCode(code).order_id).toBe(other.id);
  });

  it('is spent only when the next order is PAID; the order and the owner’s receipt say QR', async () => {
    const { code } = await qrCode();
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
    const o = db.getCollection(buyer.id).order;
    expect(o.paid).toBe(true);
    expect(o.coupon).toBe(code);
    expect(o.coupon_source).toBe('qr');
    const row = db.getFriendCouponByCode(code);
    expect(row.used_at).toBeTruthy();
    expect(row.order_id).toBe(buyer.id);

    const owner = mails.find(
      (m) => (m.to || []).includes('owner@example.com') && /קופון QR/.test(m.text || '')
    );
    expect(owner && owner.text).toContain('קופון QR מהקופסה: ' + code);

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
    const { code } = await qrCode();
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
    const { code } = await qrCode();
    const row = db.getFriendCouponByCode(code);
    expect(db.validateFriendCoupon(code, Date.parse(row.expires_at) - 1000).valid).toBe(true);
    expect(db.validateFriendCoupon(code, Date.parse(row.expires_at) + 1000)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });
});

describe('wrong guesses at the checkout', () => {
  // The miss limiter partner vouchers use (VOUCHER_MISS_LIMIT, 10 an hour per
  // client), shared by the preview and pay/init. beforeEach gives every test its
  // own client.
  const guess = () => 'DUGRI10-' + rules.makeQrCode(10).slice(8);

  it('ten wrong QR-shaped guesses at the preview, and the client is refused — even a real code', async () => {
    const { code } = (await claim(order().owner_phone)).body;
    const p = party();
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const r = await post('/api/collections/' + p.id + '/coupon/validate', {
        owner_token: p.owner_token,
        code: i % 2 ? guess().toLowerCase().replace(/-/g, '') : guess(),
      });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
    const real = await post('/api/collections/' + p.id + '/coupon/validate', {
      owner_token: p.owner_token,
      code,
    });
    expect(real.status).toBe(429);
    // …and pay/init shares the wall.
    const init = await post('/api/collections/' + p.id + '/pay/init', {
      owner_token: p.owner_token,
      version: 'pickup',
      coupon: code,
    });
    expect(init.status).toBe(429);
  });

  it('friend-shaped misses count too, and pay/init counts them for the preview', async () => {
    const p = party();
    for (let i = 0; i < 10; i++) {
      const r = await post('/api/collections/' + p.id + '/pay/init', {
        owner_token: p.owner_token,
        version: 'pickup',
        coupon: 'NOA5-' + rules.makeQrCode(5).slice(7, 11),
      });
      expect(r.status).toBe(400);
    }
    const r = await post('/api/collections/' + p.id + '/coupon/validate', {
      owner_token: p.owner_token,
      code: 'NOA5-K7Q2',
    });
    expect(r.status).toBe(429);
  });

  it('a mistyped OWNER coupon is not a personal-code guess and never meets the wall', async () => {
    const p = party();
    for (let i = 0; i < 12; i++) {
      const r = await post('/api/collections/' + p.id + '/coupon/validate', {
        owner_token: p.owner_token,
        code: 'SUMMER1' + (i % 10),
      });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ valid: false, reason: 'not_found' });
    }
  });
});

describe('one shop, one namespace of codes', () => {
  it('a QR code is minted around every code another kind already holds', () => {
    const c = order();
    expect(db.createCoupon({ code: 'DUGRI10AAAAAAAAAAAA', discount_pct: 10 }).error).toBe(
      undefined
    );
    // Force the random part: the first draw collides with that owner coupon's
    // compact form, the second does not.
    const seq = [...Array(12).fill(0), ...Array(12).fill(1)];
    const real = require('crypto').randomInt;
    const spy = vi
      .spyOn(require('crypto'), 'randomInt')
      .mockImplementation((n) => (seq.length ? seq.shift() : real(n)));
    let r;
    try {
      r = db.claimQrCouponForPhone({ phone: c.owner_phone, percent: 10, expiryMonths: 6 });
    } finally {
      spy.mockRestore();
    }
    expect(r.coupon.code).toBe('DUGRI10-BBBB-BBBB-BBBB');
  });

  it('an owner coupon cannot take a personal code’s compact form', async () => {
    const c = order();
    const r = await claim(c.owner_phone);
    const compact = r.body.code.replace(/-/g, '');
    expect(db.createCoupon({ code: compact, discount_pct: 50 })).toEqual({ error: 'duplicate' });
  });

  it('a box code does not use up the friend offer for that email', async () => {
    const c = order({ email: 'both@x.co' });
    await claim(c.owner_phone);
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

describe('the stickers carry none of it', () => {
  const lastBatch = () => JSON.parse(fs.readFileSync(path.join(captureDir, 'last.json'), 'utf8'));

  it('a label is exactly the facts it was before the box QR: no QR, no line, no token on the order', async () => {
    // Only this test's order on tonight's sheet: everything else "sent to print".
    for (const x of db.listAllCollections())
      if (x.order && x.order.paid) db.setOrderSentToPrint(x.id, true);
    const c = order({ phone: '0527275047', name: 'שירה' });
    const res = await realFetch(base + '/api/admin/stickers?key=' + ADMIN_KEY);
    expect(res.status).toBe(200);
    const batch = lastBatch();
    expect(batch).toHaveLength(1);
    expect(Object.keys(batch[0]).sort()).toEqual(
      ['buyer_name', 'design', 'order_no', 'phone', 'title'].sort()
    );
    expect(batch[0].phone).toBe('0527275047');
    expect(db.getCollection(c.id).order.box_qr).toBeUndefined();
    db.setOrderSentToPrint(c.id, true);
  });
});

describe('the admin', () => {
  it('the coupons page’s QR section: its own rows (with the source order), summary and settings', async () => {
    const c = order({ email: 'adminlist@x.co' });
    const r = await claim(c.owner_phone);
    const list = await get(key('/api/admin/friend-coupons?source=qr&q=adminlist'));
    expect(list.status).toBe(200);
    expect(list.body.coupons).toHaveLength(1);
    expect(list.body.coupons[0]).toMatchObject({
      code: r.body.code,
      source: 'qr',
      box_order_no: db.orderRef(c),
    });
    expect(list.body.summary).toEqual(
      expect.objectContaining({ enabled: true, percent: 10, expiry_months: 6 })
    );
    expect(list.body.summary).not.toHaveProperty('delivery_label');
    expect(list.body.summary.issued).toBe(db.listFriendCoupons({ source: 'qr' }).length);
    const friends = await get(key('/api/admin/friend-coupons?q=adminlist'));
    expect(friends.body.coupons).toHaveLength(0);
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

  it('the static QR to download decodes to /box on PUBLIC_BASE_URL; owner key only', async () => {
    const r = await get(key('/api/admin/box-qr'));
    expect(r.status).toBe(200);
    expect(r.body.url).toBe(BASE + '/box');
    expect(decodeSvg(r.body.svg)).toBe(BASE + '/box');
    for (const p of ['/api/admin/box-qr', '/api/admin/BOX-QR', '/api/admin/box-qr/']) {
      expect((await get(key(p, STAFF_KEY))).status).toBe(403);
    }
    expect((await get('/api/admin/box-qr')).status).toBe(403);
  });

  it('no PUBLIC_BASE_URL, no QR', async () => {
    const was = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      expect((await get(key('/api/admin/box-qr'))).status).toBe(409);
    } finally {
      process.env.PUBLIC_BASE_URL = was;
    }
  });

  it('the staff key sees no QR list and no coupon source in the orders list', async () => {
    const source = order();
    const { code } = (await claim(source.owner_phone)).body;
    const buyer = party('קונה לצוות');
    await post('/api/collections/' + buyer.id + '/pay/init', {
      owner_token: buyer.owner_token,
      version: 'pickup',
      coupon: code,
    });
    await settle(buyer.id);
    expect((await get(key('/api/admin/friend-coupons?source=qr', STAFF_KEY))).status).toBe(403);
    const staff = await get(key('/api/admin/collections', STAFF_KEY));
    expect(staff.status).toBe(200);
    expect(staff.text).not.toContain(code);
    expect(staff.text).not.toContain('coupon_source');
    const owner = await get(key('/api/admin/collections'));
    const paid = owner.body.collections.find((x) => x.id === buyer.id);
    expect(paid.order.coupon_source).toBe('qr');
  });
});
