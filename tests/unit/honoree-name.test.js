import { describe, it, expect } from 'vitest';
import { isValidHonoreeName, isValidIntegerField } from '../../site/js/configurator.js';

// The honoree name drives the printed cards: it must be a real SINGLE-word name
// (letters + hyphen/apostrophe only, no spaces/digits/symbols) and — when a
// language is given — written in that script (english = Latin, hebrew = Hebrew).
describe('isValidHonoreeName — single-word format (no language)', () => {
  it('accepts a plain single Hebrew or English word', () => {
    expect(isValidHonoreeName('שירה')).toBe(true);
    expect(isValidHonoreeName('Hadar')).toBe(true);
  });

  it('accepts a single hyphenated / apostrophised name', () => {
    expect(isValidHonoreeName('Anne-Marie')).toBe(true);
    expect(isValidHonoreeName("O'Neil")).toBe(true);
    expect(isValidHonoreeName('בן-ציון')).toBe(true);
  });

  it('rejects any internal whitespace — the name is ONE word', () => {
    expect(isValidHonoreeName('Anne Marie')).toBe(false);
    expect(isValidHonoreeName('שירה כהן')).toBe(false);
    expect(isValidHonoreeName('a b')).toBe(false);
    // a tab counts as whitespace too
    expect(isValidHonoreeName('a\tb')).toBe(false);
  });

  it('trims surrounding whitespace before validating (leading/trailing ok)', () => {
    expect(isValidHonoreeName('  Shira  ')).toBe(true);
  });

  it('rejects digits and other symbols anywhere', () => {
    expect(isValidHonoreeName('Hadar123')).toBe(false);
    expect(isValidHonoreeName('הדר123')).toBe(false);
    expect(isValidHonoreeName('Hadar@')).toBe(false);
    expect(isValidHonoreeName('name!')).toBe(false);
  });

  it('rejects empty / whitespace-only / punctuation-only values', () => {
    expect(isValidHonoreeName('')).toBe(false);
    expect(isValidHonoreeName('   ')).toBe(false);
    expect(isValidHonoreeName("-'")).toBe(false);
    expect(isValidHonoreeName(null)).toBe(false);
    expect(isValidHonoreeName(undefined)).toBe(false);
  });
});

describe('isValidHonoreeName — language (script) enforcement', () => {
  it('english design requires Latin letters and rejects a Hebrew name', () => {
    expect(isValidHonoreeName('Hadar', 'english')).toBe(true);
    expect(isValidHonoreeName('Anne-Marie', 'english')).toBe(true);
    expect(isValidHonoreeName('שירה', 'english')).toBe(false);
    expect(isValidHonoreeName('הדר', 'english')).toBe(false);
  });

  it('hebrew design requires Hebrew letters and rejects a Latin name', () => {
    expect(isValidHonoreeName('שירה', 'hebrew')).toBe(true);
    expect(isValidHonoreeName('בן-ציון', 'hebrew')).toBe(true);
    expect(isValidHonoreeName('Hadar', 'hebrew')).toBe(false);
    expect(isValidHonoreeName('Anne-Marie', 'hebrew')).toBe(false);
  });

  it('still enforces the single-word format under a language', () => {
    expect(isValidHonoreeName('Anne Marie', 'english')).toBe(false);
    expect(isValidHonoreeName('שירה כהן', 'hebrew')).toBe(false);
    expect(isValidHonoreeName('Hadar1', 'english')).toBe(false);
  });

  it('an unknown/omitted language does not constrain the script (backward-compatible)', () => {
    expect(isValidHonoreeName('שירה', undefined)).toBe(true);
    expect(isValidHonoreeName('Hadar', undefined)).toBe(true);
    expect(isValidHonoreeName('שירה', 'klingon')).toBe(true);
    expect(isValidHonoreeName('Hadar', 'klingon')).toBe(true);
  });
});

// AGE / YEARS extra fields must be digits-only integers within the input's
// min/max — stricter than parseInt (no "12abc", "3.5", "1e3", spaces).
describe('isValidIntegerField — numeric extra fields', () => {
  it('accepts a plain integer inside the bounds', () => {
    expect(isValidIntegerField('30', 0, 120)).toBe(true);
    expect(isValidIntegerField('0', 0, 120)).toBe(true);
    expect(isValidIntegerField('120', 0, 120)).toBe(true);
  });

  it('rejects out-of-range integers', () => {
    expect(isValidIntegerField('121', 0, 120)).toBe(false);
    expect(isValidIntegerField('-1', 0, 120)).toBe(false);
  });

  it('rejects anything that is not digits only', () => {
    expect(isValidIntegerField('12abc', 0, 120)).toBe(false);
    expect(isValidIntegerField('3.5', 0, 120)).toBe(false);
    expect(isValidIntegerField('1e3', 0, 120)).toBe(false);
    expect(isValidIntegerField('12 ', 0, 120)).toBe(true); // trimmed
    expect(isValidIntegerField('1 2', 0, 120)).toBe(false); // inner space
    expect(isValidIntegerField('', 0, 120)).toBe(false);
    expect(isValidIntegerField('  ', 0, 120)).toBe(false);
    expect(isValidIntegerField('abc', 0, 120)).toBe(false);
    expect(isValidIntegerField(null, 0, 120)).toBe(false);
  });

  it('accepts numeric-string bounds (as an <input> min/max attribute gives them)', () => {
    expect(isValidIntegerField('30', '0', '120')).toBe(true);
    expect(isValidIntegerField('200', '0', '120')).toBe(false);
  });

  it('treats missing bounds as unbounded on that side', () => {
    expect(isValidIntegerField('9999', '', '')).toBe(true);
    expect(isValidIntegerField('5', undefined, undefined)).toBe(true);
    expect(isValidIntegerField('-5', undefined, undefined)).toBe(true);
  });
});
