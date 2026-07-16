import { describe, it, expect, vi, afterEach } from 'vitest';

// Unit tests for the buyer-facing override reader (site/js/design-images.js):
// overrideFor validation and loadDesignImages fail-safe behaviour (a failed,
// non-OK, or malformed fetch must resolve to {} so the static assets stand).
import { overrideFor, loadDesignImages } from '../../site/js/design-images.js';

const P1 = '/content-uploads/aaaaaaaaaaaaaaaa.png';

describe('overrideFor — validated per-design slot lookup', () => {
  it('returns the path for a valid our-own upload, else null', () => {
    const map = { posttrip: { board: P1 } };
    expect(overrideFor(map, 'posttrip', 'board')).toBe(P1);
    expect(overrideFor(map, 'posttrip', 'front')).toBe(null); // slot unset
    expect(overrideFor(map, 'birthday', 'board')).toBe(null); // design unset
  });
  it('rejects off-origin / malformed paths and tolerates garbage maps', () => {
    expect(overrideFor({ x: { store: 'https://evil.example/a.png' } }, 'x', 'store')).toBe(null);
    expect(overrideFor({ x: { store: '/content-uploads/not-a-hash.png' } }, 'x', 'store')).toBe(
      null
    );
    expect(overrideFor(null, 'x', 'store')).toBe(null);
    expect(overrideFor({ x: 'not-an-object' }, 'x', 'store')).toBe(null);
    expect(overrideFor({}, 'x', 'store')).toBe(null);
  });
});

describe('loadDesignImages — timeout-bounded + fail-safe (never rejects)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns the images map on a 200', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ images: { neon: { store: P1 } } }),
      })
    );
    await expect(loadDesignImages()).resolves.toEqual({ neon: { store: P1 } });
  });

  it('resolves to {} on a network error (fail-safe)', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('network down')));
    await expect(loadDesignImages()).resolves.toEqual({});
  });

  it('resolves to {} on a non-OK status', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    await expect(loadDesignImages()).resolves.toEqual({});
  });

  it('resolves to {} on a malformed body (no images object)', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: true }) })
    );
    await expect(loadDesignImages()).resolves.toEqual({});
  });
});
