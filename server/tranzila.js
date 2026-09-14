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
// Report txn_type values that move no money to us. Anything else that is
// approved (DEBIT, or FORCE after a J5) is a charge.
const NOT_A_CHARGE = new Set(['CREDIT', 'VERIFY', 'CANCEL', 'REFUTE', 'J2', 'REVERSAL']);

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

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('tranzila http ' + res.status);
  return res.json().catch(() => ({}));
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
// built, the transaction index to look up, and Tranzila's own result code — used
// only to skip the lookup for a charge that plainly failed.
function parseNotify(body = {}, query = {}) {
  const pick = (v) => (v == null || v === '' ? null : String(v));
  return {
    token: pick(query.t) || pick(body[TOKEN_FIELD]),
    index: pick(body.index),
    response: pick(body.Response),
  };
}

// Fetch one transaction by index from the Reports API, with our secret key.
// Returns a normalized record, or null when Tranzila has no such transaction.
async function getTransaction(index) {
  if (!isConfigured()) throw new Error('tranzila not configured');
  const n = Number(index);
  if (!Number.isInteger(n) || n <= 0) return null;
  const data = await postJson(REPORT_BASE + '/v1/transaction', {
    terminal_name: TERMINAL,
    transaction_index: n,
  });
  const list = (data && Array.isArray(data.transactions) && data.transactions) || [];
  const rd = list.find((t) => t && Number(t.index) === n);
  if (!rd) return null;
  return {
    index: String(rd.index),
    amountAgorot: rd.amount != null && rd.amount !== '' ? Number(rd.amount) : null,
    currency: rd.currency != null ? String(rd.currency) : null,
    responseCode: rd.processor_response_code != null ? String(rd.processor_response_code) : null,
    txnType: rd.txn_type != null ? String(rd.txn_type).toUpperCase() : null,
    approvalNo: rd.authorization_number || null,
    raw: rd,
  };
}

// The report can trail the notify by a moment. Try a few times before giving
// up; null means "still not there", which the route answers with a 502.
async function findTransaction(index, { attempts = 3, delayMs } = {}) {
  const wait = delayMs != null ? delayMs : Number(process.env.TRANZILA_LOOKUP_RETRY_MS || 2000);
  for (let i = 0; i < attempts; i++) {
    const tx = await getTransaction(index);
    if (tx) return tx;
    if (i < attempts - 1 && wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return null;
}

// Does this transaction carry our token? Checked across every field Tranzila
// returns rather than one named slot: the token is 18 random characters, so it
// can only be there because we sent it with THIS payment.
function carriesToken(raw, token) {
  if (!raw || !token) return false;
  return Object.values(raw).some((v) => v != null && String(v) === String(token));
}

// FAIL-CLOSED: approved, a charge, shekels, exactly the expected amount in
// agorot, and bound to the session by its token.
function verifyTransaction(tx, expected = {}) {
  if (!tx || tx.responseCode !== SUCCESS_CODE) return false;
  if (tx.txnType && NOT_A_CHARGE.has(tx.txnType)) return false;
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
  getTransaction,
  findTransaction,
  verifyTransaction,
  carriesToken,
  TOKEN_FIELD,
  SUCCESS_CODE,
};
