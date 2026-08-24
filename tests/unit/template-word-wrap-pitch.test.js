// @vitest-environment node
//
// word_wrap_pitch ON THE SETTINGS API — how far apart the two lines of one
// wrapped entry sit, as a fraction of the step between entries.
//
// generator/config.word_wrap_pitch reads this name. The bound that matters is
// the TOP one: past the entry step a continuation sits further from its own
// first line than from the next entry, and the numbered list stops reading as
// four items. The bottom is enforced in the generator by the ink floor, not
// here, so this only has to refuse what is meaningless.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wrappitch-'));
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify(
      {
        seed: {
          slug: 'seed',
          calibrated: true,
          title_style: { fill: '#000', outline: '#000', outline_w: 0, arch: 0, shadow: false },
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

describe('word_wrap_pitch on the settings API', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  const save = (root, patch) => templates.updateTemplateSettings({ root, key: 'seed', patch });
  const read = (root) =>
    JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8')).seed;

  it('stores the fraction the design asks for', () => {
    const root = scaffold({});
    expect(save(root, { word_wrap_pitch: 0.85 }).error).toBeUndefined();
    expect(read(root).word_wrap_pitch).toBe(0.85);
  });

  it('leaves a template that never mentions it exactly as it was', () => {
    const root = scaffold({ word_pitch: 27.58 });
    const before = JSON.stringify(read(root));
    expect(save(root, { word_pitch: 27.58 }).error).toBeUndefined();
    expect(read(root).word_wrap_pitch).toBeUndefined();
    expect(JSON.stringify(read(root))).toBe(before);
  });

  it('null drops the key, so a cleared design reads like a shipped one', () => {
    const root = scaffold({ word_wrap_pitch: 0.9 });
    expect(save(root, { word_wrap_pitch: null }).error).toBeUndefined();
    expect('word_wrap_pitch' in read(root)).toBe(false);
  });

  it('accepts the top of the range and refuses just past it', () => {
    const root = scaffold({});
    expect(save(root, { word_wrap_pitch: 1 }).error).toBeUndefined();
    expect(read(root).word_wrap_pitch).toBe(1);
    expect(save(root, { word_wrap_pitch: 1.01 }).error).toMatch(/word_wrap_pitch/);
  });

  it('refuses nonsense rather than storing it', () => {
    for (const bad of ['tight', 0, -0.5, 2, NaN, Infinity, {}]) {
      const root = scaffold({});
      const res = save(root, { word_wrap_pitch: bad });
      expect(res.error, `expected ${JSON.stringify(bad)} to be refused`).toMatch(/word_wrap_pitch/);
      expect(res.httpStatus).toBe(400);
      expect(read(root).word_wrap_pitch).toBeUndefined();
    }
  });

  it('a refusal changes nothing beside it', () => {
    const root = scaffold({});
    const res = save(root, { word_pitch: 30, word_wrap_pitch: 2 });
    expect(res.error).toMatch(/word_wrap_pitch/);
    expect(read(root).word_pitch).toBeUndefined();
  });

  it('sits alongside the geometry without disturbing it', () => {
    const root = scaffold({ word_pitch: 27.58 });
    expect(save(root, { word_wrap_pitch: 0.8, word_pitch: 29.17 }).error).toBeUndefined();
    const after = read(root);
    expect(after.word_wrap_pitch).toBe(0.8);
    expect(after.word_pitch).toBe(29.17);
  });
});
