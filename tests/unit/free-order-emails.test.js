// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boots the real Express app with PeleCard creds, ADMIN_KEY, AND Resend config
// so notify.isConfigured() is true and the paid-transition emails actually fire.
// notify sends over the Resend HTTPS API (global fetch), which is stubbed so
// nothing leaves the machine; every sent message is captured so we can assert
// who it went to and the amount it shows. This covers the "free (100%-coupon)
// order sends emails showing 0, not the full package price" behavior and guards
// the no-coupon path against regression.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
const realFetch = globalThis.fetch;

let app;
let db;
let server;
let base;

let nextInit = null;
let nextGetTx = null;
const sent = []; // { to, subject, text } for every Resend email the app sent

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-free-emails-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  process.env.ADMIN_KEY = ADMIN_KEY;
  // Resend config so notify goes live (dormant otherwise).
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.NOTIFY_TO = 'owner@dugri.example';
  process.env.NOTIFY_FROM = 'Dugri <orders@dugri.example>';

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  // Charge path gates on per-version enable flags (only pickup on by default);
  // these tests pay for pdf, so enable every version for this data dir.
  delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));

  // Stub the global fetch used for BOTH PeleCard calls and the Resend email
  // API. Resend requests are captured (never actually sent) so we can assert
  // recipient + amount for each email.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('/PaymentGW/init')) return jsonRes(nextInit);
      if (u.includes('/PaymentGW/GetTransaction')) return jsonRes(nextGetTx);
      if (u.includes('api.resend.com')) {
        const msg = opts && opts.body ? JSON.parse(opts.body) : {};
        sent.push({
          to: Array.isArray(msg.to) ? msg.to[0] : msg.to,
          subject: msg.subject,
          text: msg.text,
        });
        return { ok: true, status: 200, text: async () => '{"id":"stub"}' };
      }
      throw new Error('unexpected fetch ' + u);
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
  vi.restoreAllMocks();
  if (server) server.close();
});

beforeEach(() => {
  sent.length = 0;
  nextInit = {
    URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=tx-1',
    Error: { ErrCode: 0 },
  };
  nextGetTx = null;
});

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const key = (p) => `${p}?key=${ADMIN_KEY}`;

// The emails are fire-and-forget (not awaited by the route), so poll briefly
// until the expected number of messages has been captured.
async function waitForMails(n, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (sent.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return sent;
}

describe('free (100%-coupon) order emails', () => {
  it('fires owner + buyer emails, both showing 0/free — NOT the full package price', async () => {
    await post(key('/api/admin/coupons'), { code: 'FREEMAIL', discount_pct: 100 });
    const c = db.createCollection('חינם מייל', { email: 'buyer@example.com' });

    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf', // 79 NIS package
      coupon: 'freemail',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ free: true, paid: true, total: 0 });

    const mails = await waitForMails(2);
    expect(mails.length).toBe(2);

    const owner = mails.find((m) => m.subject.includes('התקבל תשלום'));
    const buyer = mails.find((m) => m.subject.includes('ההזמנה שלכם התקבלה'));
    expect(owner).toBeTruthy();
    expect(buyer).toBeTruthy();

    // Owner email goes to NOTIFY_TO; buyer email goes to the customer.
    expect(owner.to).toBe('owner@dugri.example');
    expect(buyer.to).toBe('buyer@example.com');

    // Both must convey FREE (0 ₪, 100%-coupon note) and never the 79 ₪ price.
    for (const m of [owner, buyer]) {
      expect(m.text).toContain('0 ₪');
      expect(m.text).toContain('קופון 100%');
      expect(m.text).not.toContain('79 ₪');
    }
  });
});

describe('paid (PeleCard) order emails — no regression', () => {
  it('a no-coupon order emails the FULL amount', async () => {
    const c = db.createCollection('בלי קופון מייל', { email: 'buyer2@example.com' });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf', // 79
    });
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
    const cb = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(cb.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(true);

    const mails = await waitForMails(2);
    const owner = mails.find((m) => m.subject.includes('התקבל תשלום'));
    const buyer = mails.find((m) => m.subject.includes('ההזמנה שלכם התקבלה'));
    for (const m of [owner, buyer]) {
      expect(m.text).toContain('79 ₪');
      expect(m.text).not.toContain('קופון 100%');
    }
  });

  it('a partial-coupon order emails the DISCOUNTED amount (not the full total)', async () => {
    await post(key('/api/admin/coupons'), { code: 'HALFMAIL', discount_pct: 50 }); // 79 -> 40
    const c = db.createCollection('קופון חצי מייל', { email: 'buyer3@example.com' });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
      coupon: 'HALFMAIL',
    });
    const token = db.getCollection(c.id).order.pelecard.sessions[0].token;
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '000',
        AdditionalDetailsParamX: token,
        DebitTotal: 4000,
        DebitApproveNumber: '86-001-007',
      },
    };
    const cb = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(cb.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(true);

    const mails = await waitForMails(2);
    const owner = mails.find((m) => m.subject.includes('התקבל תשלום'));
    const buyer = mails.find((m) => m.subject.includes('ההזמנה שלכם התקבלה'));
    for (const m of [owner, buyer]) {
      expect(m.text).toContain('40 ₪');
      expect(m.text).not.toContain('79 ₪');
      expect(m.text).not.toContain('קופון 100%');
    }
  });
});
