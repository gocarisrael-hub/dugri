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

function tokenOf(id) {
  return db.getCollection(id).order.pelecard.param_tokens[0];
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
    const tokens = db.getCollection(c.id).order.pelecard.param_tokens;
    expect(tokens.length).toBe(1);
    expect(tokens[0].length).toBeLessThanOrEqual(19);
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
    expect(db.getCollection(c.id).order.pelecard.param_tokens.length).toBe(2);
  });

  it("logs PeleCard's init failure reason on a 502 only when PELECARD_DEBUG=1", async () => {
    const c = db.createCollection('כשל init');
    // PeleCard rejects the init: empty URL + an Error object (ErrCode != 0).
    nextInit = { URL: '', ConfirmationKey: '', Error: { ErrCode: 101, ErrMsg: 'bad terminal' } };
    const body = { owner_token: c.owner_token, version: 'pdf' };

    // debug OFF: the 502 is returned but nothing is logged.
    const off = vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.PELECARD_DEBUG;
    let r = await post('/api/collections/' + c.id + '/pay/init', body);
    expect(r.status).toBe(502);
    expect(
      off.mock.calls.find((l) => String(l[0]).includes('[pelecard init] failed'))
    ).toBeUndefined();
    off.mockRestore();

    // debug ON: PeleCard's own ErrCode + ErrMsg are surfaced to the logs.
    const on = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.PELECARD_DEBUG = '1';
    r = await post('/api/collections/' + c.id + '/pay/init', body);
    expect(r.status).toBe(502);
    const line = on.mock.calls.find((l) => String(l[0]).includes('[pelecard init] failed'));
    expect(line).toBeTruthy();
    expect(line.join(' ')).toContain('101');
    expect(line.join(' ')).toContain('bad terminal');
    on.mockRestore();
    delete process.env.PELECARD_DEBUG;
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
    const firstToken = db.getCollection(c.id).order.pelecard.param_tokens[0];
    await post('/api/collections/' + c.id + '/pay/init', {
      owner_token: c.owner_token,
      version: 'delivery',
      address: addr,
    });
    // The first session's token must have survived the re-set.
    expect(db.getCollection(c.id).order.pelecard.param_tokens).toContain(firstToken);

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
});
