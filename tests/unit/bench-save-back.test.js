// @vitest-environment node
//
// A TEMPLATE WITH NO BACK TITLE COULD NOT BE SAVED FROM THE BENCH. The back box
// was always sent, its colours spread from the template's own back title — and a
// design whose back is pure artwork (ריאל מדריד: the crest) has none. So the box
// went out as a bare `frac`, the settings API refused it with "back.fill must be
// a hex color", and the refusal lost every other knob in the same save.
//
// These drive the real function out of the page rather than grepping it.
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', '..', 'site', 'admin-bench.html');
let html;
beforeAll(() => {
  html = fs.readFileSync(FILE, 'utf8');
});

const backForSave = () => {
  const src = html.match(/ {2}function backForSave\(liveBack, box\) \{[\s\S]*?\n {2}\}/)[0];
  // eslint-disable-next-line no-unused-vars
  const r4 = (n) => Math.round(n * 10000) / 10000;
  return eval('(' + src.trim() + ')');
};

// What saveToSite does with writeJSON's output: copy only the saveable keys it has.
const patchFrom = (out) => {
  const list = html.match(/const SAVEABLE = \[([\s\S]*?)\];/)[1];
  const saveable = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const patch = {};
  for (const f of saveable) if (f in out) patch[f] = out[f];
  return patch;
};

const BOX = { x0: 0.20581, y0: 0.366, x1: 0.79419, y1: 0.612 };

describe('the back box is saved only when the template has a back title', () => {
  it('a back-less template sends no back at all — the saved null stands', () => {
    const out = { word_pitch: 31.86, ...backForSave()(null, BOX) };
    expect(out).not.toHaveProperty('back');
    const patch = patchFrom(out);
    expect(patch).not.toHaveProperty('back');
    // …and the rest of the save still goes out.
    expect(patch.word_pitch).toBe(31.86);
  });

  it('a back slot with no colours is not sent either', () => {
    // The exact shape the API refused: a frac and nothing to paint it with.
    expect(backForSave()({ frac: BOX }, BOX)).toEqual({});
    expect(backForSave()({ fill: '#f8d078' }, BOX)).toEqual({});
  });

  it('a template that has one keeps its colours and takes the moved box', () => {
    const live = {
      frac: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.3 },
      fill: '#f8d078',
      outline: '#000000',
      size: 28.31,
    };
    expect(backForSave()(live, BOX)).toEqual({
      back: {
        fill: '#f8d078',
        outline: '#000000',
        size: 28.31,
        frac: { x0: 0.2058, y0: 0.366, x1: 0.7942, y1: 0.612 },
      },
    });
  });

  it('writeJSON builds the back through it, not inline', () => {
    const write = html.match(/ {2}function writeJSON\(\) \{[\s\S]*?LAST_OUT = out;/)[0];
    expect(write).toContain('...backForSave(LIVE.back, S.back),');
    expect(write).not.toMatch(/back: \{\s*\.\.\.LIVE\.back/);
  });
});
