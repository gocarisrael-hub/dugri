// @vitest-environment node
//
// word_color AND pawn_halo ON THE SETTINGS API.
//
// word_color pins the ink a design's card words print in (generator/
// config.word_color), over the colour detection recorded per slot. It exists
// because detection can read a cream-on-navy design's PAGE as its ink, and the
// deck then prints every word in the paper's own colour.
//
// pawn_halo: false prints a design's pawns without the white sticker outline
// (generator/config.pawn_halo). Absent is the house look.
//
// Both are optional: a save that does not mention them must leave the entry
// exactly as it was, and their "default" values drop the key rather than store it.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wordcolor-'));
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

describe('word_color and pawn_halo on the settings API', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  const save = (root, patch) => templates.updateTemplateSettings({ root, key: 'seed', patch });
  const read = (root) =>
    JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8')).seed;

  it('stores a pinned word ink, normalised to lower case', () => {
    const root = scaffold({});
    const r = save(root, { word_color: ' #FAF09D ' });
    expect(r.error).toBeUndefined();
    expect(read(root).word_color).toBe('#faf09d');
    expect(r.settings.word_color).toBe('#faf09d');
  });

  it('null returns to the detected ink by dropping the key', () => {
    const root = scaffold({ word_color: '#faf09d' });
    expect(save(root, { word_color: null }).error).toBeUndefined();
    expect('word_color' in read(root)).toBe(false);
  });

  it('refuses a colour that is not hex, and changes nothing beside it', () => {
    const root = scaffold({ word_size: 12 });
    const r = save(root, { word_color: 'gold', word_size: 20 });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toMatch(/word_color/);
    expect(read(root).word_size).toBe(12);
    expect('word_color' in read(root)).toBe(false);
  });

  it('stores pawn_halo:false and reports it', () => {
    const root = scaffold({});
    const r = save(root, { pawn_halo: false });
    expect(r.error).toBeUndefined();
    expect(read(root).pawn_halo).toBe(false);
    expect(r.settings.pawn_halo).toBe(false);
  });

  it('pawn_halo:true is the default, so it drops the key', () => {
    const root = scaffold({ pawn_halo: false });
    const r = save(root, { pawn_halo: true });
    expect(r.error).toBeUndefined();
    expect('pawn_halo' in read(root)).toBe(false);
    expect(r.settings.pawn_halo).toBe(true);
  });

  it('refuses a pawn_halo that is not a boolean', () => {
    const root = scaffold({});
    const r = save(root, { pawn_halo: 'false' });
    expect(r.httpStatus).toBe(400);
    expect('pawn_halo' in read(root)).toBe(false);
  });

  it('a save that names neither leaves both exactly as they were', () => {
    const root = scaffold({ word_color: '#faf09d', pawn_halo: false });
    expect(save(root, { word_size: 14 }).error).toBeUndefined();
    const e = read(root);
    expect(e.word_color).toBe('#faf09d');
    expect(e.pawn_halo).toBe(false);
  });
});
