// @vitest-environment node
//
// A PARTIAL SAVE MUST NOT READ AS A SAVE.
//
// The settings API applies every field that validates and names the rest in
// `rejected`, so that one box dragged off the card can no longer discard the
// thirteen other fields the bench sends with it. That fix creates a NEW way to be
// silent: the response is a 200, and `r.ok ? 'נשמר ✓'` would announce success
// over a save that half happened.
//
// This pins the button's own text, because that string is the entire report the
// owner gets. She is standing at the bench; if it says ✓ she walks away.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'admin-bench.html'), 'utf8');

// The exact expression saveToSite assigns to the button, lifted out and run
// against each response shape. Extracted rather than retyped: a copy here would
// pass while the page said something else.
const buttonText = (() => {
  const src = html.match(/const refused = Array\.isArray\(body\.rejected\)[\s\S]*?: 'נשמר ✓';/);
  if (!src) throw new Error('site/admin-bench.html no longer sets the save button from `rejected`');
  return (r, body) =>
    eval(
      `((r, body) => { let btn = {}; ${src[0].replace('btn.textContent =', 'btn.textContent =')} return btn.textContent; })`
    )(r, body);
})();

describe('the save button says what actually happened', () => {
  it('a clean save is a clean ✓', () => {
    expect(buttonText({ ok: true, status: 200 }, { ok: true, rejected: [] })).toBe('נשמר ✓');
  });

  it('a refusal names the field, as it always did', () => {
    const t = buttonText({ ok: false, status: 400 }, { error: 'word_pitch (must be positive)' });
    expect(t).toContain('לא נשמר');
    expect(t).toContain('word_pitch');
  });

  // THE NEW CASE. 200, some of it landed, some did not.
  it('a PARTIAL save never says ✓, and names what was refused', () => {
    const t = buttonText(
      { ok: true, status: 200 },
      { ok: true, rejected: ['card_slots (card_slots.words[2].y1 must be a fraction 0..1)'] }
    );
    expect(t).not.toBe('נשמר ✓');
    expect(t).toContain('card_slots');
    // …and it says the previous value stands, which is what actually happened —
    // the same words admin-templates.html uses for a rejected calibration.
    expect(t).toContain('נשמר הערך הקודם');
  });

  // TWO REFUSALS THAT MEAN DIFFERENT THINGS, and the button must not say the same
  // words for both.
  //
  // A refused BOX leaves the rest of the save standing — genuinely partial. A
  // refused ceiling, word_alt_scale or word_wrap_pitch still discards the whole
  // patch (that contract is pinned by three suites of its own), so NOTHING was
  // saved. Telling her "partially saved, the previous value stands" after a save
  // that stored nothing would be a new wrong message replacing the old silent
  // one — which is not an improvement.
  it('says NOTHING SAVED for an atomic refusal, never "partially"', () => {
    // The API returns 400 for these, so the response carries no `rejected`.
    const t = buttonText(
      { ok: false, status: 400 },
      { error: 'word_wrap_pitch must be a number above 0 and at most 1, or null' }
    );
    expect(t).toContain('לא נשמר');
    expect(t).not.toContain('נשמר חלקית');
    expect(t).toContain('word_wrap_pitch');
  });

  it('says PARTIALLY SAVED only when the rest of the patch really landed', () => {
    const t = buttonText(
      { ok: true, status: 200 },
      { ok: true, rejected: ['card_slots (card_slots.words[2].y1 must be a fraction 0..1)'] }
    );
    expect(t).toContain('נשמר חלקית');
    expect(t).not.toContain('לא נשמר');
  });

  it('names every refused field, not just the first', () => {
    const t = buttonText(
      { ok: true, status: 200 },
      { ok: true, rejected: ['card_slots (bad box)', 'back (back.fill must be a hex color)'] }
    );
    expect(t).toContain('card_slots');
    expect(t).toContain('back');
  });
});
