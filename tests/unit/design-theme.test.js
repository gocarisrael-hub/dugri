// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  DESIGNS,
  THEME_BY_DESIGN,
  THEME_EXTRA_FIELDS,
  themeForDesign,
  extraFieldsForDesign,
} from '../../site/js/designs.js';

// server/db.js is CommonJS and writes a JSON file under DATA_DIR. Point it at a
// throwaway temp dir (set before require) so the test never touches real data.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDbPath = path.join(__dirname, '..', '..', 'server', 'db.js');
const themesPath = path.join(__dirname, '..', '..', 'generator', 'themes.json');

let db;
let themes;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-theme-'));
  db = require(serverDbPath);
  themes = require(themesPath);
});

describe('design -> theme resolution', () => {
  it('maps every orderable design to a theme that exists in themes.json', () => {
    for (const d of DESIGNS) {
      const theme = themeForDesign(d.id);
      expect(theme, `design ${d.id} has a theme`).toBeTruthy();
      expect(themes[theme], `theme ${theme} exists in themes.json`).toBeTruthy();
      // the resolved theme is also attached to the design entry
      expect(d.theme).toBe(theme);
    }
  });

  it('THEME_EXTRA_FIELDS mirrors themes.json extra_fields for every mapped theme', () => {
    for (const theme of Object.values(THEME_BY_DESIGN)) {
      expect(THEME_EXTRA_FIELDS[theme], `extra_fields for ${theme}`).toEqual(
        themes[theme].extra_fields
      );
    }
  });

  it('resolves the specific extra-field themes', () => {
    expect(themeForDesign('japanese')).toBe('japanese');
    expect(extraFieldsForDesign('japanese')).toEqual(['AGE']);
    expect(themeForDesign('kids')).toBe('birthday-boys-basketball');
    expect(extraFieldsForDesign('kids')).toEqual(['AGE']);
    expect(themeForDesign('marriage')).toBe('anniversary');
    expect(extraFieldsForDesign('marriage')).toEqual(['YEARS', 'NAME1', 'NAME2']);
    expect(themeForDesign('posttrip')).toBe('trip comeback');
    expect(extraFieldsForDesign('bachelorette')).toEqual([]);
  });

  it('returns null / [] for an unknown design', () => {
    expect(themeForDesign('nope')).toBe(null);
    expect(extraFieldsForDesign('nope')).toEqual([]);
  });
});

describe('createCollection persists theme + extra_fields', () => {
  it('stores a resolved theme (capped at 80 chars)', () => {
    const c = db.createCollection('שירה', { theme: 'japanese' });
    expect(c.theme).toBe('japanese');
    const long = db.createCollection('x', { theme: 'a'.repeat(200) });
    expect(long.theme.length).toBe(80);
  });

  it('defaults theme to null when absent', () => {
    expect(db.createCollection('בלי תבנית').theme).toBe(null);
  });

  it('stores extra_fields as a sanitized object', () => {
    const c = db.createCollection('דנה', {
      theme: 'anniversary',
      extra_fields: { YEARS: '25', NAME1: 'דנה', NAME2: 'יוסי' },
    });
    expect(c.extra_fields).toEqual({ YEARS: '25', NAME1: 'דנה', NAME2: 'יוסי' });
  });

  it('normalizes non-object / missing extra_fields to {}', () => {
    expect(db.createCollection('a').extra_fields).toEqual({});
    expect(db.createCollection('b', { extra_fields: null }).extra_fields).toEqual({});
    expect(db.createCollection('c', { extra_fields: ['AGE'] }).extra_fields).toEqual({});
    expect(db.createCollection('d', { extra_fields: 'AGE' }).extra_fields).toEqual({});
  });

  it('trims and caps extra_field values, dropping null values', () => {
    const c = db.createCollection('e', {
      extra_fields: { AGE: '  30  ', LONG: 'y'.repeat(200), NIL: null },
    });
    expect(c.extra_fields.AGE).toBe('30');
    expect(c.extra_fields.LONG.length).toBe(80);
    expect('NIL' in c.extra_fields).toBe(false);
  });
});
