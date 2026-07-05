// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DESIGNS,
  PUBLIC_DESIGNS,
  THEME_BY_DESIGN,
  VISIBILITY_BY_THEME,
  visibilityForDesign,
  isPublicDesign,
} from '../../site/js/designs.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const themesPath = path.join(__dirname, '..', '..', 'generator', 'themes.json');

let themes;
beforeAll(() => {
  themes = require(themesPath);
});

describe('VISIBILITY_BY_THEME mirrors themes.json', () => {
  it('matches each mapped theme’s visibility in themes.json (default public)', () => {
    for (const theme of Object.values(THEME_BY_DESIGN)) {
      const expected = themes[theme].visibility || 'public';
      expect(VISIBILITY_BY_THEME[theme], `visibility for ${theme}`).toBe(expected);
    }
  });
});

describe('visibilityForDesign / isPublicDesign', () => {
  it('resolves a design to its theme visibility (all public today)', () => {
    for (const d of DESIGNS) {
      expect(visibilityForDesign(d.id)).toBe('public');
      expect(isPublicDesign(d.id)).toBe(true);
    }
  });

  it('treats an unknown/unmapped design as public', () => {
    expect(visibilityForDesign('does-not-exist')).toBe('public');
    expect(isPublicDesign('does-not-exist')).toBe(true);
  });

  it('honors a private theme via an injected visibility map', () => {
    // bachelorette maps to the 'bachelorette' theme. Marking that theme private
    // in an override map must flip the design to private/non-public.
    const priv = { bachelorette: 'private' };
    expect(visibilityForDesign('bachelorette', priv)).toBe('private');
    expect(isPublicDesign('bachelorette', priv)).toBe(false);
    // A different design (mapped to another theme) stays public under that map.
    expect(isPublicDesign('neon', priv)).toBe(true);
  });
});

describe('PUBLIC_DESIGNS filter', () => {
  it('every DESIGNS entry carries visibility + public fields', () => {
    for (const d of DESIGNS) {
      expect(typeof d.visibility).toBe('string');
      expect(typeof d.public).toBe('boolean');
      expect(d.public).toBe(d.visibility !== 'private');
    }
  });

  it('PUBLIC_DESIGNS excludes any private design and keeps all public ones', () => {
    // The filter is exactly the public subset of DESIGNS...
    expect(PUBLIC_DESIGNS).toEqual(DESIGNS.filter((d) => d.public));
    // ...and never contains a private design.
    expect(PUBLIC_DESIGNS.every((d) => d.public)).toBe(true);
    // All themes are public today, so nothing is filtered out yet.
    expect(PUBLIC_DESIGNS.length).toBe(DESIGNS.length);
  });

  it('a synthetic private design is dropped by the same public filter', () => {
    const withPrivate = [
      { id: 'pub', public: true },
      { id: 'sekret', public: false },
    ];
    const publicOnly = withPrivate.filter((d) => d.public);
    expect(publicOnly.map((d) => d.id)).toEqual(['pub']);
  });
});
