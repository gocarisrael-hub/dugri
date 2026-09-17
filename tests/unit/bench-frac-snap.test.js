// @vitest-environment node
//
// THE EDGE OF THE CARD, AND HOW FAR PAST IT COUNTS AS A MISTAKE.
//
// Saved geometry is fractions of the card, and the API refuses anything outside
// 0..1 — rightly: a box off the card is geometry that cannot print. But the bench
// drags in floats and rounds to four places, so an edge dropped exactly ON the
// border can arrive as 1.00003 and be refused for a difference nobody can see or
// intend. That much is a rounding artefact, and snapping it is a repair.
//
// ANYTHING FURTHER OUT IS NOT. The move handle allows -0.2..1.2 and the resize
// handles have no outer bound at all, so a box really can be dragged well off the
// card. Pulling that back to the edge would store a rectangle she never drew and
// then show it to her as though she had — "we fixed it by ignoring it", which is
// the failure this whole change exists to remove. It stays out of range, and the
// API refuses it BY NAME while keeping the rest of the save.
//
// So the test worth writing is not "does it clamp" but "where does it stop".
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'admin-bench.html'), 'utf8');

// The page's own snapFrac, lifted out by name — a rename here is a failure rather
// than a test that quietly stops covering anything. Same idiom as
// tests/unit/bench-save-back.test.js.
const snapFrac = (() => {
  const r4src = html.match(/ {2}const r4 = \(n\) => [^\n]+/);
  const snapSrc = html.match(
    / {2}const FRAC_SNAP = [^\n]+\n {2}const snapFrac = \(n\) => \{[\s\S]*?\n {2}\};/
  );
  if (!r4src || !snapSrc) throw new Error('site/admin-bench.html no longer declares snapFrac');
  return eval(`(() => { ${r4src[0]} ${snapSrc[0]} return snapFrac; })()`);
})();

describe('a fraction on the card is saved as being on the card', () => {
  it('rounds to four places, exactly as every other saved number does', () => {
    expect(snapFrac(0.20581234)).toBe(0.2058);
    expect(snapFrac(0.5)).toBe(0.5);
    expect(snapFrac(0)).toBe(0);
    expect(snapFrac(1)).toBe(1);
  });

  it('snaps a rounding artefact at the border onto the border', () => {
    // What a drag to the very edge really produces. NOTE the values: r4 alone
    // already rounds 1.00003 onto 1.0, so asserting that one proves nothing about
    // the snap — it passed with the snap deleted. 1.00007 survives the rounding
    // (r4 -> 1.0001) and is snapped only by the branch this test is about.
    expect(snapFrac(1.00007)).toBe(1);
    expect(snapFrac(-0.00007)).toBe(0);
    // …and the snapped value is a legal fraction, which is the point: the API
    // takes it instead of refusing a box the owner placed correctly.
    expect(snapFrac(1.00003)).toBeLessThanOrEqual(1);
    expect(snapFrac(-0.00003)).toBeGreaterThanOrEqual(0);
  });

  it('does NOT pull a box back from off the card', () => {
    // The drag allows this on purpose; the API must see it and refuse it by name.
    expect(snapFrac(1.12)).toBe(1.12);
    expect(snapFrac(-0.2)).toBe(-0.2);
    expect(snapFrac(3)).toBe(3);
    // Stated as the rule rather than the examples: anything beyond one rounding
    // step is left exactly where the hand put it.
    expect(snapFrac(1.01)).toBeGreaterThan(1);
  });

  it('stops where the rounding stops — the snap is one step, not a tolerance', () => {
    const step = Number(html.match(/const FRAC_SNAP = ([\d.e-]+);/)[1]);
    expect(step).toBe(1e-4);
    // Just inside: repaired. Just outside: untouched. A snap wider than the
    // rounding it repairs would be silently moving real geometry.
    expect(snapFrac(1 + step)).toBe(1);
    expect(snapFrac(1 + step * 2)).toBeGreaterThan(1);
  });
});
