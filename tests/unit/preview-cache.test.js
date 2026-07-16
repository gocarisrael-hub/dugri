import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { makeRateLimiter, makePreviewCache, previewCacheKey } = require(
  path.join(__dirname, '../../server/preview-cache.js')
);

// The order-preview endpoint's rate limiter + result cache. These back two goals:
//  1. preview gets its OWN bucket so a typer never 429s the coupon/pay flow, and
//  2. repeated identical names return from cache with no Chrome spawn.

describe('preview rate limiter (separate bucket)', () => {
  it('allows up to `limit` hits per key in the window, then blocks', () => {
    let now = 1000;
    const rl = makeRateLimiter({ limit: 3, windowMs: 1000, now: () => now });
    expect(rl.ok('ip')).toBe(true);
    expect(rl.ok('ip')).toBe(true);
    expect(rl.ok('ip')).toBe(true);
    expect(rl.ok('ip')).toBe(false); // 4th within the window → blocked
  });

  it('keys are independent — one client blocking never affects another', () => {
    let now = 0;
    const rl = makeRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(rl.ok('a')).toBe(true);
    expect(rl.ok('a')).toBe(false); // a is out of budget
    expect(rl.ok('b')).toBe(true); // b is unaffected
  });

  it('recovers once hits age out of the trailing window', () => {
    let now = 0;
    const rl = makeRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(rl.ok('ip')).toBe(true);
    expect(rl.ok('ip')).toBe(false);
    now = 1001; // the first hit has now aged out
    expect(rl.ok('ip')).toBe(true);
  });

  it('caps the bucket map at maxKeys (evicts the oldest)', () => {
    let now = 0;
    const rl = makeRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 2, now: () => now });
    rl.ok('k1');
    rl.ok('k2');
    rl.ok('k3'); // pushes the map over 2 → oldest (k1) evicted
    expect(rl._buckets.has('k1')).toBe(false);
    expect(rl._buckets.has('k2')).toBe(true);
    expect(rl._buckets.has('k3')).toBe(true);
  });
});

describe('previewCacheKey', () => {
  it('is stable regardless of extra-field key order', () => {
    const a = previewCacheKey({ theme: 't', name: 'X', extraFields: { AGE: '30', YEARS: '5' } });
    const b = previewCacheKey({ theme: 't', name: 'X', extraFields: { YEARS: '5', AGE: '30' } });
    expect(a).toBe(b);
  });

  it('changes when any render input changes', () => {
    const base = { theme: 't', name: 'X', wordFont: 'F.ttf', chasers: false, customTitle: '' };
    const key = previewCacheKey(base);
    expect(previewCacheKey({ ...base, name: 'Y' })).not.toBe(key);
    expect(previewCacheKey({ ...base, wordFont: 'G.ttf' })).not.toBe(key);
    expect(previewCacheKey({ ...base, chasers: true })).not.toBe(key);
    expect(previewCacheKey({ ...base, customTitle: 'hi' })).not.toBe(key);
  });
});

describe('preview result cache', () => {
  it('returns a stored value for the same key, null for an unknown key', () => {
    const c = makePreviewCache();
    const k = c.key({ theme: 't', name: 'X' });
    expect(c.get(k)).toBeNull();
    c.set(k, { card: 'data:1' });
    expect(c.get(k)).toEqual({ card: 'data:1' });
    expect(c.get(c.key({ theme: 't', name: 'Z' }))).toBeNull();
  });

  it('expires entries past the TTL', () => {
    let now = 0;
    const c = makePreviewCache({ ttlMs: 100, now: () => now });
    const k = c.key({ theme: 't', name: 'X' });
    c.set(k, { card: 'data:1' });
    now = 50;
    expect(c.get(k)).toEqual({ card: 'data:1' }); // still fresh
    now = 201;
    expect(c.get(k)).toBeNull(); // aged out
  });

  it('evicts the least-recently-used entry past `max`', () => {
    const c = makePreviewCache({ max: 2 });
    const k1 = c.key({ theme: 't', name: 'A' });
    const k2 = c.key({ theme: 't', name: 'B' });
    const k3 = c.key({ theme: 't', name: 'C' });
    c.set(k1, { card: '1' });
    c.set(k2, { card: '2' });
    c.get(k1); // touch k1 → k2 is now the LRU
    c.set(k3, { card: '3' }); // over capacity → evicts k2
    expect(c.get(k1)).toEqual({ card: '1' });
    expect(c.get(k2)).toBeNull();
    expect(c.get(k3)).toEqual({ card: '3' });
  });
});
