// @vitest-environment node
//
// word_alt_scale ON THE SETTINGS API — how big a design sets its ENGLISH words.
//
// generator/config.word_alt_scale has always read this name, and nothing could
// ever write it: the owner tuned the English share in the calibration bench,
// exported it, and the value fell on the floor. A design that wanted 1.26
// printed at the house 0.8 with nothing on the page to say why.
//
// The rule that matters most is that it stays OPTIONAL. Absent means the house
// fraction, which is the state every template ships in and every deck printed to
// date — so a save that does not mention it must come through byte-identical.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

function scaffold(entry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-altscale-'));
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify(
      {
        seed: {
          slug: 'seed',
          calibrated: true,
          title_style: {
            fill: '#000000',
            outline: '#000000',
            outline_w: 0,
            arch: 0,
            shadow: false,
          },
          ...entry,
        },
      },
      null,
      1
    ) + '\n',
    'utf8'
  );
  return root;
}

describe('word_alt_scale on the settings API', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  const save = (root, patch) => templates.updateTemplateSettings({ root, key: 'seed', patch });
  const read = (root) =>
    JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8')).seed;

  it('stores the fraction the owner tuned', () => {
    const root = scaffold({});
    expect(save(root, { word_alt_scale: 1.26 }).error).toBeUndefined();
    expect(read(root).word_alt_scale).toBe(1.26);
  });

  it('leaves a template that never mentions it exactly as it was', () => {
    // Every shipped design is in this state. Inventing a value here would change
    // the English on every deck printed so far.
    const root = scaffold({ word_pitch: 27.58 });
    const before = JSON.stringify(read(root));
    expect(save(root, { word_pitch: 27.58 }).error).toBeUndefined();
    expect(read(root).word_alt_scale).toBeUndefined();
    expect(JSON.stringify(read(root))).toBe(before);
  });

  it('null drops the key rather than storing a null', () => {
    // Absent is what the generator reads as "the house fraction", and it is how
    // the shipped entries are written — so clearing must reach the same state,
    // not a null that merely behaves like one.
    const root = scaffold({ word_alt_scale: 1.26 });
    expect(save(root, { word_alt_scale: null }).error).toBeUndefined();
    expect('word_alt_scale' in read(root)).toBe(false);
  });

  it('refuses nonsense rather than storing it', () => {
    for (const bad of ['wide', 0, -1, 4.5, NaN, Infinity, {}]) {
      const root = scaffold({});
      const res = save(root, { word_alt_scale: bad });
      expect(res.error, `expected ${JSON.stringify(bad)} to be refused`).toMatch(/word_alt_scale/);
      expect(res.httpStatus).toBe(400);
      expect(read(root).word_alt_scale).toBeUndefined();
    }
  });

  it('accepts the boundary and rejects just past it', () => {
    const root = scaffold({});
    expect(save(root, { word_alt_scale: 4 }).error).toBeUndefined();
    expect(read(root).word_alt_scale).toBe(4);
    expect(save(root, { word_alt_scale: 4.01 }).error).toMatch(/word_alt_scale/);
  });

  it('a refusal changes nothing beside it', () => {
    const root = scaffold({});
    const res = save(root, { word_pitch: 30, word_alt_scale: -1 });
    expect(res.error).toMatch(/word_alt_scale/);
    expect(read(root).word_pitch).toBeUndefined();
  });

  it('sits alongside the geometry and the ceilings without disturbing them', () => {
    const root = scaffold({ word_pitch: 27.58 });
    expect(
      save(root, { word_alt_scale: 1.16, word_pitch: 29.17, word_max_en: 26.98 }).error
    ).toBeUndefined();
    const after = read(root);
    expect(after.word_alt_scale).toBe(1.16);
    expect(after.word_pitch).toBe(29.17);
    expect(after.word_max_en).toBe(26.98);
  });
});
