// THE NUMBERS A CARD COMPANY QUOTES BACK AT YOU.
//
// A chargeback or a "did this go through?" arrives citing a number — an approval
// number, a PeleCard voucher (שובר), a transaction id — and never our order id.
// Every paid order has stored those numbers since they were added, but no screen
// showed them, so answering meant an API query. This file reads them off an order
// for the edit dialog, and finds the order a quoted number belongs to.
//
// Two things here are easy to get wrong and are said out loud on purpose:
//
// - The approval number and the voucher are BOTH plain 7-digit numbers on a
//   PeleCard charge. An unlabelled number teaches nothing, so every value carries
//   its name.
// - The voucher was not stored before #630. On an older PeleCard charge it is
//   simply absent, so a voucher that finds nothing proves nothing. That sentence
//   is shown wherever the absence matters, not left for someone under time
//   pressure to infer. Tranzila has no voucher at all (see decideTranzilaRow in server/index.js).

export const PROVIDER_LABELS = {
  pelecard: 'פלאקארד',
  tranzila: 'טרנזילה',
  coupon: 'קופון 100% — לא בוצע חיוב',
};

export const REF_LABELS = {
  approval: 'מספר אישור',
  voucher: 'שובר',
  transaction: 'מזהה עסקה',
};

export const VOUCHER_MISSING_NOTE =
  'מספר שובר לא נשמר בתשלום הזה (תשלומים ישנים נשמרו בלי שובר). אם השובר שבמכתב לא נמצא, זה לא מוכיח שזו לא ההזמנה — חפשו לפי מספר האישור.';

// The one place a charge reads its identifiers from. `src` is the order itself
// for the purchase, or order.shipping for a delivery upgrade, which is its own
// charge and so its own dispute.
function chargeFrom(src, kind) {
  const method = src.paid_method || null;
  const refs = [];
  if (src.paid_approval_no) refs.push({ key: 'approval', value: String(src.paid_approval_no) });
  if (src.paid_voucher_no) refs.push({ key: 'voucher', value: String(src.paid_voucher_no) });
  if (src.paid_transaction_id) {
    refs.push({ key: 'transaction', value: String(src.paid_transaction_id) });
  }
  for (const r of refs) r.label = REF_LABELS[r.key];
  return {
    kind,
    label: kind === 'shipping' ? 'תוספת משלוח' : 'ההזמנה',
    method,
    methodLabel: method ? PROVIDER_LABELS[method] || method : null,
    paidAt: src.paid_at || null,
    amount: src.charged_total != null ? Number(src.charged_total) : null,
    refs,
    // Only a PeleCard charge ever had a voucher to lose.
    note: method === 'pelecard' && !src.paid_voucher_no ? VOUCHER_MISSING_NOTE : null,
  };
}

// Every settled charge on a collection: the purchase, then a paid delivery
// upgrade. An unpaid order has no charge and returns [].
export function paymentCharges(c) {
  const order = c && c.order;
  if (!order) return [];
  const out = [];
  if (order.paid) out.push(chargeFrom(order, 'order'));
  if (order.shipping && order.shipping.paid) out.push(chargeFrom(order.shipping, 'shipping'));
  return out;
}

// What the owner typed, the way it is compared: spaces and dashes dropped (a
// number read off a letter or a phone call arrives grouped), case folded for a
// PeleCard transaction GUID.
export function normalizeRef(s) {
  return String(s == null ? '' : s)
    .replace(/[\s\-–]/g, '')
    .toLowerCase();
}

// The collections a quoted number belongs to, with WHICH number it matched, on
// which charge. EXACT match only: two orders' 7-digit numbers routinely share a
// run of digits, and a substring hit would hand her the wrong customer.
export function findByPaymentRef(collections, query) {
  const q = normalizeRef(query);
  if (!q) return [];
  const hits = [];
  for (const c of collections || []) {
    for (const charge of paymentCharges(c)) {
      for (const ref of charge.refs) {
        if (normalizeRef(ref.value) === q) hits.push({ collection: c, charge, ref });
      }
    }
  }
  return hits;
}
