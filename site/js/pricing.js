// Shared client helper: fetch the owner-editable pricing from the PUBLIC
// /api/pricing endpoint. The store price (now/struck-was) and each checkout
// version's { enabled, price } are edited by the owner from admin-pricing.html
// with no deploy; every storefront surface reads them through this helper.
//
// The fetch is TIMEOUT-BOUNDED (AbortController) and fail-safe: a slow, failing,
// non-2xx or malformed response resolves to PRICING_FALLBACK (the launch
// defaults) so a price is never blank and page init never blocks on the network.

export const PRICING_FALLBACK = {
  store: { now: 199, was: 239 },
  versions: {
    pdf: { enabled: false, price: 79 },
    pickup: { enabled: true, price: 199 },
    delivery: { enabled: false, price: 199 },
    custom: { enabled: false, price: 599 },
  },
};

export async function fetchPricing(timeoutMs = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('/api/pricing', { signal: ctrl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (j && j.store && j.versions) return j;
    return PRICING_FALLBACK;
  } catch {
    return PRICING_FALLBACK;
  } finally {
    clearTimeout(timer);
  }
}
