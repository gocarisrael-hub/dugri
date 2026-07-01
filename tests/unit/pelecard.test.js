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
