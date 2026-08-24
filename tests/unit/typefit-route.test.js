// @vitest-environment node
//
// THE ROUTE THAT ASKS THE GENERATOR what the press will set.
//
// The calibration screen fits in JavaScript so it can answer mid-drag, and a
// second implementation of a fit drifts. This one did, three separate ways —
// each invisible until the two answers sat side by side. This route is what puts
// them side by side, so the tests here are about the CONTRACT that makes the
// comparison trustworthy: unsaved knobs reach the generator (or the screen is
// comparing against a template it is not showing), a bad answer is reported
// rather than passed off as a number, and nothing here can write.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const script = path.join(repoRoot, 'generator', 'typefit.py');
const PY = process.env.PYTHON || 'python3';

function ask(payload) {
  const out = execFileSync(PY, [script], {
    input: JSON.stringify(payload),
    cwd: path.join(repoRoot, 'generator'),
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

const WORDS = ['מסיבה', 'ריקודים', 'צחוקים', 'חברים'];

describe('typefit — the generator answering for itself', () => {
  it('the script the route spawns exists where the route looks for it', () => {
    // The route builds this path; a rename that misses it would 502 every ask
    // and the screen would quietly stop comparing.
    expect(fs.existsSync(script)).toBe(true);
    const index = fs.readFileSync(path.join(repoRoot, 'server', 'index.js'), 'utf8');
    expect(index).toMatch(/'generator',\s*'typefit\.py'/);
  });

  it('answers a size in the same units card_slots is written in', () => {
    const got = ask({ theme: 'grapefruit', words: WORDS });
    expect(got.word_size).toBeGreaterThan(0);
    expect(got.word_size).toBeLessThan(200);
    expect(got.word_box).toBeGreaterThan(0);
  });

  it('unsaved knobs change the answer', () => {
    // The whole point: she is asking about numbers she has NOT committed to.
    const free = ask({ theme: 'grapefruit', words: WORDS });
    const held = ask({
      theme: 'grapefruit',
      words: WORDS,
      overrides: { word_max_he: 9, word_size: null },
    });
    expect(held.word_size).toBeLessThan(free.word_size);
    expect(held.word_size).toBeCloseTo(9, 1);
  });

  it('reports an unknown template rather than answering a number', () => {
    expect(ask({ theme: 'no-such-template', words: WORDS }).error).toBeTruthy();
  });

  it('the route spawns through spawnGenerator, never bare spawn', () => {
    // Every generator child is its own process group so a wedged one can be
    // taken down whole; a raw spawn here would leak Chrome on a timeout.
    const index = fs.readFileSync(path.join(repoRoot, 'server', 'index.js'), 'utf8');
    const route = index.slice(index.indexOf('templates/:key/typefit'));
    const body = route.slice(0, route.indexOf('\n});'));
    expect(body).toMatch(/spawnGenerator\(/);
    expect(body).not.toMatch(/[^n]spawn\(PYTHON_BIN/);
    expect(body).toMatch(/killGenerator|setTimeout/);
  });
});
