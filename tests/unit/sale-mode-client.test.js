// Sale mode at the CLIENT (site/js/pricing.js): how the browser reads the
// server's sale block, and what applySale() paints from it.
//
// The load-bearing rule here is the FALLBACK. Every other number pricing.js
// falls back to is a price we are willing to show; a sale is a CLAIM — "this
// used to cost more" — and a claim we could not read from the server is one we
// must not make. So a failed/malformed/old-server response reports NO sale, and
// the struck price stays hidden rather than asserting a discount that may have
// ended.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fetchPricing, applySale, PRICING_FALLBACK } from '../../site/js/pricing.js';

const VERSIONS = {
  pdf: { enabled: false, price: 79 },
  pickup: { enabled: true, price: 199 },
  delivery: { enabled: false, price: 199 },
  custom: { enabled: false, price: 599 },
};
const LIVE = {
  store: { now: 199, was: 239 },
  versions: VERSIONS,
  sale: { on: true, label: 'מחיר השקה', banner: 'מחיר השקה · 199 ₪ במקום 239 ₪' },
};

function stub(body, { ok = true } = {}) {
  global.fetch = vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));
}

describe('fetchPricing — reading the sale block', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('passes a live sale through', async () => {
    stub(LIVE);
    const p = await fetchPricing();
    expect(p.sale).toEqual(LIVE.sale);
  });

  it('reports NO sale when the server says the sale is off', async () => {
    stub({ ...LIVE, sale: { on: false, label: 'מחיר השקה', banner: 'ignored' } });
    const p = await fetchPricing();
    expect(p.sale.on).toBe(false);
    expect(p.sale.banner).toBe('');
  });

  it('reports no sale for an OLDER server that omits the block (payload still valid)', async () => {
    stub({ store: { now: 199, was: 239 }, versions: VERSIONS });
    const p = await fetchPricing();
    // The rest of the payload is still accepted — a missing sale block is an old
    // server, not a broken one.
    expect(p.ok).toBe(true);
    expect(p.store).toEqual({ now: 199, was: 239 });
    expect(p.sale).toEqual(PRICING_FALLBACK.sale);
  });

  it('reports no sale when the response fails', async () => {
    stub(null, { ok: false });
    const p = await fetchPricing();
    expect(p.ok).toBe(false);
    expect(p.sale.on).toBe(false);
  });

  it('treats a truthy-but-not-true `on` as no sale', async () => {
    // 'true' / 1 read as on to a human but are not a boolean — the same posture
    // the server takes on flag writes.
    stub({ ...LIVE, sale: { on: 'true', label: 'x', banner: 'y' } });
    expect((await fetchPricing()).sale.on).toBe(false);
  });

  it('falls back to the default label when the server sends a blank/odd one', async () => {
    stub({ ...LIVE, sale: { on: true, label: '', banner: 42 } });
    const p = await fetchPricing();
    expect(p.sale.label).toBe('מחיר השקה');
    expect(p.sale.banner).toBe('');
  });
});

describe('applySale — what the page paints', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-sale');
    document.body.innerHTML =
      '<span class="sale-flag" data-sale-label>x</span>' +
      '<span class="sale-flag" data-sale-label>x</span>' +
      '<div class="sale-banner" data-sale-banner hidden></div>';
  });

  it('stamps data-sale="on" and fills every label + the banner', () => {
    applySale({ on: true, label: 'מבצע קיץ', banner: 'מבצע קיץ · 199 ₪' });
    expect(document.documentElement.getAttribute('data-sale')).toBe('on');
    const flags = [...document.querySelectorAll('[data-sale-label]')];
    expect(flags.map((f) => f.textContent)).toEqual(['מבצע קיץ', 'מבצע קיץ']);
    const banner = document.querySelector('[data-sale-banner]');
    expect(banner.textContent).toBe('מבצע קיץ · 199 ₪');
    expect(banner.hidden).toBe(false);
  });

  it('an empty banner stays hidden while the sale stays on', () => {
    applySale({ on: true, label: 'מחיר השקה', banner: '' });
    expect(document.documentElement.getAttribute('data-sale')).toBe('on');
    expect(document.querySelector('[data-sale-banner]').hidden).toBe(true);
  });

  it('stamps data-sale="off" and leaves the banner hidden when there is no sale', () => {
    applySale({ on: false, label: 'מחיר השקה', banner: 'לא אמור להופיע' });
    expect(document.documentElement.getAttribute('data-sale')).toBe('off');
    const banner = document.querySelector('[data-sale-banner]');
    expect(banner.hidden).toBe(true);
    expect(banner.textContent).toBe('');
  });

  it('a missing sale object is treated as no sale, not as a crash', () => {
    applySale(undefined);
    expect(document.documentElement.getAttribute('data-sale')).toBe('off');
  });

  it('writes owner text as TEXT — a label can never inject markup', () => {
    applySale({ on: true, label: '<img src=x onerror=alert(1)>', banner: '<b>bold</b>' });
    const flag = document.querySelector('[data-sale-label]');
    expect(flag.querySelector('img')).toBeNull();
    expect(flag.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('[data-sale-banner]').querySelector('b')).toBeNull();
  });
});
