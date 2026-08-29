// @vitest-environment node
//
// word_bold ON THE SETTINGS API — whether a design sets its words heavy.
//
// The word faces have no real bold, so the weight is a stroke drawn around every
// glyph (generator/config.word_bold_w, which returns 0.0 unless this is true).
// That stroke also WIDENS the glyph, which is why the fit reads it and not only
// the draw.
//
// The bench has had the switch since the weight existed, and drew it correctly,
// and could never save it: the switch went into the settings payload, the API
// had no branch for it, and updateTemplateSettings copies only the keys it
// matched — so the unknown key was dropped in silence. The wall went heavy and
// the press printed light.
//
// As with word_alt_scale, the rule that matters most is that it stays OPTIONAL:
// a save that does not mention it must come through byte-identical, because
// absent is the state most shipped designs are in.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wordbold-'));
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

describe('word_bold on the settings API', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  const save = (root, patch) => templates.updateTemplateSettings({ root, key: 'seed', patch });
  const read = (root) =>
    JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8')).seed;

  it('stores the switch the owner flipped', () => {
    const root = scaffold({});
    expect(save(root, { word_bold: true }).error).toBeUndefined();
    expect(read(root).word_bold).toBe(true);
  });

  it('turns it back off — false is a value, not an absence', () => {
    // The whole bug was a dropped key reading as "she did not ask", so false has
    // to survive as false rather than vanish into the same silence.
    const root = scaffold({ word_bold: true });
    expect(save(root, { word_bold: false }).error).toBeUndefined();
    expect(read(root).word_bold).toBe(false);
  });

  it('leaves a template that never mentions it exactly as it was', () => {
    const root = scaffold({ word_pitch: 27.58 });
    const before = JSON.stringify(read(root));
    expect(save(root, { word_pitch: 27.58 }).error).toBeUndefined();
    expect(JSON.stringify(read(root))).toBe(before);
  });

  it('refuses anything that is not a boolean, and writes nothing', () => {
    for (const bad of ['true', 1, 0, {}, []]) {
      const root = scaffold({});
      const res = save(root, { word_bold: bad });
      expect(res.error, JSON.stringify(bad)).toMatch(/word_bold/);
      expect('word_bold' in read(root)).toBe(false);
    }
  });

  it('rides along with the other word settings in one save', () => {
    const root = scaffold({ word_pitch: 27.58 });
    expect(
      save(root, { word_bold: true, word_pitch: 29.17, word_size: 18.7 }).error
    ).toBeUndefined();
    const after = read(root);
    expect(after.word_bold).toBe(true);
    expect(after.word_pitch).toBe(29.17);
    expect(after.word_size).toBe(18.7);
  });
});
