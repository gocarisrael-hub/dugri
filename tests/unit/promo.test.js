// @vitest-environment node
// The shape rules for the home-page "new game" block (server/promo.js).
//
// This module is the security boundary between the admin panel and an
// unauthenticated public endpoint, so the tests are weighted accordingly: most of
// them are about what must NOT be storable — an off-site photo, a javascript:
// button, a section switched on with nothing in it.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { DEFAULT_PROMO, validatePromo, publicPromo } = require(
  path.join(__dirname, '..', '..', 'server', 'promo.js')
);

const PHOTO = '/content-uploads/0123456789abcdef.webp';
const block = (over = {}) => ({ ...DEFAULT_PROMO, ...over });
const live = (over = {}) => block({ enabled: true, title: 'משחק חדש', ...over });

describe('validatePromo', () => {
  it('accepts the shipped default', () => {
    expect(validatePromo(DEFAULT_PROMO)).toBeNull();
  });

  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 'x', 7, []]) {
      expect(validatePromo(bad)).toBe('value must be an object');
    }
  });

  it('requires real booleans for the two switches', () => {
    expect(validatePromo(block({ enabled: 'true' }))).toMatch(/enabled must be a boolean/);
    expect(validatePromo(block({ cta2_enabled: 1 }))).toMatch(/cta2_enabled must be a boolean/);
  });

  it('bounds position and background to their choices', () => {
    expect(validatePromo(block({ position: 'middle' }))).toMatch(/position must be one of/);
    expect(validatePromo(block({ background: 'pink' }))).toMatch(/background must be one of/);
    expect(validatePromo(block({ position: 'after' }))).toBeNull();
    expect(validatePromo(block({ background: 'white' }))).toBeNull();
  });

  it('caps every text field', () => {
    expect(validatePromo(block({ badge: 'x'.repeat(15) }))).toMatch(/badge must be at most/);
    expect(validatePromo(live({ title: 'x'.repeat(61) }))).toMatch(/title must be at most/);
    expect(validatePromo(block({ sub: 'x'.repeat(301) }))).toMatch(/sub must be at most/);
  });

  it('allows newlines in the sub-title but nowhere else', () => {
    expect(validatePromo(block({ sub: 'שורה\n\nשורה' }))).toBeNull();
    expect(validatePromo(block({ badge: 'a\nb' }))).toMatch(/single line/);
    expect(validatePromo(live({ title: 'a\nb' }))).toMatch(/single line/);
  });

  it('rejects control characters that would be invisible in the admin field', () => {
    expect(validatePromo(live({ title: 'a\u0001b' }))).toMatch(/control characters/);
    expect(validatePromo(block({ sub: 'a\u0007b' }))).toMatch(/control characters/);
  });

  it('only stores photos that are our own uploads', () => {
    expect(validatePromo(block({ photos: [{ src: PHOTO, alt: '' }] }))).toBeNull();
    for (const src of [
      'https://evil.example/x.png',
      '//evil.example/x.png',
      '/content-uploads/../secret.png',
      '/content-uploads/0123456789abcdef.svg',
      '/content-uploads/nothex.webp',
    ]) {
      expect(validatePromo(block({ photos: [{ src, alt: '' }] }))).toMatch(
        /photo 1 src must be an uploaded/
      );
    }
  });

  it('bounds the photo count and the alt text', () => {
    const four = Array.from({ length: 4 }, () => ({ src: PHOTO, alt: '' }));
    expect(validatePromo(block({ photos: four }))).toMatch(/at most 3 items/);
    expect(validatePromo(block({ photos: [{ src: PHOTO, alt: 'x'.repeat(121) }] }))).toMatch(
      /photo 1 alt must be at most/
    );
    expect(validatePromo(block({ photos: 'nope' }))).toBe('photos must be an array');
  });

  it('refuses a button href that is not https:// or a same-site path', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      '//evil.example',
      'http://evil.example',
      'evil.example',
    ]) {
      expect(validatePromo(block({ cta_url: url }))).toMatch(/cta url must start with/);
    }
    expect(validatePromo(block({ cta_url: 'https://dugri.co.il/x' }))).toBeNull();
    expect(validatePromo(block({ cta_url: '/how.html' }))).toBeNull();
  });

  it('requires both halves of a button that is on, and neither of one that is off', () => {
    expect(validatePromo(block({ cta_text: '' }))).toMatch(/cta text cannot be empty/);
    // The second button off: its two blank fields are the normal resting state.
    expect(validatePromo(block({ cta2_enabled: false, cta2_text: '', cta2_url: '' }))).toBeNull();
    expect(validatePromo(block({ cta2_enabled: true, cta2_text: '', cta2_url: '/x' }))).toMatch(
      /cta2 text cannot be empty/
    );
    expect(
      validatePromo(block({ cta2_enabled: true, cta2_text: 'איך משחקים', cta2_url: '/how.html' }))
    ).toBeNull();
  });

  it('will not switch on a section with no title', () => {
    expect(validatePromo(block({ enabled: true }))).toMatch(/title cannot be empty/);
    expect(validatePromo(block({ enabled: true, title: '   ' }))).toMatch(/title cannot be empty/);
    // Off, an empty title is fine — that is the shipped state.
    expect(validatePromo(block({ enabled: false, title: '' }))).toBeNull();
  });
});

describe('publicPromo', () => {
  it('answers null while the section is off — the copy never goes on the wire', () => {
    expect(publicPromo(DEFAULT_PROMO)).toBeNull();
    expect(publicPromo(block({ title: 'סוד', sub: 'לא לפרסום' }))).toBeNull();
    expect(publicPromo(null)).toBeNull();
  });

  it('projects a live block, dropping the fields a visitor has no use for', () => {
    const out = publicPromo(live({ photos: [{ src: PHOTO, alt: 'קלפים' }] }));
    expect(out).toEqual({
      position: 'before',
      background: 'sand',
      badge: 'חדש',
      title: 'משחק חדש',
      sub: '',
      photos: [{ src: PHOTO, alt: 'קלפים' }],
      cta_text: 'לרכישה ›',
      cta_url: '/products.html',
      cta2: null,
    });
    expect(out).not.toHaveProperty('enabled');
    expect(out).not.toHaveProperty('cta2_enabled');
  });

  it('folds the second button into one object, or drops it when it is off', () => {
    expect(
      publicPromo(live({ cta2_enabled: true, cta2_text: 'איך', cta2_url: '/how.html' })).cta2
    ).toEqual({ text: 'איך', url: '/how.html' });
    expect(
      publicPromo(live({ cta2_enabled: false, cta2_text: 'איך', cta2_url: '/x' })).cta2
    ).toBeNull();
  });

  it('re-filters photos on the way out, for data stored before a rule existed', () => {
    const out = publicPromo(
      live({
        photos: [
          { src: 'https://evil.example/x.png', alt: '' },
          { src: PHOTO, alt: '' },
        ],
      })
    );
    expect(out.photos).toEqual([{ src: PHOTO, alt: '' }]);
  });
});
