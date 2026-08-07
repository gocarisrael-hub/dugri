// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DESIGNS,
  THEME_BY_DESIGN,
  LANGUAGE_BY_THEME,
  languageForDesign,
  extraFieldsForDesign,
} from '../../site/js/designs.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const themesPath = path.join(__dirname, '..', '..', 'generator', 'themes.json');

let themes;
beforeAll(() => {
  themes = require(themesPath);
});

describe('LANGUAGE_BY_THEME mirrors themes.json', () => {
  it("matches each mapped theme's `language` field in themes.json", () => {
    for (const theme of Object.values(THEME_BY_DESIGN)) {
      expect(LANGUAGE_BY_THEME[theme], `language for ${theme}`).toBe(themes[theme].language);
    }
  });

  it('covers every theme present in themes.json', () => {
    for (const theme of Object.keys(themes)) {
      expect(LANGUAGE_BY_THEME[theme], `LANGUAGE_BY_THEME has ${theme}`).toBe(
        themes[theme].language
      );
    }
  });

  it('only maps to the two supported languages', () => {
    for (const lang of Object.values(LANGUAGE_BY_THEME)) {
      expect(['english', 'hebrew']).toContain(lang);
    }
  });
});

describe('languageForDesign', () => {
  it('resolves each orderable design to its theme language', () => {
    // From the authoritative design -> theme -> language map.
    expect(languageForDesign('bachelorette')).toBe('english');
    expect(languageForDesign('marriage')).toBe('hebrew'); // anniversary
    expect(languageForDesign('birthday')).toBe('english'); // birthday-girls
    expect(languageForDesign('japanese')).toBe('english');
    expect(languageForDesign('posttrip')).toBe('english'); // trip comeback
    expect(languageForDesign('kids')).toBe('hebrew'); // birthday-boys-basketball
  });

  it('every DESIGNS entry resolves to a supported language', () => {
    for (const d of DESIGNS) {
      expect(['english', 'hebrew']).toContain(languageForDesign(d.id));
    }
  });

  it('defaults an unknown/unmapped design to hebrew (Hebrew-first product)', () => {
    expect(languageForDesign('does-not-exist')).toBe('hebrew');
  });

  it('honors an injected language map override (testability)', () => {
    // bachelorette maps to the 'bachelorette' theme; overriding it to hebrew in
    // the injected map flips the resolved language.
    expect(languageForDesign('bachelorette', { bachelorette: 'hebrew' })).toBe('hebrew');
    // a design whose theme is absent from the override map falls back to hebrew.
    expect(languageForDesign('japanese', { bachelorette: 'hebrew' })).toBe('hebrew');
  });
});

// A CUSTOM design (an owner-uploaded template) is not in THEME_BY_DESIGN, so the
// static maps resolve it to [] extra fields and 'hebrew'. The wizard therefore
// never asked for AGE / YEARS / NAME1+NAME2 — it took the order anyway and the
// title rendered with UNFILLED PLACEHOLDERS on a paying customer's deck. A
// design that carries its own metadata is now believed over the map.
describe('custom designs carry their own metadata', () => {
  it('uses a custom design own extra_fields instead of the empty map lookup', () => {
    const custom = { id: 'my-template', custom: true, extra_fields: ['AGE'] };
    expect(extraFieldsForDesign(custom)).toEqual(['AGE']);
    // ...and by id alone it is still unknown, which is the bug being fixed.
    expect(extraFieldsForDesign('my-template')).toEqual([]);
  });

  it('uses a custom design own language instead of the hebrew fallback', () => {
    const custom = { id: 'my-template', custom: true, language: 'english' };
    expect(languageForDesign(custom)).toBe('english');
    expect(languageForDesign('my-template')).toBe('hebrew');
  });

  it('falls back to the static maps when a custom design declares nothing', () => {
    const bare = { id: 'my-template', custom: true };
    expect(extraFieldsForDesign(bare)).toEqual([]);
    expect(languageForDesign(bare)).toBe('hebrew');
  });

  it('a BUILT-IN design object resolves through the maps exactly as its id does', () => {
    expect(languageForDesign({ id: 'bachelorette' })).toBe(languageForDesign('bachelorette'));
    expect(extraFieldsForDesign({ id: 'marriage' })).toEqual(extraFieldsForDesign('marriage'));
    // Guard the object path with a design that really does need a field —
    // 'marriage' no longer does (סנטוריני became a one-person deck), so asserting
    // on it would have quietly stopped testing anything.
    expect(extraFieldsForDesign({ id: 'japanese' })).toEqual(extraFieldsForDesign('japanese'));
    expect(extraFieldsForDesign({ id: 'japanese' }).length).toBeGreaterThan(0);
  });
});
