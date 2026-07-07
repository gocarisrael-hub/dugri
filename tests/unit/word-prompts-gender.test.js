import { describe, it, expect } from 'vitest';
import {
  renderQuestion,
  fillName,
  CATEGORIES,
  PROMPTS,
  KIDS_CATEGORIES,
  KIDS_PROMPTS,
  COUPLE_CATEGORIES,
  COUPLE_PROMPTS,
  categoriesForTheme,
  promptsForTheme,
  premiumPromptsForTheme,
  isKidsTheme,
  isCoupleTheme,
} from '../../site/js/word-prompts.js';

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

  it('inserts a name with $-replacement patterns LITERALLY (no special $& / $$ handling)', () => {
    const tricky = 'A$&B';
    const out = renderQuestion('הרגל של {name}', tricky, 'female');
    expect(out).toBe('הרגל של A$&B');
    expect(out).not.toContain('{name}');
    // fillName shares the same interpolation and must be safe too.
    expect(fillName('הרגל של {name}', "C$`$'$$D")).toBe("הרגל של C$`$'$$D");
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

describe('per-event prompt sets', () => {
  const raw = (text) => renderQuestion(text, 'שם', 'female');

  it('routes generator themes to the right category set', () => {
    expect(categoriesForTheme('birthday-boys-basketball')).toBe(KIDS_CATEGORIES);
    expect(categoriesForTheme('anniversary')).toBe(COUPLE_CATEGORIES);
    expect(categoriesForTheme('bachelorette')).toBe(CATEGORIES);
    expect(categoriesForTheme(null)).toBe(CATEGORIES);
    expect(promptsForTheme('birthday-boys-basketball')).toBe(KIDS_PROMPTS);
    expect(promptsForTheme('anniversary')).toBe(COUPLE_PROMPTS);
    expect(promptsForTheme('japanese')).toBe(PROMPTS);
  });

  it('classifies kids and couple themes', () => {
    expect(isKidsTheme('birthday-boys-basketball')).toBe(true);
    expect(isKidsTheme('anniversary')).toBe(false);
    expect(isCoupleTheme('anniversary')).toBe(true);
    expect(isCoupleTheme('birthday-boys-basketball')).toBe(false);
  });

  it('kids prompts are kid-appropriate — no exes/drinking/army/curses/nightlife', () => {
    const kidText = KIDS_PROMPTS.map((p) => raw(p.text)).join(' | ');
    for (const bad of ['אקס', 'שתי', 'שיכור', 'צבא', 'קללה', 'בלילה', 'משקה']) {
      expect(kidText, bad).not.toContain(bad);
    }
    // The default adult set DOES include an ex prompt — proving kids diverges.
    expect(PROMPTS.map((p) => raw(p.text)).join(' ')).toContain('אקס');
  });

  it('kids/couple premium bank is empty (no adult prompts leak in when paid)', () => {
    expect(premiumPromptsForTheme('birthday-boys-basketball')).toEqual([]);
    expect(premiumPromptsForTheme('anniversary')).toEqual([]);
    expect(premiumPromptsForTheme('bachelorette').length).toBeGreaterThan(0);
  });

  it('renders every kids/couple prompt without leaving raw tokens', () => {
    for (const g of ['female', 'male']) {
      for (const p of KIDS_PROMPTS.concat(COUPLE_PROMPTS)) {
        const out = renderQuestion(p.text, 'שם', g);
        expect(out).not.toContain('{name}');
        expect(out).not.toMatch(/\{[^{}]*\|[^{}]*\}/);
      }
    }
  });

  it('couple prompts use no single-gender alternation (they are about the pair)', () => {
    for (const c of COUPLE_CATEGORIES) {
      for (const q of c.questions) {
        expect(q, q).not.toMatch(/\{[^{}]*\|[^{}]*\}/);
      }
    }
  });

  it('flat kids/couple banks match their nested category sources', () => {
    expect(KIDS_PROMPTS.length).toBe(KIDS_CATEGORIES.flatMap((c) => c.questions).length);
    expect(COUPLE_PROMPTS.length).toBe(COUPLE_CATEGORIES.flatMap((c) => c.questions).length);
  });
});
