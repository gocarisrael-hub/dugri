// preview-cache.js — the order-preview endpoint's own rate limiter + result cache.
//
// The live name-preview render is expensive: each POST /api/preview spawns a
// fresh Python process + headless Chrome. Two small in-memory structures keep it
// snappy and keep it from starving the pay/coupon flow:
//
//   * a SEPARATE rate-limit bucket (its own limit + map) so an eager typer's
//     preview requests never eat into — or get throttled by — the coupon oracle's
//     budget; and
//   * an LRU-ish TTL cache keyed by the exact render inputs, so repeated identical
//     names return instantly with no Chrome spawn (and don't count against the
//     limit — the caller checks the cache first).
//
// Both are per-process (reset on redeploy) and bounded so they can't grow without
// limit. `now` is injectable for deterministic tests.

/**
 * A tiny sliding-window rate limiter keyed by an arbitrary string (e.g. client
 * IP). `ok(key)` records a hit and returns false once `limit` hits fall inside
 * the trailing `windowMs`. The bucket map is capped at `maxKeys` (oldest evicted)
 * so a flood of distinct keys can't OOM the process.
 */
function makeRateLimiter({
  limit = 60,
  windowMs = 60 * 1000,
  maxKeys = 10000,
  now = Date.now,
} = {}) {
  const buckets = new Map();
  function ok(key) {
    const t = now();
    const hits = (buckets.get(key) || []).filter((ts) => t - ts < windowMs);
    if (hits.length >= limit) {
      buckets.set(key, hits);
      return false;
    }
    hits.push(t);
    buckets.set(key, hits);
    if (buckets.size > maxKeys) {
      buckets.delete(buckets.keys().next().value);
    }
    return true;
  }
  return { ok, _buckets: buckets };
}

/** Stable cache key for a render: inputs in a fixed order, extra-fields sorted so
 *  key order never changes the key. */
function previewCacheKey(parts = {}) {
  const ef = {};
  const raw = parts.extraFields && typeof parts.extraFields === 'object' ? parts.extraFields : {};
  Object.keys(raw)
    .sort()
    .forEach((k) => {
      ef[k] = raw[k];
    });
  return JSON.stringify([
    String(parts.theme || ''),
    String(parts.name || ''),
    String(parts.wordFont || ''),
    ef,
    !!parts.chasers,
    String(parts.customTitle || ''),
  ]);
}

/**
 * An in-memory preview-result cache. `get` returns the stored value (refreshing
 * its recency) or null when missing/expired; `set` stores a value and evicts the
 * oldest entries past `max`. TTL-bounded via `ttlMs`.
 */
function makePreviewCache({ max = 200, ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const store = new Map();
  function get(key) {
    const hit = store.get(key);
    if (!hit) return null;
    if (now() - hit.at > ttlMs) {
      store.delete(key);
      return null;
    }
    // re-insert so Map insertion order tracks recency (LRU eviction below)
    store.delete(key);
    store.set(key, hit);
    return hit.value;
  }
  function set(key, value) {
    store.set(key, { value, at: now() });
    while (store.size > max) {
      store.delete(store.keys().next().value);
    }
  }
  return { get, set, key: previewCacheKey, _store: store, size: () => store.size };
}

module.exports = { makeRateLimiter, makePreviewCache, previewCacheKey };
