import { describe, it, expect } from 'vitest';

// Unit tests for the pure per-design override helpers in site/js/product.js.
// Importing the module in jsdom does NOT boot the page (boot only auto-runs when a
// #galleryTrack element exists, which a bare test import has no reason to create),
// so these exercise the exported helpers directly.
import {
  overrideKeys,
  overrideText,
  photosFromOverride,
  galleryShots,
} from '../../site/js/product.js';

const P1 = '/content-uploads/aaaaaaaaaaaaaaaa.png';
const P2 = '/content-uploads/bbbbbbbbbbbbbbbb.webp';

describe('overrideKeys — per-design content-override keys', () => {
  it('encodes the design id into name/about/photos keys (kebab, page-shared)', () => {
    expect(overrideKeys('bachelorette')).toEqual({
      name: 'product-bachelorette-name',
      about: 'product-bachelorette-about',
      photos: 'product-bachelorette-photos',
    });
    // every key stays within the server's key shape (alnum start, kebab, ≤61)
    const KEY_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
    for (const id of ['bachelorette', 'marriage', 'kids', 'posttrip']) {
      for (const k of Object.values(overrideKeys(id))) expect(KEY_RE.test(k)).toBe(true);
    }
  });
});

describe('overrideText — a saved text override wins, else null', () => {
  it('returns the override text when present, null otherwise', () => {
    expect(overrideText({ 'product-neon-about': { text: 'חדש' } }, 'product-neon-about')).toBe(
      'חדש'
    );
    // an empty string is a valid (blanked) override, not "absent"
    expect(overrideText({ k: { text: '' } }, 'k')).toBe('');
    expect(overrideText({}, 'k')).toBe(null);
    expect(overrideText(null, 'k')).toBe(null);
    // an img-only entry has no text override
    expect(overrideText({ k: { img: '/x' } }, 'k')).toBe(null);
  });
});

describe('photosFromOverride — the owner’s custom photos (validated)', () => {
  it('returns only our-own upload paths for the design’s photos key', () => {
    const ov = { 'product-neon-photos': { imgs: [P1, 'https://evil/x.png', P2] } };
    expect(photosFromOverride(ov, 'neon')).toEqual([P1, P2]); // off-origin dropped
  });
  it('is [] when there is no override or an empty array', () => {
    expect(photosFromOverride({}, 'neon')).toEqual([]);
    expect(photosFromOverride({ 'product-neon-photos': { imgs: [] } }, 'neon')).toEqual([]);
    expect(photosFromOverride(null, 'neon')).toEqual([]);
    // a photos key for a DIFFERENT design must not leak in
    expect(photosFromOverride({ 'product-kids-photos': { imgs: [P1] } }, 'neon')).toEqual([]);
  });
});

describe('galleryShots — custom photos replace the defaults, else fall back', () => {
  const design = {
    id: 'neon',
    name: 'ניאון',
    thumb: 'assets/designs/neon/thumb.webp',
    thumbs: {
      front: 'assets/designs/neon/thumb-front.webp',
      back: 'assets/designs/neon/thumb-back.webp',
      board: 'assets/designs/neon/thumb-board.webp',
    },
  };

  it('uses the owner’s custom photos when present', () => {
    const shots = galleryShots(design, { 'product-neon-photos': { imgs: [P1, P2] } });
    expect(shots.map((s) => s.src)).toEqual([P1, P2]);
    // each shot carries an accessible per-design label
    expect(shots[0].label).toContain(design.name);
  });

  it('falls back to the design’s default hi-res renders when there are no custom photos', () => {
    const shots = galleryShots(design, {});
    // front/back/board hi-res renders (never the tiny thumb-*.webp)
    expect(shots.map((s) => s.src)).toEqual([
      'assets/designs/neon/gallery-front.webp',
      'assets/designs/neon/gallery-back.webp',
      'assets/designs/neon/gallery-board.webp',
    ]);
    for (const s of shots) expect(s.src).not.toMatch(/thumb-(front|back|board)\.webp$/);
  });

  it('skips the board render for a boardless design', () => {
    const kids = { id: 'kids', name: 'ילדים', thumbs: { front: 'f', back: 'b' } };
    const shots = galleryShots(kids, {});
    expect(shots.map((s) => s.src)).toEqual([
      'assets/designs/kids/gallery-front.webp',
      'assets/designs/kids/gallery-back.webp',
    ]);
  });

  it('prefers a per-design SLOT override over the static render, else falls back per-slot', () => {
    // Only the board slot is overridden → front/back keep their static renders.
    const map = { neon: { board: P1 } };
    const shots = galleryShots(design, {}, map);
    expect(shots.map((s) => s.src)).toEqual([
      'assets/designs/neon/gallery-front.webp',
      'assets/designs/neon/gallery-back.webp',
      P1, // owner's uploaded board picture
    ]);
  });

  it('an override shot carries the static render as `fallback` (broken-file degrade)', () => {
    const map = { neon: { board: P1 } };
    const shots = galleryShots(design, {}, map);
    // The override slide points its onerror at the shipped static asset…
    expect(shots[2]).toMatchObject({ src: P1, fallback: 'assets/designs/neon/gallery-board.webp' });
    // …while a non-overridden slide has no fallback (it IS the static asset).
    expect(shots[0].fallback).toBeUndefined();
    expect(shots[1].fallback).toBeUndefined();
  });

  it('ignores a malformed/off-origin override path and keeps the static asset', () => {
    const map = {
      neon: { front: 'https://evil.example/x.png', back: '/content-uploads/nope.gif' },
    };
    const shots = galleryShots(design, {}, map);
    expect(shots.map((s) => s.src)).toEqual([
      'assets/designs/neon/gallery-front.webp',
      'assets/designs/neon/gallery-back.webp',
      'assets/designs/neon/gallery-board.webp',
    ]);
  });

  it('curated custom photos still win over per-slot overrides', () => {
    const map = { neon: { front: P1, back: P2, board: P1 } };
    const shots = galleryShots(design, { 'product-neon-photos': { imgs: [P2] } }, map);
    expect(shots.map((s) => s.src)).toEqual([P2]); // the curated carousel wins
  });
});
