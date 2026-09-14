// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

// server/tranzila.js on its own: the auth signature, the iframe URL, what the
// notify is allowed to tell us, and the fail-closed verification. The routes
// that use it are covered in tranzila-routes.test.js.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, '..', '..', 'server', 'tranzila.js');

const ENV = {
  TRANZILA_TERMINAL: 'fxptest',
  TRANZILA_APP_KEY: 'app-key-123',
  TRANZILA_SECRET: 'shh-secret',
  TRANZILA_TOKEN_FIELD: 'dugri_token',
};

let tz;
let fetchMock;

function load() {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

beforeAll(() => {
  Object.assign(process.env, ENV);
  delete process.env.TRANZILA_HANDSHAKE;
  tz = load();
});

afterAll(() => {
  for (const k of [...Object.keys(ENV), 'TRANZILA_HANDSHAKE']) delete process.env[k];
  delete require.cache[require.resolve(modPath)];
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

const ok = (obj) => ({ ok: true, status: 200, json: async () => obj });

// A report row for a clean approved 79 ₪ debit carrying `token`.
function row(over = {}) {
  return {
    index: 1696,
    amount: 7900,
    currency: '1',
    processor_response_code: '000',
    txn_type: 'DEBIT',
    authorization_number: '0587923',
    user_defined_3: 'tok123',
    ...over,
  };
}

describe('authHeaders', () => {
  it('signs HMAC-SHA256(message: app key, key: secret + time + nonce)', () => {
    const h = tz.authHeaders({ now: 1_700_000_000_500, nonce: 'n'.repeat(80) });
    const expected = crypto
      .createHmac('sha256', 'shh-secret' + '1700000000' + 'n'.repeat(80))
      .update('app-key-123')
      .digest('hex');
    expect(h['X-tranzila-api-app-key']).toBe('app-key-123');
    expect(h['X-tranzila-api-request-time']).toBe('1700000000');
    expect(h['X-tranzila-api-nonce']).toBe('n'.repeat(80));
    expect(h['X-tranzila-api-access-token']).toBe(expected);
  });

  it('uses a fresh 80-hex-char nonce each call', () => {
    const a = tz.authHeaders()['X-tranzila-api-nonce'];
    const b = tz.authHeaders()['X-tranzila-api-nonce'];
    expect(a).toMatch(/^[0-9a-f]{80}$/);
    expect(a).not.toBe(b);
  });
});

describe('isConfigured', () => {
  it('needs the terminal, the app key and the secret', () => {
    expect(tz.isConfigured()).toBe(true);
    delete process.env.TRANZILA_SECRET;
    expect(load().isConfigured()).toBe(false);
    process.env.TRANZILA_SECRET = ENV.TRANZILA_SECRET;
  });
});

describe('init', () => {
  const urls = {
    goodUrl: 'https://s.example/pay-done.html',
    errorUrl: 'https://s.example/pay-done.html?error=1',
    notifyUrl: 'https://s.example/api/payment/tranzila/notify?t=tok123',
  };

  it('builds the directng iframe URL for the terminal, in shekels, with our token', async () => {
    const { url, transactionId } = await tz.init({ amountNis: 139, paramToken: 'tok123', urls });
    expect(transactionId).toBe(null);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://directng.tranzila.com/fxptest/iframenew.php');
    const q = u.searchParams;
    expect(q.get('sum')).toBe('139.00');
    expect(q.get('currency')).toBe('1');
    expect(q.get('cred_type')).toBe('1');
    expect(q.get('tranmode')).toBe('A');
    expect(q.get('lang')).toBe('il');
    expect(q.get('success_url_address')).toBe(urls.goodUrl);
    expect(q.get('fail_url_address')).toBe(urls.errorUrl);
    expect(q.get('notify_url_address')).toBe(urls.notifyUrl);
    expect(q.get('dugri_token')).toBe('tok123');
    expect(q.has('thtk')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a zero or missing amount, and a missing token', async () => {
    await expect(tz.init({ amountNis: 0, paramToken: 't', urls })).rejects.toThrow();
    await expect(tz.init({ amountNis: 79, urls })).rejects.toThrow();
  });

  it('with TRANZILA_HANDSHAKE=1, locks the sum with a thtk from the handshake API', async () => {
    process.env.TRANZILA_HANDSHAKE = '1';
    const hs = load();
    fetchMock.mockResolvedValueOnce(ok({ error_code: 0, thtk: 'w5bcd32' }));
    const { url } = await hs.init({ amountNis: 79, paramToken: 'tok123', urls });
    expect(new URL(url).searchParams.get('thtk')).toBe('w5bcd32');
    const [calledUrl, opts] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://api.tranzila.com/v2/handshake/create');
    expect(JSON.parse(opts.body)).toMatchObject({ terminal_name: 'fxptest', sum: 79 });
    expect(opts.headers['X-tranzila-api-access-token']).toMatch(/^[0-9a-f]{64}$/);

    fetchMock.mockResolvedValueOnce(ok({ error_code: 20003, message: 'nope' }));
    await expect(hs.init({ amountNis: 79, paramToken: 'tok123', urls })).rejects.toThrow(
      /handshake/
    );
    delete process.env.TRANZILA_HANDSHAKE;
  });
});

describe('parseNotify', () => {
  it('takes the token from our own notify URL and the index + result from the body', () => {
    expect(tz.parseNotify({ index: '1696', Response: '000', sum: '1' }, { t: 'tok123' })).toEqual({
      token: 'tok123',
      index: '1696',
      response: '000',
    });
  });

  it('falls back to the token field in the body, and reports absences as null', () => {
    expect(tz.parseNotify({ dugri_token: 'tokB' }, {})).toEqual({
      token: 'tokB',
      index: null,
      response: null,
    });
  });
});

describe('getTransaction / findTransaction', () => {
  it('looks the index up on the Reports API with the signed headers and normalizes it', async () => {
    fetchMock.mockResolvedValueOnce(ok({ transactions: [row()], rows: 1 }));
    const tx = await tz.getTransaction('1696');
    const [calledUrl, opts] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://report.tranzila.com/v1/transaction');
    expect(JSON.parse(opts.body)).toEqual({ terminal_name: 'fxptest', transaction_index: 1696 });
    expect(opts.headers['X-tranzila-api-app-key']).toBe('app-key-123');
    expect(tx).toMatchObject({
      index: '1696',
      amountAgorot: 7900,
      currency: '1',
      responseCode: '000',
      txnType: 'DEBIT',
      approvalNo: '0587923',
    });
  });

  it('is null for an index Tranzila does not have, or one that is not a number', async () => {
    fetchMock.mockResolvedValueOnce(ok({ transactions: [], rows: 0 }));
    expect(await tz.getTransaction('1696')).toBe(null);
    expect(await tz.getTransaction('abc')).toBe(null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on an HTTP error so the route can ask for a retry', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    await expect(tz.getTransaction('1696')).rejects.toThrow(/401/);
  });

  it('retries a transaction the report does not have yet', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ transactions: [] }))
      .mockResolvedValueOnce(ok({ transactions: [row()] }));
    const tx = await tz.findTransaction('1696', { attempts: 3, delayMs: 0 });
    expect(tx.index).toBe('1696');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('verifyTransaction (fail-closed)', () => {
  const tx = (over) => ({
    index: '1696',
    amountAgorot: 7900,
    currency: '1',
    responseCode: '000',
    txnType: 'DEBIT',
    raw: row(),
    ...over,
  });
  const expected = { amountNis: 79, token: 'tok123' };

  it('accepts an approved shekel debit for the exact amount that carries the token', () => {
    expect(tz.verifyTransaction(tx(), expected)).toBe(true);
  });

  it('rejects a declined charge', () => {
    expect(tz.verifyTransaction(tx({ responseCode: '004' }), expected)).toBe(false);
  });

  it('rejects a different amount, in either direction', () => {
    expect(tz.verifyTransaction(tx({ amountAgorot: 100 }), expected)).toBe(false);
    expect(tz.verifyTransaction(tx({ amountAgorot: 7901 }), expected)).toBe(false);
    expect(tz.verifyTransaction(tx({ amountAgorot: null }), expected)).toBe(false);
  });

  it('rejects a foreign currency', () => {
    expect(tz.verifyTransaction(tx({ currency: '2' }), expected)).toBe(false);
  });

  it('rejects money moving the other way (credit, cancel, verify)', () => {
    for (const t of ['CREDIT', 'CANCEL', 'VERIFY', 'J2']) {
      expect(tz.verifyTransaction(tx({ txnType: t }), expected)).toBe(false);
    }
  });

  it("rejects another buyer's real charge: same amount, but not this session's token", () => {
    expect(tz.verifyTransaction(tx({ raw: row({ user_defined_3: 'tokOTHER' }) }), expected)).toBe(
      false
    );
    expect(tz.verifyTransaction(tx(), { amountNis: 79 })).toBe(false);
  });
});

describe('init: buyer details and wallets', () => {
  const urls = {
    goodUrl: 'https://s.example/pay-done.html',
    errorUrl: 'https://s.example/pay-done.html?error=1',
    notifyUrl: 'https://s.example/api/payment/tranzila/notify?t=tok123',
  };

  it("passes the buyer's email and phone, and leaves them out when the order has none", async () => {
    const { url } = await tz.init({
      amountNis: 79,
      paramToken: 'tok123',
      urls,
      buyer: { email: 'buyer@example.com', phone: '0501234567' },
    });
    const q = new URL(url).searchParams;
    expect(q.get('email')).toBe('buyer@example.com');
    expect(q.get('phone')).toBe('0501234567');

    const bare = new URL(
      (await tz.init({ amountNis: 79, paramToken: 'tok123', urls, buyer: { email: null } })).url
    ).searchParams;
    expect(bare.has('email')).toBe(false);
    expect(bare.has('phone')).toBe(false);
  });

  it('offers no wallet unless the environment switches it on', async () => {
    const q = new URL((await tz.init({ amountNis: 79, paramToken: 'tok123', urls })).url)
      .searchParams;
    expect(q.has('apple_pay')).toBe(false);
    expect(q.has('google_pay')).toBe(false);
  });

  it('adds apple_pay and google_pay each on its own switch', async () => {
    process.env.TRANZILA_APPLE_PAY = '1';
    let q = new URL((await load().init({ amountNis: 79, paramToken: 'tok123', urls })).url)
      .searchParams;
    expect(q.get('apple_pay')).toBe('1');
    expect(q.has('google_pay')).toBe(false);

    delete process.env.TRANZILA_APPLE_PAY;
    process.env.TRANZILA_GOOGLE_PAY = '1';
    q = new URL((await load().init({ amountNis: 79, paramToken: 'tok123', urls })).url)
      .searchParams;
    expect(q.has('apple_pay')).toBe(false);
    expect(q.get('google_pay')).toBe('1');
    delete process.env.TRANZILA_GOOGLE_PAY;
  });
});
