import { describe, it, expect, vi, afterEach } from 'vitest';

// Unit tests for the buyer-facing pricing reader (site/js/pricing.js):
// fetchPricing is timeout-bounded + fail-safe and — critically — only reports
// ok:true for a WELL-FORMED payload. A store object with no integer now/was (an
// empty projection from a settings-load failure) must be rejected so the
// storefront never renders "undefined ₪".
import { fetchPricing, PRICING_FALLBACK } from '../../site/js/pricing.js';

const GOOD = {
  store: { now: 259, was: 299 },
  versions: {
    pdf: { enabled: false, price: 79 },
    pickup: { enabled: true, price: 259 },
    delivery: { enabled: false, price: 199 },
    custom: { enabled: false, price: 599 },
  },
};

function stub(body, { ok = true } = {}) {
  global.fetch = vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));
}

describe('fetchPricing — validated + fail-safe', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns the live pricing with ok:true for a well-formed payload', async () => {
    stub(GOOD);
    const p = await fetchPricing();
    expect(p.ok).toBe(true);
    expect(p.store).toEqual({ now: 259, was: 299 });
    expect(p.versions.pickup).toEqual({ enabled: true, price: 259 });
  });

  it('REJECTS a store with no integer now/was → falls back to defaults (ok:false)', async () => {
    // An empty store {} (e.g. effectivePricing after a settings-load failure)
    // would otherwise render "undefined ₪"; fetchPricing must not accept it.
    stub({ store: {}, versions: GOOD.versions });
    const p = await fetchPricing();
    expect(p.ok).toBe(false);
    expect(p.store).toEqual(PRICING_FALLBACK.store);
    expect(Number.isInteger(p.store.now)).toBe(true);
    expect(Number.isInteger(p.store.was)).toBe(true);
  });

  it('REJECTS a non-integer store price (string) → falls back to defaults', async () => {
    stub({ store: { now: 'oops', was: 299 }, versions: GOOD.versions });
    const p = await fetchPricing();
    expect(p.ok).toBe(false);
    expect(p.store).toEqual(PRICING_FALLBACK.store);
  });

  it('REJECTS a version missing its integer price / boolean enabled', async () => {
    const versions = { ...GOOD.versions, pickup: { enabled: true } }; // no price
    stub({ store: GOOD.store, versions });
    const p = await fetchPricing();
    expect(p.ok).toBe(false);
    expect(p.versions).toEqual(PRICING_FALLBACK.versions);
  });

  it('falls back on a non-OK status and on a network error', async () => {
    stub(GOOD, { ok: false });
    expect((await fetchPricing()).ok).toBe(false);

    global.fetch = vi.fn(() => Promise.reject(new Error('down')));
    const p = await fetchPricing();
    expect(p.ok).toBe(false);
    expect(p.store).toEqual(PRICING_FALLBACK.store);
  });
});
