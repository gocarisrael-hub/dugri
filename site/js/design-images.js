// design-images.js — buyer-facing reader for the owner's per-design image
// overrides (server/design-images.js + GET /api/design-images).
//
// The owner may replace a design's static store/gallery pictures with their own
// uploads. This module fetches that override map and lets products.html and
// js/product.js prefer an override over the shipped assets/designs/<id>/*.webp.
//
// EVERYTHING here is fail-safe: the shopper must always see a product and be able
// to buy, so a slow, failed, or malformed override fetch must never block or break
// the page — it just falls back to the static asset. The fetch is timeout-bounded
// (AbortController) and every path is validated to an our-own upload path.

// A stored path must be one the server produced (16-hex content hash + raster
// ext) — identical to the server's UPLOAD_PATH_RE. Defense in depth on the client
// too: never render an arbitrary URL an override map might somehow contain.
const UPLOAD_PATH_RE = /^\/content-uploads\/[a-f0-9]{16}\.(webp|jpe?g|png)$/;

// How long to wait for the override map before giving up and using static assets.
const FETCH_TIMEOUT_MS = 3000;

/** The validated override path for design `id` + `slot`, or null when there is
 *  no valid override. Tolerates any shape of `map` (missing/garbage → null). */
export function overrideFor(map, id, slot) {
  if (!map || typeof map !== 'object') return null;
  const bag = map[id];
  if (!bag || typeof bag !== 'object') return null;
  const p = bag[slot];
  return typeof p === 'string' && UPLOAD_PATH_RE.test(p) ? p : null;
}

/** Fetch the whole override map { designId: { slot: path } }. NEVER rejects:
 *  a network error, non-OK status, timeout, or non-JSON body all resolve to {}
 *  so callers keep the shipped static assets. */
export function loadDesignImages() {
  if (typeof fetch !== 'function') return Promise.resolve({});
  let timer = null;
  const opts = {};
  try {
    if (typeof AbortController === 'function') {
      const ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    }
  } catch {
    /* no AbortController — proceed without a hard timeout */
  }
  return fetch('/api/design-images', opts)
    .then((r) => (r && r.ok ? r.json() : { images: {} }))
    .then((data) => (data && data.images && typeof data.images === 'object' ? data.images : {}))
    .catch(() => ({}))
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}
