// hfd.js — book a delivery order's parcel with HFD, the courier that carries our
// printed decks, instead of retyping the address into HFD's own site.
//
// HFD publishes no developer documentation: the contract below is taken from
// their own WordPress plugin (`hfd-epost-integration`, the one their integration
// sheet points WooCommerce shops at), which is the reference implementation
// every HFD shop already runs. Four calls, one bearer token:
//
//   POST   /shipments/create          → { shipmentNumber, randNumber }
//   GET    /shipments/{number}/label  → the sticker, application/pdf
//   DELETE /shipments/{number}        → { status: 'OK' | 'ERROR', status_desc }
//   https://run.hfd.co.il/info/{randNumber} — the customer-facing tracking page
//
// The payload is the plugin's PLAIN delivery-to-an-address case: shipmentTypeCode
// 35 + cargoTypeHaloch 10 + mesiraIsuf 'מסירה'. Its other branches are a pickup
// point (50/11, needs a pudo code), cash on delivery (37/10/100) and collecting
// FROM the customer (a returns flow) — none of which we sell. Both codes are env
// overrides anyway, so HFD support can move us onto a different service without
// a deploy.
//
// DORMANT until HFD_TOKEN + HFD_CLIENT_NUMBER are set, exactly like pelecard.js
// and whatsapp.js: with no credentials nothing is called and every entry point
// answers `{ ok: false, skipped: true }`. A shipment is a real van and a real
// charge, so nothing here fires on its own — the owner presses a button per
// order.
const { Buffer } = require('buffer');

const HFD_TOKEN = process.env.HFD_TOKEN || '';
const CLIENT_NUMBER = process.env.HFD_CLIENT_NUMBER || '';
// Whose name the recipient sees as the sender.
const SENDER_NAME = process.env.HFD_SENDER_NAME || 'דוגרי';
const BASE_URL = (process.env.HFD_BASE_URL || 'https://api.hfd.co.il/rest/v2').replace(/\/+$/, '');
// The tracking page is a plain public URL on a different host — no token, and
// nothing of ours renders it; we only link to it.
const TRACK_BASE = (process.env.HFD_TRACK_URL || 'https://run.hfd.co.il/info').replace(/\/+$/, '');
const SHIPMENT_TYPE_CODE = Number(process.env.HFD_SHIPMENT_TYPE_CODE || 35);
const CARGO_TYPE_HALOCH = Number(process.env.HFD_CARGO_TYPE || 10);
const REQUEST_TIMEOUT_MS = Number(process.env.HFD_TIMEOUT_MS || 20000);

// True only with both credentials. Every caller checks this first, so an
// unconfigured service never opens a socket.
function isConfigured() {
  return Boolean(HFD_TOKEN && CLIENT_NUMBER);
}

// What the admin page needs to decide whether to offer the button at all. Never
// includes the token.
function status() {
  return {
    configured: isConfigured(),
    clientNumber: CLIENT_NUMBER || null,
    senderName: SENDER_NAME,
    baseUrl: BASE_URL,
  };
}

// --- pure: our order → HFD's fields ------------------------------------------

// An Israeli mobile as HFD wants it: digits only, local 0-prefixed form. A
// +972/972 international prefix becomes 0; anything too short to be a phone
// returns '' so the payload carries an empty field rather than a fake one.
function normalizePhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D+/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  if (d.length < 9) return '';
  return d.slice(0, 15);
}

// Split "הרצל 5" into a street and a house number, because HFD carries them in
// separate fields. Only a number at the END is taken — that is how an Israeli
// address is written, and a guess anywhere else ("רחוב 12 הבנים") would be
// wrong more often than right. When there is no trailing number the whole string
// stays the street name and houseNum is empty, which is exactly what HFD's own
// plugin sends for every address; the full original also rides along in
// addressRemarks, so nothing is lost either way.
function splitStreet(street) {
  const s = String(street == null ? '' : street).trim();
  const m = s.match(/^(.*[^\d\s])\s+(\d+[א-תa-zA-Z]?)$/);
  if (!m) return { streetName: s, houseNum: '' };
  return { streetName: m[1].trim(), houseNum: m[2] };
}

// Everything about the address that HFD has no field for, as one remark line:
// the full street as the customer typed it, the postal code, and the flat/floor.
// The courier reads this; it is not decoration.
function addressRemarks(addr) {
  const parts = [String((addr && addr.street) || '').trim()];
  if (addr && addr.postal) parts.push('מיקוד ' + addr.postal);
  if (addr && addr.apartment) parts.push('דירה ' + addr.apartment);
  if (addr && addr.floor) parts.push('קומה ' + addr.floor);
  return parts.filter(Boolean).join(', ');
}

// Map a collection to the create-shipment body. PURE and exported so the mapping
// is testable without a network — the shape of this object is the whole
// integration.
//
// Returns { payload } or { error } for an order that cannot ship: no order, not
// a delivery order, or no address. Those are the owner's mistakes to fix in the
// order editor, so they are refused here rather than sent to HFD to bounce.
function buildShipment(c) {
  const order = c && c.order;
  if (!order) return { error: 'no order' };
  if (order.version !== 'delivery') return { error: 'not a delivery order' };
  const addr = order.address;
  if (!addr || !addr.street || !addr.city) return { error: 'address required' };

  const { streetName, houseNum } = splitStreet(addr.street);
  const nameTo = String(c.buyer_name || c.honoree_name || '').trim();

  return {
    payload: {
      clientNumber: Number(CLIENT_NUMBER) || 0,
      // 'מסירה' = we hand a parcel over. ('איסוף' is HFD collecting one FROM a
      // customer — the returns flow, which we do not sell.)
      mesiraIsuf: 'מסירה',
      shipmentTypeCode: SHIPMENT_TYPE_CODE,
      cargoTypeHaloch: CARGO_TYPE_HALOCH,
      cargoTypeHazor: 0,
      stageCode: null,
      pudoCodeDestination: 0,
      ordererName: SENDER_NAME,
      nameTo: nameTo || 'לקוח/ה',
      streetName,
      houseNum,
      apartment: (addr.apartment && String(addr.apartment)) || '',
      floor: (addr.floor && String(addr.floor)) || '',
      entrance: '',
      cityName: String(addr.city).trim(),
      streetCode: '',
      telFirst: normalizePhone(c.owner_phone),
      email: (c.owner_email && String(c.owner_email).trim()) || '',
      addressRemarks: addressRemarks(addr),
      shipmentRemarks: '',
      // Our order number, so a call to HFD about a parcel can be traced back to
      // a row in the admin without guessing from the honoree's name.
      referenceNum1: String(c.order_no || c.id || ''),
      // The parcel is one box however many decks are in it; the price is not
      // collected on delivery (the customer paid us online), so it is 0 rather
      // than the order total — a non-zero productsPrice is what HFD reads as
      // cash to collect.
      packsHaloch: '1',
      productsPrice: 0,
    },
  };
}

// The public tracking page for a shipment's `randNumber` (NOT the shipment
// number — HFD's public page keys on the random one so a number cannot be
// walked). Null when we have no rand number to link to.
function trackingUrl(randNumber) {
  const r = String(randNumber == null ? '' : randNumber).trim();
  return r ? TRACK_BASE + '/' + encodeURIComponent(r) : null;
}

// --- impure: the only network layer ------------------------------------------

// One request helper. Resolves to { ok, status?, data?, buffer?, error? } and
// NEVER throws: a courier being down must not take a route with it. `raw` asks
// for the body as bytes (the label PDF) instead of JSON.
async function request(method, path, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) return { ok: false, error: 'no fetch implementation available' };
  const controller = new AbortController();
  let timer;
  try {
    const headers = {
      Authorization: 'Bearer ' + HFD_TOKEN,
      Accept: opts.raw ? 'application/pdf' : 'application/json',
    };
    const init = { method, headers, signal: controller.signal };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetchImpl(BASE_URL + path, init);
    const contentType = String((res.headers && res.headers.get('content-type')) || '');
    if (opts.raw && !contentType.includes('application/json')) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) return { ok: false, status: res.status, error: 'hfd http ' + res.status };
      return { ok: true, status: res.status, buffer: buf, contentType };
    }
    const data = typeof res.json === 'function' ? await res.json().catch(() => ({})) : {};
    if (!res.ok) return { ok: false, status: res.status, error: 'hfd http ' + res.status, data };
    return { ok: true, status: res.status, data, contentType };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// HFD reports a refusal in one of two shapes (`errorMessage` or `details`), and
// a transport failure in neither. Reduce all of them to one sentence the owner
// can act on, because "false" on a screen is not a reason.
function failureMessage(res, data) {
  const d = data || (res && res.data) || {};
  return String(d.errorMessage || d.details || (res && res.error) || 'שגיאה לא ידועה');
}

// Book the parcel. Returns { ok: true, shipmentNumber, randNumber } or
// { ok: false, error } — and { ok: false, skipped: true } while dormant, so a
// service with no credentials is distinguishable from one HFD refused.
async function createShipment(c, opts = {}) {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'hfd not configured' };
  const built = buildShipment(c);
  if (built.error) return { ok: false, error: built.error };

  const res = await request('POST', '/shipments/create', { body: built.payload, ...opts });
  const data = (res && res.data) || {};
  if (res.ok && data.shipmentNumber) {
    return {
      ok: true,
      shipmentNumber: String(data.shipmentNumber),
      randNumber: data.randNumber == null ? null : String(data.randNumber),
    };
  }
  return { ok: false, error: failureMessage(res, data), status: res.status };
}

// Cancel a booked shipment. HFD answers 200 with { status: 'OK' } — or with
// 'ERROR' plus a reason, which is NOT a transport failure and must not be
// reported as success.
async function cancelShipment(shipmentNumber, opts = {}) {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'hfd not configured' };
  const n = String(shipmentNumber == null ? '' : shipmentNumber).trim();
  if (!n) return { ok: false, error: 'no shipment number' };
  const res = await request('DELETE', '/shipments/' + encodeURIComponent(n), opts);
  const data = (res && res.data) || {};
  if (res.ok && String(data.status || '').toUpperCase() === 'OK') return { ok: true };
  return {
    ok: false,
    error: String(data.status_desc || failureMessage(res, data)),
    status: res.status,
  };
}

// The parcel's sticker, as PDF bytes. HFD serves it either as application/pdf or
// as JSON carrying a base64 string — their own plugin handles both, so we do
// too. Returns { ok: true, pdf } or { ok: false, error }.
async function fetchLabel(shipmentNumber, opts = {}) {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'hfd not configured' };
  const n = String(shipmentNumber == null ? '' : shipmentNumber).trim();
  if (!n) return { ok: false, error: 'no shipment number' };
  const res = await request('GET', '/shipments/' + encodeURIComponent(n) + '/label', {
    raw: true,
    ...opts,
  });
  if (!res.ok) return { ok: false, error: failureMessage(res), status: res.status };

  let pdf = res.buffer;
  if (!pdf && res.data && res.data.Base64String) {
    pdf = Buffer.from(String(res.data.Base64String), 'base64');
  }
  // A body that is not a PDF is a login page, an error document or an empty
  // 200 — handing it to the browser as application/pdf would show the owner a
  // broken viewer instead of a reason.
  if (!pdf || !pdf.length || !pdf.subarray(0, 4).toString('latin1').startsWith('%PDF')) {
    return { ok: false, error: 'HFD לא החזירה מדבקה תקינה' };
  }
  return { ok: true, pdf };
}

module.exports = {
  isConfigured,
  status,
  buildShipment,
  normalizePhone,
  splitStreet,
  trackingUrl,
  createShipment,
  cancelShipment,
  fetchLabel,
};
