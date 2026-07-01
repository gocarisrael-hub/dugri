// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boot the real Express app with PeleCard credentials set so the pay routes are
// live, but stub global fetch so no request reaches the real gateway. The stub
// routes by URL: /PaymentGW/init and /PaymentGW/GetTransaction get separate,
// per-test responses.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// Captured before stubbing so the test's own HTTP client keeps the real fetch.
const realFetch = globalThis.fetch;

let app;
let db;
let notify;
let server;
let base;

// Per-test control of the mocked gateway responses.
let nextInit = null;
let nextGetTx = null; // object to return, or 'THROW' to simulate a transport error

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pay-'));
  process.env.PELECARD_TERMINAL = '0962210';
  process.env.PELECARD_USER = 'peletest';
  process.env.PELECARD_PASSWORD = 'secret';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  for (const f of ['db.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  notify = require(path.join(serverDir, 'notify.js'));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/PaymentGW/init')) return jsonRes(nextInit);
      if (u.includes('/PaymentGW/GetTransaction')) {
        if (nextGetTx === 'THROW') throw new Error('network');
        return jsonRes(nextGetTx);
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
  if (server) server.close();
});

beforeEach(() => {
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
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(urlPath) {
  const res = await realFetch(base + urlPath);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function tokenOf(id) {
  return db.getCollection(id).order.pelecard.sessions[0].token;
}

describe('POST /api/collections/:id/pay/init', () => {
  it('returns the iframe url and records a ParamX token', async () => {
    const c = db.createCollection('בדיקת תשלום');
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(r.status).toBe(200);
    expect(r.body.url).toContain('transactionId=tx-1');
    expect(r.body.total).toBe(79);
    const sessions = db.getCollection(c.id).order.pelecard.sessions;
    expect(sessions.length).toBe(1);
    expect(sessions[0].token.length).toBeLessThanOrEqual(19);
  });

  it('rejects a wrong owner token', async () => {
    const c = db.createCollection('בדיקה');
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: 'nope',
      version: 'pdf',
    });
    expect(r.status).toBe(403);
  });

  it('does not re-open (or wipe) an order that is already paid', async () => {
    const c = db.createCollection('כבר שולם');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    db.markPaid(c.id, { method: 'pelecard', transactionId: 'tx-paid' });
    const r = await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(r.status).toBe(409);
    expect(db.getCollection(c.id).order.paid).toBe(true);
    expect(db.getCollection(c.id).order.paid_transaction_id).toBe('tx-paid');
  });

  it('accumulates ParamX tokens across repeated inits (same version)', async () => {
    const c = db.createCollection('שתי פתיחות');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    expect(db.getCollection(c.id).order.pelecard.sessions.length).toBe(2);
  });
});

describe('POST /api/payment/callback', () => {
  it('verifies via GetTransaction and marks the order paid', async () => {
    const c = db.createCollection('בדיקת קולבק');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    const token = tokenOf(c.id);
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

    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(200);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(order.paid_method).toBe('pelecard');
    expect(order.paid_transaction_id).toBe('tx-1');
    expect(order.paid_approval_no).toBe('86-001-006');
  });

  it('does NOT mark paid when SHVA did not approve the charge (ShvaResult != 000)', async () => {
    const c = db.createCollection('לא אושר');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '004',
        AdditionalDetailsParamX: token,
        DebitTotal: 7900,
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('still correlates a delivery payment after the order is re-set (token preserved)', async () => {
    const c = db.createCollection('משלוח');
    const addr = { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' };
    // First init (delivery), then a second init that re-sets the same order.
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: addr,
    });
    const firstToken = db.getCollection(c.id).order.pelecard.sessions[0].token;
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: addr,
    });
    // The first session's token must have survived the re-set.
    expect(db.getCollection(c.id).order.pelecard.sessions.map((s) => s.token)).toContain(
      firstToken
    );

    // Completing payment on the FIRST session still marks the order paid.
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-d',
        ShvaResult: '000',
        AdditionalDetailsParamX: firstToken,
        DebitTotal: 19900,
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-d' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(true);
  });

  it('does NOT mark paid when GetTransaction reports a foreign/unknown token (forgery)', async () => {
    const c = db.createCollection('זיוף');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-x',
        ShvaResult: '000',
        AdditionalDetailsParamX: 'someoneelsetoken',
        DebitTotal: 7900,
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-x' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('does NOT mark paid when the charged amount does not match', async () => {
    const c = db.createCollection('סכום שגוי');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-1',
        ShvaResult: '000',
        AdditionalDetailsParamX: token,
        DebitTotal: 100,
      },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('does NOT mark paid on a non-success transaction status', async () => {
    const c = db.createCollection('סטטוס שגוי');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '004',
      ResultData: { TransactionId: 'tx-1', AdditionalDetailsParamX: token, DebitTotal: 7900 },
    };
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('returns 502 (for a PeleCard retry) when verification transiently fails', async () => {
    const c = db.createCollection('כשל זמני');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    nextGetTx = 'THROW';
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-1' } });
    expect(r.status).toBe(502);
    expect(db.getCollection(c.id).order.paid).toBe(false);
  });

  it('ignores a callback with no TransactionId', async () => {
    const r = await post('/api/payment/callback', { ResultData: {} });
    expect(r.status).toBe(200);
  });

  it('still marks paid + returns success even when the notify send rejects', async () => {
    const c = db.createCollection('כשל מייל');
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'pdf',
    });
    const token = tokenOf(c.id);
    nextGetTx = {
      StatusCode: '000',
      ResultData: {
        TransactionId: 'tx-mail',
        ShvaResult: '000',
        AdditionalDetailsParamX: token,
        DebitTotal: 7900,
      },
    };
    // Email is configured (so the route attempts a send) but the send rejects —
    // the payment must succeed regardless.
    const cfg = vi.spyOn(notify, 'isConfigured').mockReturnValue(true);
    const spy = vi.spyOn(notify, 'sendOrderPaid').mockRejectedValue(new Error('smtp down'));
    const r = await post('/api/payment/callback', { ResultData: { TransactionId: 'tx-mail' } });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).order.paid).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    cfg.mockRestore();
  });
});

describe('POST /api/collections/:id/close (idempotent, single notify)', () => {
  it('rejects a wrong/absent owner token with 403', async () => {
    const c = db.createCollection('סגירה');
    const r = await post('/api/collections/' + c.id + '/close', { owner_token: 'nope' });
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).status).toBe('open');
  });

  it('a repeated close returns 200 but fires sendOrderFinished only on the real transition', async () => {
    const c = db.createCollection('סגירה כפולה');
    // Email configured so the route attempts a send; count sends across closes.
    const cfg = vi.spyOn(notify, 'isConfigured').mockReturnValue(true);
    const spy = vi.spyOn(notify, 'sendOrderFinished').mockResolvedValue(true);

    const first = await post('/api/collections/' + c.id + '/close', {
      owner_token: c.owner_token,
    });
    expect(first.status).toBe(200);
    expect(db.getCollection(c.id).status).toBe('closed');
    expect(spy).toHaveBeenCalledTimes(1);

    // Second close (double-click/retry): still 200, but NO second email.
    const second = await post('/api/collections/' + c.id + '/close', {
      owner_token: c.owner_token,
    });
    expect(second.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
    cfg.mockRestore();
  });
});

describe('publicView gender', () => {
  it("exposes the honoree gender from createCollection ('male'/'female'/null)", async () => {
    const c = db.createCollection('שירה', { gender: 'female' });
    const r = await get('/api/collections/' + c.id);
    expect(r.status).toBe(200);
    expect(r.body.gender).toBe('female');

    const c2 = db.createCollection('בלי מגדר');
    const r2 = await get('/api/collections/' + c2.id);
    expect(r2.body.gender).toBe(null);
  });
});
