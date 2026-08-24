// @vitest-environment jsdom
// PRICES GOING STALE IN AN OPEN TAB.
//
// Every page fetches /api/pricing once, on load, and never asks again. A tab
// left open — or one iOS Safari restores from its back/forward cache, which is
// what a phone does all day — keeps painting whatever was true when it loaded.
// That is how a launch price that ended hours ago stays on screen, struck-through
// 279 and all, in front of someone about to press Buy. Nothing is stale on the
// wire (no-cache HTML, hashed modules, an uncached API); the page just never
// asked twice.
//
// These tests are about WHEN it asks again, and — more importantly — when it
// must not repaint at all.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  repaintPricingOnReturn,
  __resetPricingRefresh,
  PRICING_FALLBACK,
} from '../../site/js/pricing.js';

const payload = (now, was) => ({
  store: { now, was },
  versions: {
    pdf: { enabled: false, price: 79 },
    pickup: { enabled: true, price: now },
    delivery: { enabled: true, price: now },
    custom: { enabled: false, price: 599 },
  },
  sale: { on: false, label: 'מחיר השקה', banner: '' },
});

function stub(body, { ok = true } = {}) {
  global.fetch = vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) }));
}

// The listeners live on window/document for the life of the module, so each case
// gets a fresh painter list and a fresh clock.
beforeEach(() => __resetPricingRefresh());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete global.fetch;
});

// A bfcache restore: no script re-runs, the DOM is exactly as it was left. This
// is the phone case — the one in the screenshots.
// Built as a plain Event with `persisted` set, rather than PageTransitionEvent —
// jsdom has the interface but the lint config does not list it as a global, and
// the listener only ever reads that one property.
function pageshow(persisted) {
  const e = new Event('pageshow');
  Object.defineProperty(e, 'persisted', { value: persisted });
  return e;
}
const restore = () => window.dispatchEvent(pageshow(true));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('repaintPricingOnReturn', () => {
  it('repaints with fresh prices when the tab is restored from the bfcache', async () => {
    stub(payload(199, 239));
    const paint = vi.fn();
    repaintPricingOnReturn(paint);
    expect(paint).not.toHaveBeenCalled(); // registering paints nothing

    restore();
    await flush();
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint.mock.calls[0][0].store).toEqual({ now: 199, was: 239 });
  });

  it('does NOT repaint on an ordinary (non-restored) pageshow', async () => {
    // The page's own load-time fetch has already painted; a second paint here
    // would be a duplicate request on every navigation.
    stub(payload(199, 239));
    const paint = vi.fn();
    repaintPricingOnReturn(paint);
    window.dispatchEvent(pageshow(false));
    await flush();
    expect(paint).not.toHaveBeenCalled();
  });

  it('NEVER paints the hardcoded fallback over a real price', async () => {
    // fetchPricing resolves to PRICING_FALLBACK on failure rather than throwing.
    // Painting that would replace a figure the server really sent with a guess —
    // strictly worse than the slightly old number already on the screen.
    stub(null, { ok: false });
    const paint = vi.fn();
    repaintPricingOnReturn(paint);
    restore();
    await flush();
    expect(paint).not.toHaveBeenCalled();
    // Guard the premise: the fallback IS what a failed fetch resolves to.
    expect(PRICING_FALLBACK.store.now).toEqual(expect.any(Number));
  });

  it('coalesces a pageshow and a visibilitychange into ONE request', async () => {
    // Returning to a tab can fire both. Two answers painting in arbitrary order
    // is a race for no benefit.
    stub(payload(199, 239));
    const paint = vi.fn();
    repaintPricingOnReturn(paint);
    restore();
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a quick app-switch, but asks again once the tab has sat a while', async () => {
    stub(payload(199, 239));
    const paint = vi.fn();
    repaintPricingOnReturn(paint);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    // Flicking between apps must not mean a request per flick.
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(paint).not.toHaveBeenCalled();

    // Six minutes later the figure on screen is worth re-checking.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('one page’s broken painter does not stop another from repainting', async () => {
    stub(payload(199, 239));
    const boom = vi.fn(() => {
      throw new Error('nope');
    });
    const ok = vi.fn();
    repaintPricingOnReturn(boom);
    repaintPricingOnReturn(ok);
    restore();
    await flush();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-function registration rather than throwing on return', async () => {
    stub(payload(199, 239));
    expect(() => repaintPricingOnReturn(null)).not.toThrow();
    restore();
    await flush();
  });
});
