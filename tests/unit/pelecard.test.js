// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// server/pelecard.js captures the PELECARD_* env vars at require time, so each
// test loads a fresh copy after setting (or clearing) the environment.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, '..', '..', 'server', 'pelecard.js');

function loadFresh() {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

const CREDS = {
  PELECARD_TERMINAL: '0962210',
  PELECARD_USER: 'peletest',
  PELECARD_PASSWORD: 'secret',
};

function setCreds(on) {
  for (const k of Object.keys(CREDS)) {
    if (on) process.env[k] = CREDS[k];
    else delete process.env[k];
  }
}

function jsonRes(obj) {
  return { ok: true, status: 200, json: async () => obj };
}

afterEach(() => {
  setCreds(false);
  delete process.env.PELECARD_BASE_URL;
  vi.unstubAllGlobals();
});

describe('isConfigured', () => {
  it('is false when credentials are missing', () => {
    setCreds(false);
    expect(loadFresh().isConfigured()).toBe(false);
  });

  it('is true when all three credentials are present', () => {
    setCreds(true);
    expect(loadFresh().isConfigured()).toBe(true);
  });
});

describe('transactionIdFromUrl', () => {
  it('extracts the transactionId query param', () => {
    const p = loadFresh();
    expect(
      p.transactionIdFromUrl('https://gateway21.pelecard.biz/PaymentGW?transactionId=abc-123')
    ).toBe('abc-123');
    expect(p.transactionIdFromUrl('https://x/y?foo=1&transactionId=zzz&bar=2')).toBe('zzz');
    expect(p.transactionIdFromUrl('https://x/y')).toBe(null);
  });
});

describe('init', () => {
  beforeEach(() => setCreds(true));

  it('posts to gateway21 with agorot + a truncated ParamX and returns url + transactionId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({
        URL: 'https://gateway21.pelecard.biz/PaymentGW?transactionId=tx-9',
        Error: { ErrCode: 0 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await loadFresh().init({
      amountNis: 79,
      paramToken: 'abcdef0123456789extra', // longer than 19
      urls: {
        goodUrl: 'https://dugri.example/pay-done.html',
        errorUrl: 'https://dugri.example/pay-done.html?error=1',
        serverGoodUrl: 'https://dugri.example/api/payment/callback',
        serverErrorUrl: 'https://dugri.example/api/payment/callback?error=1',
      },
    });

    expect(out.url).toContain('transactionId=tx-9');
    expect(out.transactionId).toBe('tx-9');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway21.pelecard.biz/PaymentGW/init');
    const body = JSON.parse(opts.body);
    expect(body.Total).toBe(7900);
    expect(body.Currency).toBe(1);
    expect(body.ActionType).toBe('J4');
    expect(body.terminal).toBe(CREDS.PELECARD_TERMINAL);
    expect(body.ServerSideFeedbackContentType).toBe('application/json');
    expect(body.ParamX.length).toBeLessThanOrEqual(19); // truncated to PeleCard's limit
    expect('abcdef0123456789extra'.startsWith(body.ParamX)).toBe(true);
  });

  it('throws when PeleCard returns an error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonRes({ Error: { ErrCode: 101, ErrMsg: 'bad terminal' } }))
    );
    await expect(loadFresh().init({ amountNis: 79, paramToken: 'x', urls: {} })).rejects.toThrow(
      /101/
    );
  });

  it('rejects a non-positive amount before calling the gateway', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadFresh().init({ amountNis: 0, paramToken: 'x', urls: {} })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getTransaction', () => {
  beforeEach(() => setCreds(true));

  it('posts terminal creds + TransactionId and normalizes the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({
        StatusCode: '000',
        ErrorMessage: 'operation success',
        ResultData: {
          TransactionId: 'tx-77',
          ShvaResult: '000',
          AdditionalDetailsParamX: 'token123',
          DebitTotal: '7900',
          DebitApproveNumber: '86-001-006',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const tx = await loadFresh().getTransaction('tx-77');
    expect(tx.statusCode).toBe('000');
    expect(tx.shvaResult).toBe('000');
    expect(tx.paramX).toBe('token123');
    expect(tx.debitTotalAgorot).toBe(7900);
    expect(tx.approvalNo).toBe('86-001-006');
    expect(tx.transactionId).toBe('tx-77');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway21.pelecard.biz/PaymentGW/GetTransaction');
    const body = JSON.parse(opts.body);
    expect(body.terminal).toBe(CREDS.PELECARD_TERMINAL);
    expect(body.TransactionId).toBe('tx-77');
  });

  // TWO DIFFERENT IDENTIFIERS, and a disputes letter cites the one we were
  // throwing away. Isracard's ביטול עסקה letters name a charge by מס' שובר
  // (VoucherId); `DebitApproveNumber || VoucherId` kept only the approve number
  // whenever one existed, which is 307 of 312 paid orders — so a chargeback could
  // not be matched to an order at all, and date+amount is not discriminating
  // (239 ₪ on one day gave 40 candidates). Backfill is impossible: whatever the
  // callback did not store is gone. They must be stored separately.
  it('keeps the voucher number and the approval number apart', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-88',
          ShvaResult: '000',
          AdditionalDetailsParamX: 'token123',
          DebitTotal: '19900',
          DebitApproveNumber: '86-001-006',
          VoucherId: '4001003',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const tx = await loadFresh().getTransaction('tx-88');
    expect(tx.approvalNo).toBe('86-001-006');
    expect(tx.voucherNo).toBe('4001003');
  });

  // The other direction: with no approve number, the voucher must NOT be
  // promoted into the approval field. That promotion is what made the two
  // indistinguishable after the fact — a stored value nobody could say the
  // meaning of. Absent is honest; mislabelled is not.
  it('does not pass a voucher number off as an approval number', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({
        StatusCode: '000',
        ResultData: {
          TransactionId: 'tx-89',
          ShvaResult: '000',
          AdditionalDetailsParamX: 'token123',
          DebitTotal: '19900',
          VoucherId: '1001018',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const tx = await loadFresh().getTransaction('tx-89');
    expect(tx.voucherNo).toBe('1001018');
    expect(tx.approvalNo).toBe(null);
  });

  it('throws when no transactionId is given', async () => {
    await expect(loadFresh().getTransaction('')).rejects.toThrow();
  });
});

describe('parseCallback', () => {
  it('reads the TransactionId from nested ResultData', () => {
    const p = loadFresh().parseCallback({
      StatusCode: '000',
      ResultData: { TransactionId: 'tx-5', AdditionalDetailsParamX: 'tok' },
    });
    expect(p.transactionId).toBe('tx-5');
    expect(p.paramX).toBe('tok');
  });

  it('reads a top-level PelecardTransactionId too', () => {
    const p = loadFresh().parseCallback({ PelecardTransactionId: 'tx-6' });
    expect(p.transactionId).toBe('tx-6');
  });
});

describe('verifyTransaction (fail-closed)', () => {
  let p;
  beforeEach(() => {
    p = loadFresh();
  });

  const ok = { statusCode: '000', shvaResult: '000', debitTotalAgorot: 7900 };

  it('accepts success status + SHVA approval + matching amount', () => {
    expect(p.verifyTransaction(ok, { amountNis: 79 })).toBe(true);
  });

  it('rejects a non-success retrieval status', () => {
    expect(p.verifyTransaction({ ...ok, statusCode: '004' }, { amountNis: 79 })).toBe(false);
  });

  it('rejects when the charge was not approved by SHVA (ShvaResult != 000)', () => {
    expect(p.verifyTransaction({ ...ok, shvaResult: '004' }, { amountNis: 79 })).toBe(false);
    expect(p.verifyTransaction({ ...ok, shvaResult: null }, { amountNis: 79 })).toBe(false);
  });

  it('rejects a mismatched amount', () => {
    expect(p.verifyTransaction({ ...ok, debitTotalAgorot: 100 }, { amountNis: 79 })).toBe(false);
  });

  it('rejects when amount is missing', () => {
    expect(p.verifyTransaction({ ...ok, debitTotalAgorot: null }, { amountNis: 79 })).toBe(false);
    expect(p.verifyTransaction(ok, {})).toBe(false);
  });
});

// WHY it refused, not just that it did. The callback answers PeleCard 200 and
// settles nothing when verification fails, so without a reason the owner's only
// evidence is an order that never went paid. A card DECLINE is routine and is the
// answer to "why is this unpaid"; a wrong AMOUNT is not routine at all. One line
// for both would be the categorical log that gets ignored by the third week.
describe('verifyFailure (the reason verifyTransaction refused)', () => {
  let p;
  beforeEach(() => {
    p = loadFresh();
  });

  const ok = { statusCode: '000', shvaResult: '000', debitTotalAgorot: 7900 };

  // BOUND BY CONSTRUCTION. verifyTransaction delegates to verifyFailure, so a
  // reason exists exactly when verification fails — there is no second copy of
  // the rules to drift out of step (the failure mode item 16 of the follow-ups
  // queue exists for, and the one the fee/charge formulas already have).
  it('names a reason exactly when verifyTransaction refuses', () => {
    const cases = [
      [ok, { amountNis: 79 }],
      [{ ...ok, statusCode: '004' }, { amountNis: 79 }],
      [{ ...ok, shvaResult: '004' }, { amountNis: 79 }],
      [{ ...ok, shvaResult: null }, { amountNis: 79 }],
      [{ ...ok, debitTotalAgorot: 100 }, { amountNis: 79 }],
      [{ ...ok, debitTotalAgorot: null }, { amountNis: 79 }],
      [ok, {}],
      [null, { amountNis: 79 }],
    ];
    for (const [tx, expected] of cases) {
      expect(p.verifyFailure(tx, expected) === null).toBe(p.verifyTransaction(tx, expected));
    }
  });

  it('tells a decline apart from a wrong amount', () => {
    expect(p.verifyFailure({ ...ok, shvaResult: '004' }, { amountNis: 79 })).toBe('declined');
    expect(p.verifyFailure({ ...ok, debitTotalAgorot: 100 }, { amountNis: 79 })).toBe(
      'amount_mismatch'
    );
    expect(p.verifyFailure({ ...ok, statusCode: '004' }, { amountNis: 79 })).toBe('lookup_status');
    expect(p.verifyFailure({ ...ok, debitTotalAgorot: null }, { amountNis: 79 })).toBe('no_amount');
    expect(p.verifyFailure(ok, { amountNis: 79 })).toBe(null);
  });
});

// A LOG LINE IS A PLACE A SECRET CAN ESCAPE TO. Every error message on these
// paths is about to be logged, and getTransaction POSTs the terminal password in
// its request body — so the guarantee has to hold at the SOURCE, not in the
// caller's discipline. Checked against a sentinel rather than the fixture's
// 'secret', which is a word ordinary prose could contain by accident.
describe('thrown errors carry no credentials', () => {
  const SENTINEL = 'pw-sentinel-must-never-be-logged';

  beforeEach(() => {
    process.env.PELECARD_TERMINAL = CREDS.PELECARD_TERMINAL;
    process.env.PELECARD_USER = CREDS.PELECARD_USER;
    process.env.PELECARD_PASSWORD = SENTINEL;
  });

  it('keeps the password out of an http failure, a gateway error and a transport failure', async () => {
    const p = loadFresh();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    );
    const httpErr = await p.init({ amountNis: 79, paramToken: 'x', urls: {} }).catch((e) => e);
    expect(String(httpErr && httpErr.message)).not.toContain(SENTINEL);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonRes({ Error: { ErrCode: 101, ErrMsg: 'bad terminal' } }))
    );
    const gatewayErr = await p.init({ amountNis: 79, paramToken: 'x', urls: {} }).catch((e) => e);
    expect(String(gatewayErr && gatewayErr.message)).not.toContain(SENTINEL);
    expect(String(gatewayErr && gatewayErr.message)).toContain('101'); // still discriminating

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const txErr = await p.getTransaction('tx-1').catch((e) => e);
    expect(String(txErr && txErr.message)).not.toContain(SENTINEL);
  });
});
