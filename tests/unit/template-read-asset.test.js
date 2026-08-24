// @vitest-environment node
//
// READING a template's asset files back.
//
// Every asset a template owns could be WRITTEN through the API and none could be
// READ. The fonts in particular exist only on the volume, which is why the
// calibration bench shipped its own copies baked in as base64 — and then rendered
// a template in a face the site had already replaced.
//
// The property that matters most here is that read and write resolve a role
// IDENTICALLY: both go through assetRolesFor, so a role can never name one file
// to the writer and another to the reader.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// A minimal sfnt header — looksLikeFont's magic, so the writer accepts it too.
const FONT_BYTES = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(64, 7)]);

function scaffold(entry = {}, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-readasset-'));
  const dir = path.join(root, 'resources', 'canva', 'templates', 'seed');
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify({
      seed: {
        slug: 'seed',
        dir: 'resources/canva/templates/seed',
        calibrated: true,
        title_font: 'Title.ttf',
        word_font: 'Word.ttf',
        title_style: { fill: '#000', outline: '#000', outline_w: 0, arch: 0, shadow: false },
        ...entry,
      },
    }) + '\n',
    'utf8'
  );
  for (const [rel, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), bytes);
  }
  return root;
}

describe('reading a template asset', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  const read = (root, role) => templates.readAsset({ root, key: 'seed', role });

  it('hands back the file a role names, and says what kind it is', () => {
    const root = scaffold({}, { 'fonts/Title.ttf': FONT_BYTES });
    const res = read(root, 'title-font');
    expect(res.error).toBeUndefined();
    expect(res.kind).toBe('font');
    expect(res.rel).toBe('fonts/Title.ttf');
    expect(fs.readFileSync(res.file)).toEqual(FONT_BYTES);
  });

  it('follows the recorded filename, not a fixed one', () => {
    // A font role keeps the name of the file the owner uploaded; the reader has
    // to look where the writer actually put it.
    const root = scaffold(
      { title_font: 'Gan CLM Bold.ttf' },
      { 'fonts/Gan CLM Bold.ttf': FONT_BYTES }
    );
    expect(read(root, 'title-font').rel).toBe('fonts/Gan CLM Bold.ttf');
  });

  it('an optional role that was never uploaded is a normal answer, not a fault', () => {
    // A template with one title face simply has no title-font-alt.
    const root = scaffold({}, { 'fonts/Title.ttf': FONT_BYTES });
    const res = read(root, 'title-font-alt');
    expect(res.httpStatus).toBe(404);
    expect(res.optional).toBe(true);
  });

  it('a required role whose file is missing is still a 404, not a crash', () => {
    const root = scaffold({}, {});
    expect(read(root, 'title-font').httpStatus).toBe(404);
  });

  it('refuses a role that is not on the whitelist', () => {
    const root = scaffold({}, { 'fonts/Title.ttf': FONT_BYTES });
    const res = read(root, '../../../etc/passwd');
    expect(res.error).toMatch(/unknown asset role/);
    expect(res.httpStatus).toBe(404);
  });

  it('refuses an unknown template', () => {
    const root = scaffold({}, {});
    expect(templates.readAsset({ root, key: 'nope', role: 'title-font' }).httpStatus).toBe(404);
  });

  it('resolves the same file the writer wrote', () => {
    // The one property that keeps the two halves honest: round-trip a real
    // upload through replaceAsset and read it straight back.
    const root = scaffold({}, { 'fonts/Title.ttf': FONT_BYTES });
    const written = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(32, 9)]);
    const put = templates.replaceAsset({
      root,
      key: 'seed',
      role: 'word-font',
      file: { filename: 'Ktav.ttf', data: written },
    });
    expect(put.error).toBeUndefined();
    const got = read(root, 'word-font');
    expect(got.error).toBeUndefined();
    expect(fs.readFileSync(got.file)).toEqual(written);
  });
});
