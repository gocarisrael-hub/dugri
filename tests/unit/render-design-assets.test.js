// @vitest-environment node
import { describe, it, expect } from 'vitest';

// Unit tests for the pure helpers in scripts/render-design-assets.mjs. Importing
// the module does NOT render anything: main() runs only when the file is invoked
// directly as a CLI (guarded by an import.meta.url check), so a test import just
// pulls in the exported helpers.
import { healMaskIds, paintOriginal } from '../../scripts/render-design-assets.mjs';

describe('healMaskIds — repairs the id-overflow mask corruption', () => {
  it('renames a lone Infinity mask def back to the single dangling reference', () => {
    // The exact posttrip shape: a mask DEF id collapsed to "Infinity" (a hex id
    // like 2175e85314 read as scientific notation → Infinity) while its url(#…)
    // REFERENCE kept the original text and now dangles.
    const svg =
      '<svg>' +
      '<mask id="Infinity"><g><image href="x"/></g></mask>' +
      '<g mask="url(#2175e85314)"><rect/></g>' +
      '</svg>';
    const { svg: fixed, healed } = healMaskIds(svg);
    expect(healed).toEqual({ from: 'Infinity', to: '2175e85314' });
    expect(fixed).toContain('<mask id="2175e85314">');
    expect(fixed).not.toContain('<mask id="Infinity">');
    // the reference now resolves
    expect(fixed).toContain('mask="url(#2175e85314)"');
  });

  it('heals a collapsed mask def that carries TRAILING ATTRIBUTES after the id', () => {
    // The detection regex tolerates attributes after id; the heal must too — a
    // literal `<mask id="Infinity">` replace would silently no-op here and re-ship
    // the black board.
    const svg =
      '<svg>' +
      '<mask id="Infinity" maskUnits="userSpaceOnUse" x="0" y="0">' +
      '<g><image href="x"/></g></mask>' +
      '<g mask="url(#2175e85314)"><rect/></g>' +
      '</svg>';
    const { svg: fixed, healed } = healMaskIds(svg);
    expect(healed).toEqual({ from: 'Infinity', to: '2175e85314' });
    // The id is renamed AND the trailing attributes are preserved.
    expect(fixed).toContain('<mask id="2175e85314" maskUnits="userSpaceOnUse" x="0" y="0">');
    expect(fixed).not.toContain('id="Infinity"');
  });

  it('is a no-op when there is no corruption (all mask refs resolve)', () => {
    const svg = '<svg><mask id="abc123"><g/></mask><g mask="url(#abc123)"><rect/></g></svg>';
    const { svg: out, healed } = healMaskIds(svg);
    expect(healed).toBe(null);
    expect(out).toBe(svg);
  });

  it('refuses to guess when the case is ambiguous (multiple dangling refs / overflow defs)', () => {
    // Two dangling refs but only one overflow def — the mapping is ambiguous, so
    // leave it untouched rather than heal the wrong tile.
    const svg =
      '<svg>' +
      '<mask id="Infinity"><g/></mask>' +
      '<g mask="url(#111e222)"><rect/></g>' +
      '<g mask="url(#333e444)"><rect/></g>' +
      '</svg>';
    const { healed } = healMaskIds(svg);
    expect(healed).toBe(null);
  });

  it('does not touch a mask def whose overflow id is actually referenced', () => {
    // If url(#Infinity) genuinely resolves, there is nothing to repair.
    const svg = '<svg><mask id="Infinity"><g/></mask><g mask="url(#Infinity)"><rect/></g></svg>';
    const { healed } = healMaskIds(svg);
    expect(healed).toBe(null);
  });
});

describe('paintOriginal — injects the original-colour style for tokenized SVGs', () => {
  it('wraps the svg with a <style> resolving var(--cN) to the anchor hexes', () => {
    const out = paintOriginal('<svg width="10"><rect fill="var(--c0)"/></svg>', ['#ff0000']);
    expect(out).toMatch(/<svg id="render-svg-\d+" width="10"><style>/);
    expect(out).toContain('[fill="var(--c0)"]{fill:#ff0000}');
  });

  it('leaves a fixed design (no anchors) untouched', () => {
    const svg = '<svg><rect fill="#123456"/></svg>';
    expect(paintOriginal(svg, [])).toBe(svg);
    expect(paintOriginal(svg, null)).toBe(svg);
  });
});
