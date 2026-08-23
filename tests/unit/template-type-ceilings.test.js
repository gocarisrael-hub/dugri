// @vitest-environment node
//
// THE SIX TYPE CEILINGS, on the settings API.
//
//   word_max_he / word_max_en              the largest a word may ever set
//   title_max_he / title_max_en            the same for the front title
//   back_title_max_he / back_title_max_en  and for the back's
//
// A ceiling is the largest the type may EVER set on a design, whatever room its
// box has. It exists because a card of very short words has nothing holding its
// width, so it runs up to whatever the box allows and prints a `נעה` twice the
// size of the `אנציקלופדיה` on the card beside it.
//
// The rule that matters above all others here is that they are OPTIONAL: a
// template that names none must come through a save byte-identical, because
// that is the state every template ships in and every deck printed so far.
// generator/config.type_ceiling reads the same six names and treats absent,
// null and junk alike as "no ceiling".
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const serverDir = path.join(repoRoot, 'server');

const CEILINGS = [
  'word_max_he',
  'word_max_en',
  'title_max_en',
  'title_max_he',
  'back_title_max_en',
  'back_title_max_he',
];

function scaffold(entry) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-ceilings-'));
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify(
      {
        seed: {
          slug: 'seed',
          calibrated: true,
          // a calibrated entry must carry a style; the ceilings sit beside it
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

describe('type ceilings on the settings API', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  const save = (root, patch) => templates.updateTemplateSettings({ root, key: 'seed', patch });
  const read = (root) =>
    JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8')).seed;

  it('stores every one of the six', () => {
    const root = scaffold({});
    const patch = Object.fromEntries(CEILINGS.map((f, i) => [f, 20 + i]));
    expect(save(root, patch).error).toBeUndefined();
    const after = read(root);
    CEILINGS.forEach((f, i) => expect(after[f]).toBe(20 + i));
  });

  it('leaves a template that names none exactly as it was', () => {
    // The state every design ships in: a save that does not mention a ceiling
    // must not invent one, or every deck printed to date changes size.
    const root = scaffold({ word_pitch: 27.58 });
    const before = JSON.stringify(read(root));
    expect(save(root, { word_pitch: 27.58 }).error).toBeUndefined();
    const after = read(root);
    CEILINGS.forEach((f) => expect(after[f]).toBeUndefined());
    expect(JSON.stringify(after)).toBe(before);
  });

  it('null clears one that was set — a ceiling has to be removable', () => {
    const root = scaffold({ word_max_he: 22 });
    expect(save(root, { word_max_he: null }).error).toBeUndefined();
    expect(read(root).word_max_he).toBeNull();
  });

  it('refuses nonsense rather than storing it', () => {
    // These reach the generator as a hard cap on what a paid order prints, so
    // they are validated like every other type number, not trusted.
    for (const bad of ['wide', 0, -3, 401, NaN, Infinity, {}]) {
      const root = scaffold({});
      const res = save(root, { title_max_en: bad });
      expect(res.error, `expected ${JSON.stringify(bad)} to be refused`).toMatch(/title_max_en/);
      expect(res.httpStatus).toBe(400);
      expect(read(root).title_max_en).toBeUndefined();
    }
  });

  it('a refusal changes nothing at all, not even the valid fields beside it', () => {
    const root = scaffold({});
    const res = save(root, { word_max_he: 22, word_max_en: -1 });
    expect(res.error).toMatch(/word_max_en/);
    expect(read(root).word_max_he).toBeUndefined();
  });

  it('accepts the boundary and rejects just past it', () => {
    const root = scaffold({});
    expect(save(root, { back_title_max_he: 400 }).error).toBeUndefined();
    expect(read(root).back_title_max_he).toBe(400);
    expect(save(root, { back_title_max_he: 400.5 }).error).toMatch(/back_title_max_he/);
  });

  it('sits alongside the geometry without disturbing it', () => {
    const root = scaffold({ word_pitch: 27.58 });
    expect(save(root, { word_max_he: 19.42, word_pitch: 28.01 }).error).toBeUndefined();
    const after = read(root);
    expect(after.word_max_he).toBe(19.42);
    expect(after.word_pitch).toBe(28.01);
  });
});
