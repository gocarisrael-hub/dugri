// @vitest-environment node
//
// THE ROUTE THAT ASKS THE GENERATOR what the press will set.
//
// The calibration screen fits in JavaScript so it can answer mid-drag, and a
// second implementation of a fit drifts. This one did, three separate ways, each
// invisible until the two answers sat side by side. The route is what puts them
// side by side.
//
// WHAT IS TESTED HERE is only what can be true without Python: this job has no
// PIL — spawning typefit.py here failed CI once already. The ANSWERS are held to
// account in generator/test_typefit.py, which runs in the pytest job where the
// generator's own dependencies live. What is left for this job is the contract
// between the route and that script, which is exactly the part a rename or a
// refactor breaks silently.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const indexJs = fs.readFileSync(path.join(repoRoot, 'server', 'index.js'), 'utf8');
const script = path.join(repoRoot, 'generator', 'typefit.py');
const PY = process.env.PYTHON_BIN || process.env.PYTHON || 'python3';
// Same guard the other generator-touching unit tests use: this job has no PIL,
// and the answers are held to account in generator/test_typefit.py where it does.
// Where Pillow IS present — a developer's machine — these run and are worth having.
const HAS_PILLOW = spawnSync(PY, ['-c', 'import PIL']).status === 0;

const ask = (payload) =>
  JSON.parse(
    execFileSync(PY, [script], {
      input: JSON.stringify(payload),
      cwd: path.join(repoRoot, 'generator'),
      encoding: 'utf8',
    })
  );
const WORDS = ['מסיבה', 'ריקודים', 'צחוקים', 'חברים'];

function routeBody() {
  const at = indexJs.indexOf("'/api/admin/templates/:key/typefit'");
  expect(at, 'the typefit route is gone').toBeGreaterThan(-1);
  return indexJs.slice(at, indexJs.indexOf('\n});', at));
}

describe('the typefit route', () => {
  it('spawns a script that exists', () => {
    // The route builds this path; a rename that missed it would 502 every ask
    // and the screen would quietly stop comparing rather than say anything.
    expect(routeBody()).toMatch(/'generator',\s*'typefit\.py'/);
    expect(fs.existsSync(path.join(repoRoot, 'generator', 'typefit.py'))).toBe(true);
  });

  it('goes through spawnGenerator, never a bare spawn', () => {
    // Every generator child is its own process group so a wedged one can be
    // taken down whole. A raw spawn here would leak Chrome on a timeout.
    const body = routeBody();
    expect(body).toMatch(/spawnGenerator\(/);
    expect(body).not.toMatch(/\bspawn\(PYTHON_BIN/);
  });

  it('cannot hold a socket open behind a keystroke', () => {
    // It answers in well under a second; one that does not is wedged, and the
    // screen asks again on the next change anyway.
    const body = routeBody();
    expect(body).toMatch(/setTimeout\(/);
    expect(body).toMatch(/killGenerator\(/);
  });

  it('passes the unsaved knobs through, which is the whole point', () => {
    // She is asking about numbers she has NOT committed to. A route that sent
    // only the key would answer about the saved template — a different question,
    // and one whose answer would look like agreement.
    expect(routeBody()).toMatch(/overrides/);
  });

  it('is admin-gated and bounded', () => {
    const body = routeBody();
    expect(body).toMatch(/requireAdmin\(req, res\)/);
    // A word list is four entries on a card; anything past a handful is someone
    // else's problem arriving at the generator.
    expect(body).toMatch(/slice\(0,\s*8\)/);
  });

  it('reports a crash rather than passing it off as a number', () => {
    const body = routeBody();
    expect(body).toMatch(/502/);
    expect(body).toMatch(/JSON\.parse/);
  });

  it.runIf(HAS_PILLOW)('answers a size in the units card_slots is written in', () => {
    const got = ask({ theme: 'grapefruit', words: WORDS });
    expect(got.word_size).toBeGreaterThan(0);
    expect(got.word_box).toBeGreaterThan(0);
  });

  it.runIf(HAS_PILLOW)('unsaved knobs really do change the answer', () => {
    const free = ask({ theme: 'grapefruit', words: WORDS });
    const held = ask({
      theme: 'grapefruit',
      words: WORDS,
      overrides: { word_max_he: 9, word_size: null },
    });
    expect(held.word_size).toBeLessThan(free.word_size);
    expect(held.word_size).toBeCloseTo(9, 1);
  });

  it.runIf(HAS_PILLOW)('names the template it could not find, rather than crashing', () => {
    expect(ask({ theme: 'no-such-template', words: WORDS }).error).toBeTruthy();
  });
});
