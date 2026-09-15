// Tranzila card payment — the second card provider, beside server/pelecard.js.
// Implemented against docs.tranzila.com: "Iframe Integration (DirectNG)",
// "Authentication" and "Tranzila Transaction Reports API". See server/TRANZILA.md.
//
// Flow (hosted iframe — the card is typed on Tranzila's page, never on ours):
//   1. init() builds the directng iframe URL: the sum, our return pages, and a
//      notify URL that carries this payment's own token (?t=). The same token is
//      sent in a terminal user-defined field (TOKEN_FIELD), so Tranzila stores it
//      ON the transaction.
//   2. The browser loads that URL in the pay modal; the buyer pays there.
//   3. Tranzila POSTs the result to the notify URL. That POST is NOT signed, so
//      nothing in it decides money. We take the transaction `index` from it and
//      re-fetch that transaction from the Reports API with our secret key. It
//      counts only when it is approved, in shekels, for exactly the session's
//      amount, AND carries the session's token. Indexes are sequential, so
//      without the token check anyone could claim another buyer's charge by
//      guessing its index; with it, a charge can only pay for the checkout that
//      opened it.
//
// Dormant until TRANZILA_TERMINAL + TRANZILA_APP_KEY + TRANZILA_SECRET are set,
// and even then only used where PAYMENT_PROVIDER=tranzila (server/index.js).

const crypto = require('crypto');
const { positiveNumber } = require('./tranzila-sweep');

const TERMINAL = process.env.TRANZILA_TERMINAL || '';
const APP_KEY = process.env.TRANZILA_APP_KEY || '';
const SECRET = process.env.TRANZILA_SECRET || '';
// The API name of the user-defined field that holds our per-payment token. It
// must exist on the terminal (My Tranzila → user-defined fields), or Tranzila
// drops the value and every payment fails verification — closed, never open.
const TOKEN_FIELD = process.env.TRANZILA_TOKEN_FIELD || 'dugri_token';
// Handshake (thtk) locks the sum on Tranzila's side. Needs the Token module and,
// once Tranzila switches it on for the terminal, becomes mandatory for every
// charge — so it follows the terminal, set TRANZILA_HANDSHAKE=1 when it is on.
const HANDSHAKE = process.env.TRANZILA_HANDSHAKE === '1';
// Wallet buttons on Tranzila's page. Each works only after Tranzila activates it
// for the terminal AND registers the domain the buyer pays on (Apple also reads
// /.well-known/apple-developer-merchantid-domain-association there), so each is
// switched on per environment, once that environment's domain is registered.
const APPLE_PAY = process.env.TRANZILA_APPLE_PAY === '1';
const GOOGLE_PAY = process.env.TRANZILA_GOOGLE_PAY === '1';

const trimBase = (v, d) => (v || d).replace(/\/+$/, '');
const IFRAME_BASE = trimBase(process.env.TRANZILA_IFRAME_BASE, 'https://directng.tranzila.com');
const API_BASE = trimBase(process.env.TRANZILA_API_BASE, 'https://api.tranzila.com');
const REPORT_BASE = trimBase(process.env.TRANZILA_REPORT_BASE, 'https://report.tranzila.com');

const NAME = 'tranzila';
const SUCCESS_CODE = '000';
const CURRENCY_ILS = '1';
// WHAT COUNTS AS MONEY TAKEN — an allowlist, never a blocklist.
//
// The iframe URL is built here but opened in the buyer's browser, so the buyer
// can edit tranmode/cred_type before paying. Tranzila approves an authorization
// hold (J5, tranmode V) or a card check (J2, tranmode N) with 000, in shekels,
// for the right amount and carrying the right token — and no money ever moves.
// So a transaction pays for an order only when it is the exact kind of charge we
// asked for: a DEBIT (Reports API txn_type), in standard mode (tranmode A), on a
// regular or debit-card plan (payment_plan 1 / 3, not installments). A missing
// or unknown txn_type is refused; tranmode and payment_plan are checked whenever
// the report carries them. Values from docs.tranzila.com (see TRANZILA.md).
const CHARGE_TXN_TYPES = new Set(['DEBIT']);
const CHARGE_TRANMODES = new Set(['A']);
const CHARGE_PAYMENT_PLANS = new Set([1, 3]);

function isConfigured() {
  return Boolean(TERMINAL && APP_KEY && SECRET);
}

// The four auth headers every Tranzila API call carries:
// access token = HMAC-SHA256(message: app key, key: secret + time + nonce), hex.
function authHeaders({ now = Date.now(), nonce = crypto.randomBytes(40).toString('hex') } = {}) {
  const time = String(Math.floor(now / 1000));
  const token = crypto
    .createHmac('sha256', SECRET + time + nonce)
    .update(APP_KEY)
    .digest('hex');
  return {
    'X-tranzila-api-app-key': APP_KEY,
    'X-tranzila-api-request-time': time,
    'X-tranzila-api-nonce': nonce,
    'X-tranzila-api-access-token': token,
  };
}

// A Tranzila call that never answers must not hold a notify, a retry pass or the
// sweep open for Node's default of about five minutes: it is aborted after
// TRANZILA_HTTP_TIMEOUT_MS and the caller treats it as a failed call.
const HTTP_TIMEOUT_MS = positiveNumber(process.env.TRANZILA_HTTP_TIMEOUT_MS, 10 * 1000);

async function postJson(url, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('tranzila http ' + res.status);
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

function toAgorot(amountNis) {
  return Math.round(Number(amountNis) * 100);
}

// Build the iframe URL for one payment. Returns { url, transactionId: null } —
// the same shape as pelecard.init(); Tranzila has no transaction until the buyer
// pays, which is why sessions carry `provider` (db.hasInFlightRealSession).
//
// urls: { goodUrl, errorUrl, notifyUrl } — absolute. paramToken goes both into
// the notify URL and into TOKEN_FIELD.
//
// buyer: { email, phone } from the order, optional. Tranzila pre-fills its form
// with them and addresses the accounting document it issues for the charge.
async function init({ amountNis, paramToken, urls, buyer = {}, description = 'משחק דוגרי' } = {}) {
  if (!isConfigured()) throw new Error('tranzila not configured');
  const agorot = toAgorot(amountNis);
  if (!Number.isFinite(agorot) || agorot <= 0) throw new Error('bad amount');
  if (!paramToken) throw new Error('no payment token');
  const sum = (agorot / 100).toFixed(2);

  const params = new URLSearchParams({
    sum,
    currency: CURRENCY_ILS,
    cred_type: '1',
    tranmode: 'A',
    lang: 'il',
    nologo: '1',
    trButtonColor: '000000',
    pdesc: description,
    success_url_address: urls.goodUrl,
    fail_url_address: urls.errorUrl,
    notify_url_address: urls.notifyUrl,
  });
  params.set(TOKEN_FIELD, paramToken);
  if (buyer && buyer.email) params.set('email', String(buyer.email));
  if (buyer && buyer.phone) params.set('phone', String(buyer.phone));
  if (APPLE_PAY) params.set('apple_pay', '1');
  if (GOOGLE_PAY) params.set('google_pay', '1');

  if (HANDSHAKE) {
    const data = await postJson(API_BASE + '/v2/handshake/create', {
      terminal_name: TERMINAL,
      sum: Number(sum),
      request_params: { [TOKEN_FIELD]: paramToken },
    });
    if (!data || Number(data.error_code) !== 0 || !data.thtk) {
      throw new Error('tranzila handshake error ' + (data && data.error_code));
    }
    params.set('thtk', data.thtk);
  }

  const url =
    IFRAME_BASE + '/' + encodeURIComponent(TERMINAL) + '/iframenew.php?' + params.toString();
  return { url, transactionId: null };
}

// What we take from the (untrusted) notify POST: our token from the URL we
// built and Tranzila's own result code. Neither decides money; the token only
// says which session might have paid, so a sweep is worth running, and a plain
// failure code skips even that.
function parseNotify(body = {}, query = {}) {
  const pick = (v) => (v == null || v === '' ? null : String(v));
  return {
    token: pick(query.t) || pick(body[TOKEN_FIELD]),
    index: pick(body.index),
    response: pick(body.Response),
  };
}

// The terminal's transactions between two Israel dates (YYYY-MM-DD), newest
// first, normalized, with our secret key. Every page of 1000 rows is followed
// until a short one. Past MAX_PAGES it THROWS rather than return a partial
// list: pages are newest-first, so a silent stop would drop the oldest rows.
// Throws on a transport error or timeout too.
const PAGE_RESULTS = 1000;
const MAX_PAGES = 200;
async function listTransactions({ startDate, endDate } = {}) {
  if (!isConfigured()) throw new Error('tranzila not configured');
  const out = [];
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) {
      throw new Error('tranzila report has more than ' + MAX_PAGES * PAGE_RESULTS + ' rows');
    }
    const data = await postJson(REPORT_BASE + '/v1/transaction', {
      terminal_name: TERMINAL,
      transaction_start_date: startDate,
      transaction_end_date: endDate,
      page,
      page_results: PAGE_RESULTS,
      order_direction: 'desc',
    });
    // An error can come back as HTTP 200 with an error body (keys without report
    // access, a wrong terminal name). Read as "no rows" it would count as a
    // successful sweep — the last-swept time moves on and nobody is told — so
    // anything but a transactions list with no error code is a failure.
    const failed =
      !data ||
      typeof data !== 'object' ||
      (data.error_code != null && Number(data.error_code) !== 0) ||
      !Array.isArray(data.transactions);
    if (failed) {
      throw new Error(
        'tranzila report error ' +
          (data && data.error_code != null ? data.error_code : 'without a transactions list') +
          (data && data.message ? ': ' + String(data.message).slice(0, 120) : '')
      );
    }
    const list = data.transactions;
    for (const t of list) if (t && t.index != null) out.push(normalizeRow(t));
    if (list.length < PAGE_RESULTS) break;
  }
  return out;
}

function normalizeRow(rd) {
  return {
    index: String(rd.index),
    amountAgorot: rd.amount != null && rd.amount !== '' ? Number(rd.amount) : null,
    currency: rd.currency != null ? String(rd.currency) : null,
    responseCode: rd.processor_response_code != null ? String(rd.processor_response_code) : null,
    txnType: rd.txn_type != null && rd.txn_type !== '' ? String(rd.txn_type).toUpperCase() : null,
    tranmode: rd.tranmode != null && rd.tranmode !== '' ? String(rd.tranmode).toUpperCase() : null,
    paymentPlan: rd.payment_plan != null && rd.payment_plan !== '' ? Number(rd.payment_plan) : null,
    approvalNo: rd.authorization_number || null,
    raw: rd,
  };
}

// Does this transaction carry our token? Checked across every field Tranzila
// returns rather than one named slot: the token is 18 random characters, so it
// can only be there because we sent it with THIS payment.
function carriesToken(raw, token) {
  if (!raw || !token) return false;
  return Object.values(raw).some((v) => v != null && String(v) === String(token));
}

// WHICH ENVIRONMENT A CHARGE BELONGS TO. Staging and production share one
// terminal, so each environment's sweep reads the other's rows. Every Tranzila
// session token therefore carries its environment: 'd', one letter, 16 hex
// characters (18 in all, 64 random bits). PAYMENT_ENV wins; otherwise Railway's
// own RAILWAY_ENVIRONMENT_NAME. Read at call time.
function envTag() {
  const name = String(process.env.PAYMENT_ENV || process.env.RAILWAY_ENVIRONMENT_NAME || '')
    .trim()
    .toLowerCase();
  if (name === 'production') return 'p';
  if (name === 'staging') return 's';
  return 'l';
}

function newSessionToken() {
  return 'd' + envTag() + crypto.randomBytes(8).toString('hex');
}

const SESSION_TOKEN = /^d([a-z])[0-9a-f]{16}$/;

// The values on a transaction shaped exactly like a Tranzila session token —
// how a row is matched to its session (the caller looks each one up), and how a
// row carrying another environment's token is told apart from one carrying none.
function sessionTokenValues(raw) {
  if (!raw) return [];
  return Object.values(raw).filter((v) => typeof v === 'string' && SESSION_TOKEN.test(v));
}

// The environment letter a session token was minted in, or null.
function tokenEnv(token) {
  const m = SESSION_TOKEN.exec(String(token || ''));
  return m ? m[1] : null;
}

// FAIL-CLOSED: approved, the kind of charge we asked for (see CHARGE_* above),
// shekels, exactly the expected amount in agorot, and bound to the session by
// its token.
function verifyTransaction(tx, expected = {}) {
  if (!tx || tx.responseCode !== SUCCESS_CODE) return false;
  if (!tx.txnType || !CHARGE_TXN_TYPES.has(tx.txnType)) return false;
  if (tx.tranmode != null && !CHARGE_TRANMODES.has(tx.tranmode)) return false;
  if (tx.paymentPlan != null && !CHARGE_PAYMENT_PLANS.has(tx.paymentPlan)) return false;
  if (tx.currency !== CURRENCY_ILS) return false;
  if (expected.amountNis == null || tx.amountAgorot == null) return false;
  if (tx.amountAgorot !== toAgorot(expected.amountNis)) return false;
  return carriesToken(tx.raw, expected.token);
}

module.exports = {
  NAME,
  isConfigured,
  authHeaders,
  init,
  parseNotify,
  listTransactions,
  verifyTransaction,
  carriesToken,
  sessionTokenValues,
  tokenEnv,
  envTag,
  newSessionToken,
  TOKEN_FIELD,
  SUCCESS_CODE,
};
