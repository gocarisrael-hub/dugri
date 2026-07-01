// PeleCard Iframe integration — implemented against PeleCard's official
// Iframe/Redirect (11/2024) and Services ReST API (01/2025) manuals.
//
// Flow (hosted iframe — card entered on PeleCard's page, never on our server):
//   1. init() POSTs to /PaymentGW/init on gateway21. PeleCard returns a payment
//      URL with a TransactionId embedded. NOTE: init does NOT return a
//      ConfirmationKey (that is created at payment time).
//   2. The browser loads that URL inside an <iframe>; the customer pays there.
//   3. PeleCard POSTs the result to our ServerSideGoodFeedbackURL. We DO NOT
//      trust that body for the money decision — we take only the TransactionId
//      and verify authoritatively via getTransaction() using our secret
//      terminal credentials. A forged callback cannot survive that check.
//
// ParamX carries a short per-payment token (<=19 chars, [0-9a-z]); PeleCard
// echoes it back as AdditionalDetailsParamX, which we use to locate the order.
//
// Dormant until the three PELECARD_* env vars are set (site keeps Bit only).

const TERMINAL = process.env.PELECARD_TERMINAL || '';
const USER = process.env.PELECARD_USER || '';
const PASSWORD = process.env.PELECARD_PASSWORD || '';
// gateway21 is the production gateway per both official manuals.
const BASE_URL = (process.env.PELECARD_BASE_URL || 'https://gateway21.pelecard.biz').replace(
  /\/+$/,
  ''
);
const INIT_PATH = '/PaymentGW/init';
const GET_TRANSACTION_PATH = '/PaymentGW/GetTransaction';

// ILS, regular debit. Amounts are in agorot (NIS * 100).
const CURRENCY_ILS = 1;
const ACTION_DEBIT = 'J4';
const SUCCESS_STATUS = '000';
// PeleCard's ParamX field is capped at 19 chars, digits + lowercase letters.
const PARAM_MAX = 19;

// True only when all three credentials are present. Routes use this to decide
// whether to offer card payment at all.
function isConfigured() {
  return Boolean(TERMINAL && USER && PASSWORD);
}

async function postJson(path, payload) {
  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('pelecard http ' + res.status);
  return res.json().catch(() => ({}));
}

// Extract the transactionId PeleCard embeds in the init payment URL
// (e.g. ".../PaymentGW?transactionId=xxxx").
function transactionIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/[?&]transactionId=([^&]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

// Initialize a transaction. Returns { url, transactionId }. Throws on a network
// failure or a PeleCard-side error (Error.ErrCode != 0).
//
// urls: { goodUrl, errorUrl, serverGoodUrl, serverErrorUrl } — all absolute.
// paramToken: our per-payment id (<=19 chars, [0-9a-z]); echoed back by PeleCard
// as AdditionalDetailsParamX so the callback can be matched to the order.
async function init({ amountNis, paramToken, urls, language = 'HE' } = {}) {
  if (!isConfigured()) throw new Error('pelecard not configured');
  const agorot = Math.round(Number(amountNis) * 100);
  if (!Number.isFinite(agorot) || agorot <= 0) throw new Error('bad amount');

  const payload = {
    terminal: TERMINAL,
    user: USER,
    password: PASSWORD,
    ActionType: ACTION_DEBIT,
    Currency: CURRENCY_ILS,
    Total: agorot,
    FreeTotal: false,
    Language: language,
    ParamX: String(paramToken || '').slice(0, PARAM_MAX),
    GoodURL: urls.goodUrl,
    ErrorURL: urls.errorUrl,
    ServerSideGoodFeedbackURL: urls.serverGoodUrl,
    ServerSideErrorFeedbackURL: urls.serverErrorUrl,
    // Ask PeleCard to POST the server-side feedback as clean JSON.
    ServerSideFeedbackContentType: 'application/json',
  };

  const data = await postJson(INIT_PATH, payload);
  if (process.env.PELECARD_DEBUG === '1') {
    console.log('[pelecard init] response keys:', Object.keys(data), 'hasURL:', !!data.URL);
  }

  const errCode = data && data.Error && data.Error.ErrCode;
  if (errCode && String(errCode) !== '0') {
    const msg = (data.Error && data.Error.ErrMsg) || 'unknown error';
    throw new Error('pelecard init error ' + errCode + ': ' + msg);
  }
  if (!data.URL) throw new Error('pelecard init returned no URL');

  return { url: data.URL, transactionId: transactionIdFromUrl(data.URL) };
}

// Authoritative verification. Fetch the transaction from PeleCard by id using
// our SECRET terminal credentials (a forger cannot reproduce this). Returns a
// normalized { statusCode, paramX, debitTotalAgorot, transactionId }. Throws on
// a transport error.
async function getTransaction(transactionId) {
  if (!isConfigured()) throw new Error('pelecard not configured');
  if (!transactionId) throw new Error('no transactionId');

  const data = await postJson(GET_TRANSACTION_PATH, {
    terminal: TERMINAL,
    user: USER,
    password: PASSWORD,
    TransactionId: transactionId,
  });
  if (process.env.PELECARD_DEBUG === '1') {
    console.log(
      '[pelecard gettransaction] StatusCode:',
      data && data.StatusCode,
      'resultKeys:',
      data && data.ResultData ? Object.keys(data.ResultData) : []
    );
  }

  const rd = (data && data.ResultData) || {};
  const debit = rd.DebitTotal != null && rd.DebitTotal !== '' ? Number(rd.DebitTotal) : null;
  // The echoed token PeleCard returns for our ParamX; primary field is
  // AdditionalDetailsParamX, with lenient fallbacks in case of account variance.
  const echoed = rd.AdditionalDetailsParamX != null ? rd.AdditionalDetailsParamX : rd.ParamX;
  return {
    // Top-level StatusCode = did the *retrieval* succeed. ShvaResult (in
    // ResultData) = did the *charge* get approved by SHVA. We check both.
    statusCode: data && data.StatusCode != null ? String(data.StatusCode) : null,
    shvaResult: rd.ShvaResult != null ? String(rd.ShvaResult) : null,
    paramX: echoed != null ? String(echoed) : null,
    debitTotalAgorot: Number.isFinite(debit) ? debit : null,
    approvalNo: rd.DebitApproveNumber || rd.VoucherId || null,
    transactionId: rd.TransactionId || transactionId,
    raw: data,
  };
}

// Extract just the TransactionId from the (untrusted) server-side callback — the
// only field we take from it; everything else comes from getTransaction().
// Lenient about the callback's shape (JSON, nested ResultData, or urlencoded).
function parseCallback(body = {}) {
  const rd = (body && (body.ResultData || body.resultData)) || {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (body[k] != null) return body[k];
      if (rd[k] != null) return rd[k];
    }
    return undefined;
  };
  return {
    statusCode: pick('StatusCode', 'PelecardStatusCode', 'statusCode'),
    transactionId: pick('TransactionId', 'PelecardTransactionId', 'transactionId'),
    paramX: pick('AdditionalDetailsParamX', 'ParamX', 'paramX'),
  };
}

// Whether an authoritative getTransaction() result represents a genuine paid
// transaction for an order of `amountNis`. FAIL-CLOSED: the retrieval must
// succeed (StatusCode 000), the charge must be approved by SHVA (ShvaResult
// 000), and the charged amount (agorot) must equal the order total.
function verifyTransaction(tx, expected = {}) {
  if (!tx || String(tx.statusCode) !== SUCCESS_STATUS) return false;
  if (String(tx.shvaResult) !== SUCCESS_STATUS) return false;
  if (expected.amountNis == null || tx.debitTotalAgorot == null) return false;
  return tx.debitTotalAgorot === Math.round(Number(expected.amountNis) * 100);
}

module.exports = {
  isConfigured,
  init,
  getTransaction,
  parseCallback,
  verifyTransaction,
  transactionIdFromUrl,
  SUCCESS_STATUS,
  BASE_URL,
};
