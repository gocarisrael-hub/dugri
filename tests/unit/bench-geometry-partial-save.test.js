// @vitest-environment node
//
// ONE BAD BOX USED TO DISCARD THE WHOLE SAVE.
//
// The bench sends fourteen fields in a single patch (site/admin-bench.html
// SAVEABLE): word_pitch, word_size, title_style, back, card_slots, the six type
// ceilings. updateTemplateSettings validated them in sequence and RETURNED on the
// first refusal — so a box dragged off the card threw away every other field in
// the same request, including ones it had already validated. The owner was told
// about the box and nothing else; the integrator wrote card_slots + word_pitch to
// two production templates the day this was found and would have lost the pitch
// without noticing.
//
// The bench allows that drag on purpose: the move handle clamps to -0.2..1.2 and
// the resize handles have no outer bound, so "off the card" is a thing a hand can
// do. It has to be refused — and refused ALONE.
//
// What these hold:
//   * a patch carrying one bad box AND a good change lands the good change, and
//     the bad box is NAMED rather than silently dropped;
//   * the refused field keeps its PREVIOUS value — refused is not "cleared";
//   * a patch where nothing validates is still a failed save, and still says
//     which field, so the single-key caller (the wordlist picker sends exactly
//     { wordlist }) keeps the contract it has always had;
//   * a refusal never WRITES. The title_style branch carries a merge-forward step
//     that reads the validated value; skipping the refusal check there would
//     store `undefined` as a template's style — worse than the bug being fixed.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templates = require(path.join(__dirname, '..', '..', 'server', 'templates.js'));

// A throwaway root with one 'cards' template, uncalibrated — the calibrated:true
// guard is a different rule and not what any of this is about.
function scaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-benchgeo-'));
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify({ t: { slug: 't', calibrated: false, card_structure: 'cards' } }, null, 1) +
      '\n',
    'utf8'
  );
  return root;
}
const frac = (y0, y1) => ({ x0: 0.1, y0, x1: 0.9, y1 });
const goodSlots = () => ({
  words: [frac(0.1, 0.2), frac(0.3, 0.4), frac(0.5, 0.6), frac(0.7, 0.8)],
  titles: Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), frac(0.02, 0.09)])),
});

describe('a refused field does not take the save with it', () => {
  const setup = () => {
    const root = scaffold();
    const set = (patch) => templates.updateTemplateSettings({ root, key: 't', patch });
    const stored = () => templates.loadThemes(templates.themesPathFor(root))['t'];
    // The baseline is ASSERTED, not assumed: without it, "the pitch is not there
    // afterwards" could not be told apart from "the pitch was never saved".
    expect(set({ word_pitch: 26.84, card_slots: goodSlots() }).error).toBeUndefined();
    expect(stored().word_pitch).toBe(26.84);
    return { set, stored };
  };

  it('lands the good change and names the box it refused', () => {
    const { set, stored } = setup();
    const bad = goodSlots();
    bad.words[2] = frac(0.5, 1.12); // dragged off the card — what the bench allows

    const r = set({ word_pitch: 31.5, card_slots: bad });

    // The good change is IN THE STORE. Asserted on the stored value rather than
    // on the response: a check on the error shape would pass just as happily if
    // nothing had been written at all.
    expect(stored().word_pitch).toBe(31.5);
    // …and the refusal is reported, in the field admin-templates.html already reads.
    expect(r.rejected).toEqual([expect.stringContaining('card_slots')]);
    expect(r.rejected[0]).toContain('must be a fraction 0..1');
  });

  it('keeps the previous geometry — refused is not cleared', () => {
    const { set, stored } = setup();
    const bad = goodSlots();
    bad.words[2] = frac(0.5, 1.12);
    set({ word_pitch: 31.5, card_slots: bad });
    // The old box stands. Storing the off-card one, or null, would both be worse
    // than refusing: one prints wrong, the other loses a calibration.
    expect(stored().card_slots.words[2].y1).toBe(0.6);
  });

  it('applies a field the old code never even reached', () => {
    const { set, stored } = setup();
    const bad = goodSlots();
    bad.words[2] = frac(0.5, 1.12);
    // word_size is validated AFTER card_slots, so the abort meant its branch
    // never ran at all — a different mechanism from "validated then discarded",
    // and the same loss.
    set({ card_slots: bad, word_size: 21.5 });
    expect(stored().word_size).toBe(21.5);
  });

  it('is still a failed save when the geometry was all there was', () => {
    const { set, stored } = setup();
    const bad = goodSlots();
    bad.words[2] = frac(0.5, 1.12);
    // The box is the ONLY field, so nothing validated and nothing landed. That is
    // a failed save and must read as one — with the field named, so the caller is
    // not left with a bare "no valid settings to update" for a value this
    // function knows exactly why it refused.
    const r = set({ card_slots: bad });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('card_slots');
    expect(r.rejected).toEqual([expect.stringContaining('card_slots')]);
    expect(stored().card_slots.words[2].y1).toBe(0.6);
  });

  // The single-key caller: site/admin-wordlists.html posts exactly { wordlist }
  // and awaits it, so a refusal there must still arrive as an error.
  it('keeps the one-key caller’s contract', () => {
    const { set } = setup();
    const r = set({ wordlist: 'no-such-pool.txt' });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('wordlist');
  });

  // EVERY OTHER FIELD IS STILL ALL-OR-NOTHING, and this asserts it from my side
  // rather than only relying on the three suites that own that contract
  // (template-type-ceilings, template-word-alt-scale, template-word-wrap-pitch:
  // "a refusal changes nothing beside it").
  //
  // The narrowing is the whole point of this change: card_slots is refused ALONE
  // because its boxes are dragged and arrive wrong by hand; a malformed
  // title_style or ceiling is a different kind of fault and still discards the
  // patch. A test that let that slip would be removing a guarantee by accident.
  it('leaves every other field atomic — a bad style still discards the save', () => {
    const { set, stored } = setup();
    const r = set({ title_style: { fill: 'red', outline: '#000000' }, word_pitch: 30 });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('title_style');
    // Not partial: the good field beside it did NOT land.
    expect(stored().word_pitch).toBe(26.84);
    expect('title_style' in stored() ? stored().title_style : null).toBeNull();
  });
});
