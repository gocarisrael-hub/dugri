import { describe, it, expect } from 'vitest';
import { normalizeIlPhone, isValidIlMobile } from '../../site/js/configurator.js';

describe('normalizeIlPhone', () => {
  it('leaves a clean local mobile untouched', () => {
    expect(normalizeIlPhone('0546577715')).toBe('0546577715');
  });

  it('strips spaces, dashes and parentheses', () => {
    expect(normalizeIlPhone('052-123-4567')).toBe('0521234567');
    expect(normalizeIlPhone('054 657 7715')).toBe('0546577715');
    expect(normalizeIlPhone('(054) 657-7715')).toBe('0546577715');
  });

  it('converts the +972 / 972 country prefix to a local 0', () => {
    expect(normalizeIlPhone('+972546577715')).toBe('0546577715');
    expect(normalizeIlPhone('972546577715')).toBe('0546577715');
    expect(normalizeIlPhone('+972 54-657-7715')).toBe('0546577715');
    expect(normalizeIlPhone('+972-52-123-4567')).toBe('0521234567');
  });

  it('does not double the 0 for a "+972 0..." autofill variant', () => {
    expect(normalizeIlPhone('+9720546577715')).toBe('0546577715');
    expect(normalizeIlPhone('972 054 657 7715')).toBe('0546577715');
  });

  it('adds the missing leading 0 for a bare mobile (iPhone autofill)', () => {
    expect(normalizeIlPhone('546577715')).toBe('0546577715');
    expect(normalizeIlPhone('521234567')).toBe('0521234567');
  });

  it('is null/undefined safe', () => {
    expect(normalizeIlPhone(null)).toBe('');
    expect(normalizeIlPhone(undefined)).toBe('');
    expect(normalizeIlPhone('')).toBe('');
  });
});

describe('isValidIlMobile', () => {
  it('accepts every iPhone-autofill shape of the same number', () => {
    for (const v of [
      '+972 54-657-7715',
      '+972546577715',
      '972546577715',
      '0546577715',
      '546577715',
      '054-657-7715',
      '054 657 7715',
    ]) {
      expect(isValidIlMobile(v), v).toBe(true);
    }
  });

  it('accepts other valid IL mobile prefixes (052, 053, 058)', () => {
    expect(isValidIlMobile('0521234567')).toBe(true);
    expect(isValidIlMobile('0531234567')).toBe(true);
    expect(isValidIlMobile('0581234567')).toBe(true);
  });

  it('rejects too-short / too-long / non-mobile numbers', () => {
    expect(isValidIlMobile('12345')).toBe(false);
    expect(isValidIlMobile('054657771')).toBe(false); // 9 digits
    expect(isValidIlMobile('05465777155')).toBe(false); // 11 digits
    expect(isValidIlMobile('0212345678')).toBe(false); // landline (02), not mobile
    expect(isValidIlMobile('0446577715')).toBe(false); // 04X is not a mobile
    expect(isValidIlMobile('')).toBe(false);
    expect(isValidIlMobile('not a phone')).toBe(false);
  });
});
