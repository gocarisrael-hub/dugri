// Shared client helper: fetch the owner-editable pricing from the PUBLIC
// /api/pricing endpoint. The store price (now/struck-was) and each checkout
// version's { enabled, price } are edited by the owner from admin-pricing.html
// with no deploy; every storefront surface reads them through this helper.
//
// The fetch is TIMEOUT-BOUNDED (AbortController) and fail-safe. It always resolves
// to { store, versions, ok }: on a slow/failing/non-2xx/malformed response it
// returns the PRICING_FALLBACK launch defaults with `ok: false`; on success the
// live pricing with `ok: true`. Display-only surfaces (store price on
// products/index/product) can ignore `ok` and just show the numbers. The CHARGE
// path (collect.html checkout) MUST honour `ok` — when false it must NOT offer to
// pay at a guessed price, because the server would charge the live settings price
// the client couldn't read.
//
// PRICING_FALLBACK is the SINGLE client-side source of the launch defaults —
// imported everywhere a fallback is needed (never re-declared per page).

export const PRICING_FALLBACK = {
  store: { now: 199, was: 239 },
  versions: {
    pdf: { enabled: false, price: 79 },
    pickup: { enabled: true, price: 199 },
    delivery: { enabled: false, price: 199 },
    custom: { enabled: false, price: 599 },
  },
};

// A well-formed pricing payload: store.now/was are integers AND every known
// version carries an integer price + boolean enabled. A store object with no
// integer now/was (e.g. an empty projection from a settings-load failure) is
// REJECTED so the storefront never renders "undefined ₪" — the caller falls back
// to PRICING_FALLBACK instead.
function isValidPricing(j) {
  if (!j || !j.store || !j.versions) return false;
  if (!Number.isInteger(j.store.now) || !Number.isInteger(j.store.was)) return false;
  for (const v of Object.keys(PRICING_FALLBACK.versions)) {
    const info = j.versions[v];
    if (!info || typeof info.enabled !== 'boolean' || !Number.isInteger(info.price)) return false;
  }
  return true;
}

export async function fetchPricing(timeoutMs = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('/api/pricing', { signal: ctrl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (isValidPricing(j)) return { store: j.store, versions: j.versions, ok: true };
    throw new Error('bad shape');
  } catch {
    return {
      store: { ...PRICING_FALLBACK.store },
      versions: JSON.parse(JSON.stringify(PRICING_FALLBACK.versions)),
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
