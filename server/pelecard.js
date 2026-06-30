// PeleCard Iframe V2 integration.
//
// Flow (hosted iframe — the customer's card is entered on PeleCard's page, never
// on our server, so we stay on the easy PCI path):
//   1. init() POSTs to PaymentGW/init with our secret terminal credentials and
//      the order amount; PeleCard returns an iframe URL + a ConfirmationKey.
//   2. The browser loads that URL inside an <iframe>; the customer pays there.
//   3. PeleCard POSTs the result to our ServerSideGoodFeedbackURL callback.
//      We verify status + ConfirmationKey + amount, then mark the order paid.
//
// Everything here is dormant until the three PELECARD_* env vars are set, so the
// site keeps working (Bit only) without credentials. The exact callback field
// names should be confirmed against a real PeleCard test terminal before launch
// — parseCallback() is deliberately lenient about where each value lives.

const TERMINAL = process.env.PELECARD_TERMINAL || '';
const USER = process.env.PELECARD_USER || '';
const PASSWORD = process.env.PELECARD_PASSWORD || '';
// gateway20 is the production gateway used by PeleCard's Iframe V2.
const BASE_URL = (process.env.PELECARD_BASE_URL || 'https://gateway20.pelecard.biz').replace(
  /\/+$/,
  ''
);
const INIT_PATH = '/PaymentGW/init';

// ILS, regular debit. Total is sent in agorot (amount * 100).
const CURRENCY_ILS = 1;
const ACTION_DEBIT = 'J4';
const SUCCESS_STATUS = '000';

// True only when all three credentials are present. Routes use this to decide
// whether to offer card payment at all.
function isConfigured() {
  return Boolean(TERMINAL && USER && PASSWORD);
}

// Initialize a transaction. Returns { url, confirmationKey }. Throws on a
// network failure or a PeleCard-side error (Error.ErrCode != 0).
//
// urls: { goodUrl, errorUrl, serverGoodUrl, serverErrorUrl } — all absolute.
// paramX is echoed back verbatim in the callback; we pass the collection id so
// the callback can find the order without trusting anything else in the body.
async function init({ amountNis, paramX, urls, language = 'HE' } = {}) {
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
    ParamX: String(paramX || ''),
    GoodURL: urls.goodUrl,
    ErrorURL: urls.errorUrl,
    ServerSideGoodFeedbackURL: urls.serverGoodUrl,
    ServerSideErrorFeedbackURL: urls.serverErrorUrl,
  };

  const res = await fetch(BASE_URL + INIT_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('pelecard init http ' + res.status);
  const data = await res.json().catch(() => ({}));

  const errCode = data && data.Error && data.Error.ErrCode;
  if (errCode && String(errCode) !== '0') {
    const msg = (data.Error && data.Error.ErrMsg) || 'unknown error';
    throw new Error('pelecard init error ' + errCode + ': ' + msg);
  }
  if (!data.URL) throw new Error('pelecard init returned no URL');

  return { url: data.URL, confirmationKey: data.ConfirmationKey || null };
}

// Pull the fields we care about out of a callback body, tolerant of the
// different shapes PeleCard may use (top-level keys, a nested ResultData, or a
// urlencoded form). Returns a normalized object.
function parseCallback(body = {}) {
  const rd = (body && (body.ResultData || body.resultData)) || {};
  const pick = (...keys) => {
    for (const k of keys) {
      if (body[k] != null) return body[k];
      if (rd[k] != null) return rd[k];
    }
    return undefined;
  };
  const totalRaw = pick('TotalX100', 'totalX100', 'Total', 'total');
  return {
    statusCode: pick('PelecardStatusCode', 'StatusCode', 'statusCode'),
    transactionId: pick('PelecardTransactionId', 'TransactionId', 'transactionId'),
    paramX: pick('ParamX', 'paramX'),
    confirmationKey: pick('ConfirmationKey', 'confirmationKey'),
    totalX100: totalRaw == null ? undefined : Number(totalRaw),
    approvalNo: pick('DebitApproveNumber', 'ApprovalNo', 'VoucherId'),
  };
}

// Accepted ConfirmationKeys for an order: a single `confirmationKey` or a list
// `confirmationKeys` (the order may have several in-flight init sessions).
function expectedKeys(expected) {
  if (Array.isArray(expected.confirmationKeys)) return expected.confirmationKeys.filter(Boolean);
  return expected.confirmationKey ? [expected.confirmationKey] : [];
}

// Decide whether a parsed callback represents a genuine, paid transaction for a
// given order. FAIL-CLOSED: every check must affirmatively pass, because the
// callback endpoint is public and the collection id is guessable, so a forged
// POST must never mark an order paid.
//   expected: { confirmationKey | confirmationKeys, amountNis }
// We require:
//   1. success status (000),
//   2. a ConfirmationKey that matches one we were handed at init — the key is
//      never exposed to the browser, so only PeleCard (or our server) knows it;
//      a missing/unknown key is rejected, NOT skipped,
//   3. the charged amount to equal the order total. PeleCard's callback amount
//      unit is account-dependent, so we accept either agorot (×100) or NIS.
function verifyCallback(parsed, expected = {}) {
  if (!parsed || String(parsed.statusCode) !== SUCCESS_STATUS) return false;

  const keys = expectedKeys(expected);
  if (!keys.length) return false; // nothing to match against -> cannot trust it
  if (!parsed.confirmationKey || !keys.includes(parsed.confirmationKey)) return false;

  if (expected.amountNis == null || parsed.totalX100 == null) return false;
  const nis = Number(expected.amountNis);
  if (parsed.totalX100 !== Math.round(nis * 100) && parsed.totalX100 !== Math.round(nis)) {
    return false;
  }
  return true;
}

module.exports = {
  isConfigured,
  init,
  parseCallback,
  verifyCallback,
  SUCCESS_STATUS,
  BASE_URL,
};
