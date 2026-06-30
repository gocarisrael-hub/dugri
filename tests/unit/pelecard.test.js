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
  PELECARD_TERMINAL: '0962475',
  PELECARD_USER: 'webuser',
  PELECARD_PASSWORD: 'secret',
};

function setCreds(on) {
  for (const k of Object.keys(CREDS)) {
    if (on) process.env[k] = CREDS[k];
    else delete process.env[k];
  }
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

describe('init', () => {
  beforeEach(() => setCreds(true));

  it('posts agorot + credentials and returns the iframe url and confirmation key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        URL: 'https://gateway20.pelecard.biz/PaymentGW?transactionId=abc',
        ConfirmationKey: 'CK-123',
        Error: { ErrCode: 0 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const pelecard = loadFresh();
    const out = await pelecard.init({
      amountNis: 79,
      paramX: 'col-1',
      urls: {
        goodUrl: 'https://dugri.example/pay-done.html',
        errorUrl: 'https://dugri.example/pay-done.html?error=1',
        serverGoodUrl: 'https://dugri.example/api/payment/callback',
        serverErrorUrl: 'https://dugri.example/api/payment/callback?error=1',
      },
    });

    expect(out.url).toContain('transactionId=abc');
    expect(out.confirmationKey).toBe('CK-123');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway20.pelecard.biz/PaymentGW/init');
    const body = JSON.parse(opts.body);
    expect(body.Total).toBe(7900); // 79 NIS in agorot
    expect(body.Currency).toBe(1);
    expect(body.terminal).toBe(CREDS.PELECARD_TERMINAL);
    expect(body.ParamX).toBe('col-1');
    expect(body.ServerSideGoodFeedbackURL).toBe('https://dugri.example/api/payment/callback');
  });

  it('throws when PeleCard returns an error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ Error: { ErrCode: 101, ErrMsg: 'bad terminal' } }),
      })
    );
    await expect(loadFresh().init({ amountNis: 79, paramX: 'x', urls: {} })).rejects.toThrow(/101/);
  });

  it('rejects a non-positive amount before calling the gateway', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadFresh().init({ amountNis: 0, paramX: 'x', urls: {} })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseCallback', () => {
  it('reads top-level fields', () => {
    const p = loadFresh().parseCallback({
      PelecardStatusCode: '000',
      PelecardTransactionId: 'tx9',
      ParamX: 'col-7',
      ConfirmationKey: 'CK-9',
      TotalX100: '7900',
    });
    expect(p.statusCode).toBe('000');
    expect(p.transactionId).toBe('tx9');
    expect(p.paramX).toBe('col-7');
    expect(p.confirmationKey).toBe('CK-9');
    expect(p.totalX100).toBe(7900);
  });

  it('reads fields nested under ResultData', () => {
    const p = loadFresh().parseCallback({
      ResultData: { PelecardStatusCode: '000', ParamX: 'col-8', ConfirmationKey: 'CK-8' },
    });
    expect(p.statusCode).toBe('000');
    expect(p.paramX).toBe('col-8');
    expect(p.confirmationKey).toBe('CK-8');
  });
});

describe('verifyCallback (fail-closed)', () => {
  let pelecard;
  beforeEach(() => {
    pelecard = loadFresh();
  });

  const good = { statusCode: '000', confirmationKey: 'CK-1', totalX100: 7900 };

  it('accepts a matching success callback (single key, agorot amount)', () => {
    expect(pelecard.verifyCallback(good, { confirmationKey: 'CK-1', amountNis: 79 })).toBe(true);
  });

  it('accepts when the key is one of several recorded keys', () => {
    expect(
      pelecard.verifyCallback(good, { confirmationKeys: ['CK-0', 'CK-1'], amountNis: 79 })
    ).toBe(true);
  });

  it('accepts the amount whether the callback reports agorot or NIS', () => {
    expect(
      pelecard.verifyCallback(
        { statusCode: '000', confirmationKey: 'CK-1', totalX100: 79 },
        { confirmationKey: 'CK-1', amountNis: 79 }
      )
    ).toBe(true);
  });

  it('rejects a non-success status', () => {
    expect(
      pelecard.verifyCallback(
        { ...good, statusCode: '004' },
        { confirmationKey: 'CK-1', amountNis: 79 }
      )
    ).toBe(false);
  });

  it('rejects when NO key was recorded (no skip — anti-forgery)', () => {
    expect(pelecard.verifyCallback(good, { amountNis: 79 })).toBe(false);
    expect(pelecard.verifyCallback(good, { confirmationKeys: [], amountNis: 79 })).toBe(false);
  });

  it('rejects a forged/mismatched confirmation key', () => {
    expect(pelecard.verifyCallback(good, { confirmationKey: 'OTHER', amountNis: 79 })).toBe(false);
  });

  it('rejects when the callback omits the amount (no skip)', () => {
    expect(
      pelecard.verifyCallback(
        { statusCode: '000', confirmationKey: 'CK-1' },
        { confirmationKey: 'CK-1', amountNis: 79 }
      )
    ).toBe(false);
  });

  it('rejects a tampered amount', () => {
    expect(pelecard.verifyCallback(good, { confirmationKey: 'CK-1', amountNis: 149 })).toBe(false);
  });
});
