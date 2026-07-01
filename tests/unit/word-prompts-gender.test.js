import { describe, it, expect } from 'vitest';
import { renderQuestion, CATEGORIES, PROMPTS } from '../../site/js/word-prompts.js';

describe('renderQuestion', () => {
  it('interpolates {name}', () => {
    expect(renderQuestion('איפה {name} {גדלה|גדל}?', 'שירה', 'female')).toBe('איפה שירה גדלה?');
  });

  it('resolves {female|male} to the female form for gender=female', () => {
    expect(renderQuestion('{name} {גדלה|גדל}', 'שירה', 'female')).toBe('שירה גדלה');
  });

  it('resolves {female|male} to the male form for gender=male', () => {
    expect(renderQuestion('{name} {גדלה|גדל}', 'דני', 'male')).toBe('דני גדל');
  });

  it('DEFAULTS to feminine phrasing when gender is null/undefined', () => {
    expect(renderQuestion('{name} {גדלה|גדל}', 'שירה')).toBe('שירה גדלה');
    expect(renderQuestion('{name} {גדלה|גדל}', 'שירה', null)).toBe('שירה גדלה');
    expect(renderQuestion('{name} {גדלה|גדל}', 'שירה', 'anything-else')).toBe('שירה גדלה');
  });

  it('uses the feminine name fallback when name is empty (default gender)', () => {
    expect(renderQuestion('הרגל של {name}', '')).toBe('הרגל של בעלת השמחה');
    expect(renderQuestion('הרגל של {name}', null)).toBe('הרגל של בעלת השמחה');
  });

  it('uses the masculine name fallback when name is empty and gender=male', () => {
    expect(renderQuestion('הרגל של {name}', '', 'male')).toBe('הרגל של בעל השמחה');
  });

  it('handles multiple {name} and multiple alternations in one string', () => {
    const t = 'הכינוי ש{name} {נותנת|נותן} לאנשים ש{name} {אוהבת|אוהב}';
    expect(renderQuestion(t, 'שירה', 'female')).toBe('הכינוי ששירה נותנת לאנשים ששירה אוהבת');
    expect(renderQuestion(t, 'דני', 'male')).toBe('הכינוי שדני נותן לאנשים שדני אוהב');
  });

  it('is a no-op for plain text with no tokens', () => {
    expect(renderQuestion('סתם טקסט', 'שירה', 'male')).toBe('סתם טקסט');
  });

  it('renders every CATEGORIES/PROMPTS question without leaving raw tokens', () => {
    for (const g of ['female', 'male']) {
      for (const p of PROMPTS) {
        const out = renderQuestion(p.text, 'שירה', g);
        expect(out).not.toContain('{name}');
        expect(out).not.toMatch(/\{[^{}]*\|[^{}]*\}/); // no unresolved alternation
      }
    }
    // sanity: the flat PROMPTS bank matches the nested CATEGORIES source
    const nested = CATEGORIES.flatMap((c) => c.questions).length;
    expect(PROMPTS.length).toBe(nested);
  });
});
