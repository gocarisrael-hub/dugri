import { describe, it, expect } from 'vitest';
import { selectionNamesFromIds, PLAN_LABELS } from '../../site/js/configurator.js';
import { DESIGNS, MAIN_COLORS } from '../../site/js/designs.js';

describe('selectionNamesFromIds (thankyou.html URL fallback)', () => {
  it('translates real design/color/plan ids to Hebrew names', () => {
    const out = selectionNamesFromIds(
      { design: 'birthday', color: 'violet', plan: 'base' },
      DESIGNS,
      MAIN_COLORS,
      PLAN_LABELS
    );
    expect(out.designName).toBe('יום הולדת');
    expect(out.colorName).toBe('סגול');
    expect(out.planLabel).toBe('בסיס');
    expect(out.plan).toBe('base');
  });

  it('maps the special color id "original" to מקורי', () => {
    const out = selectionNamesFromIds(
      { design: 'kids', color: 'original', plan: 'base' },
      DESIGNS,
      MAIN_COLORS,
      PLAN_LABELS
    );
    expect(out.designName).toBe('יום הולדת לילדים');
    expect(out.colorName).toBe('מקורי');
    expect(out.planLabel).toBe('בסיס');
  });

  it('never leaks the raw English ids for known values', () => {
    const out = selectionNamesFromIds(
      { design: 'birthday', color: 'violet', plan: 'base' },
      DESIGNS,
      MAIN_COLORS,
      PLAN_LABELS
    );
    expect(out.designName).not.toBe('birthday');
    expect(out.colorName).not.toBe('violet');
    expect(out.planLabel).not.toBe('base');
  });

  it('falls back to the raw value for unknown ids (no crash)', () => {
    const out = selectionNamesFromIds(
      { design: 'mystery', color: 'chartreuse', plan: 'gold' },
      DESIGNS,
      MAIN_COLORS,
      PLAN_LABELS
    );
    expect(out.designName).toBe('mystery');
    expect(out.colorName).toBe('chartreuse');
    expect(out.planLabel).toBe('gold');
  });

  it('handles empty/missing ids gracefully', () => {
    const out = selectionNamesFromIds({}, DESIGNS, MAIN_COLORS, PLAN_LABELS);
    expect(out.designName).toBe('');
    expect(out.colorName).toBe('');
    expect(out.planLabel).toBe('');
  });
});
