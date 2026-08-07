// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// The DOWNSCALE LADDER (site/js/design-images.js: THUMB_WIDTHS, thumbSrc(px),
// thumbSrcset, wireThumbs).
//
// The owner uploads what her camera produced — ~3000 px wide, ~1 MB. Every
// storefront surface was serving that original: the products grid renders it
// into a 163 px tile, so /products.html shipped 33 MB of photographs, roughly a
// hundred times the pixels the screen can show. These tests pin the two halves
// of the fix: the URLs that ask for a right-sized derivative, and — the part
// that decides whether this is safe to ship — what happens when one of those
// derivatives is not there.
import { THUMB_WIDTHS, thumbSrc, thumbSrcset, wireThumbs } from '../../site/js/design-images.js';

const UP = '/content-uploads/aaaaaaaaaaaaaaaa.png';
const SHIPPED = 'assets/designs/bachelorette/store.webp';

describe('thumbSrc — one rung of the ladder', () => {
  it('with no width, still asks for the default derivative (the picker path)', () => {
    expect(thumbSrc(UP)).toBe('/design-thumb/aaaaaaaaaaaaaaaa.png');
  });

  it('with a width, puts it in the path so every rung is its own immutable URL', () => {
    expect(thumbSrc(UP, 400)).toBe('/design-thumb/400/aaaaaaaaaaaaaaaa.png');
    expect(thumbSrc(UP, 800)).toBe('/design-thumb/800/aaaaaaaaaaaaaaaa.png');
    expect(thumbSrc(UP, 1200)).toBe('/design-thumb/1200/aaaaaaaaaaaaaaaa.png');
  });

  // The server serves a CLOSED set (an open ?w= would let any client spawn
  // Python and fill the volume). A width outside it would 404 for every shopper,
  // so it is refused here rather than rendered into a doomed URL.
  it('refuses a width the server does not serve', () => {
    for (const bad of [401, 1201, 0, -400, 1600, '400', 4e3, NaN]) {
      expect(thumbSrc(UP, bad)).toBe(null);
    }
  });

  // An absent width is "no width", not a bad one: a caller that has nothing to
  // pass gets the default derivative rather than a null it would have to handle.
  it('treats an absent width as no width at all', () => {
    expect(thumbSrc(UP, null)).toBe(thumbSrc(UP));
    expect(thumbSrc(UP, undefined)).toBe(thumbSrc(UP));
  });

  it('still refuses anything that is not one of our own uploads, at any width', () => {
    for (const bad of ['', null, 'https://evil.example/x.png', SHIPPED]) {
      expect(thumbSrc(bad, 800)).toBe(null);
    }
  });
});

describe('thumbSrcset — the candidate list the browser picks from', () => {
  it('offers every rung with its width descriptor', () => {
    expect(thumbSrcset(UP)).toBe(
      '/design-thumb/400/aaaaaaaaaaaaaaaa.png 400w, ' +
        '/design-thumb/800/aaaaaaaaaaaaaaaa.png 800w, ' +
        '/design-thumb/1200/aaaaaaaaaaaaaaaa.png 1200w'
    );
  });

  // 1200 is the ceiling on purpose: a 390 px phone at DPR 3 resolves 1170 device
  // px, so a wider rung would be bytes no phone screen can display — which is
  // the entire bug being fixed.
  it('tops out at what a phone screen can actually resolve', () => {
    expect(THUMB_WIDTHS).toEqual([400, 800, 1200]);
    expect(Math.max(...THUMB_WIDTHS)).toBeLessThanOrEqual(1200);
  });

  it('gives a shipped render no ladder — there is no derivative of it', () => {
    expect(thumbSrcset(SHIPPED)).toBe(null);
    expect(thumbSrcset('')).toBe(null);
  });
});

describe('wireThumbs — the ladder is only safe because of the fallback', () => {
  const img = () => document.createElement('img');

  it('serves the ladder, and keeps the ORIGINAL on src underneath it', () => {
    const el = img();
    wireThumbs(el, UP, '45vw');
    expect(el.srcset).toBe(thumbSrcset(UP));
    expect(el.getAttribute('sizes')).toBe('45vw');
    // src is the full upload: it is what the browser falls back to, and what a
    // client with no srcset support loads.
    expect(el.getAttribute('src')).toBe(UP);
  });

  // THE CRITICAL PATH. A srcset candidate that 404s does NOT make the browser
  // try `src` on its own — the image just fails. Derivatives legitimately 404
  // (a box without Pillow, an undecodable upload), so without this the fix would
  // trade a slow storefront for a broken one.
  it('a failed derivative drops the ladder so the browser re-selects the original', () => {
    const el = img();
    const onFail = vi.fn();
    wireThumbs(el, UP, '45vw', onFail);
    el.dispatchEvent(new Event('error'));
    expect(el.srcset).toBe('');
    expect(el.hasAttribute('sizes')).toBe(false);
    expect(el.getAttribute('src')).toBe(UP);
    // The surface's own degradation has NOT been spent: the original is still
    // worth trying, and it is the owner's actual photo.
    expect(onFail).not.toHaveBeenCalled();
  });

  it('only once the ORIGINAL also fails does the surface degrade', () => {
    const el = img();
    const onFail = vi.fn();
    wireThumbs(el, UP, '45vw', onFail);
    el.dispatchEvent(new Event('error')); // derivative gone
    el.dispatchEvent(new Event('error')); // the upload itself is gone
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('cannot loop: a failing fallback does not re-enter the handler', () => {
    const el = img();
    const onFail = vi.fn();
    wireThumbs(el, UP, '45vw', onFail);
    for (let i = 0; i < 5; i++) el.dispatchEvent(new Event('error'));
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  // A shipped render (or a custom design's template SVG) has no derivative, so
  // it must behave exactly as it did before the ladder existed.
  it('a picture with no ladder loads plainly and still degrades once', () => {
    const el = img();
    const onFail = vi.fn();
    wireThumbs(el, SHIPPED, '45vw', onFail);
    expect(el.srcset).toBe('');
    expect(el.getAttribute('src')).toBe(SHIPPED);
    el.dispatchEvent(new Event('error'));
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('omitting sizes is allowed and sets no attribute', () => {
    const el = img();
    wireThumbs(el, UP);
    expect(el.hasAttribute('sizes')).toBe(false);
    expect(el.srcset).toBe(thumbSrcset(UP));
  });
});
