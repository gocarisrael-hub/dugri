// @vitest-environment node
//
// An artwork file that names an image which will not render.
//
// Chrome draws an image it cannot load as its broken-image icon and exits 0. The
// grapefruit board reached the shop that way: a de-duplicated board names its
// images "../assets/<sha>.png", the preview render copied it to a work dir, and
// every logo square printed the icon (the generator half of the fix is
// generator/test_missing_images.py). Here: the same rules where the owner can act
// on them. An upload whose images cannot resolve is refused and named; a stored
// file that already names one is reported on the template's checklist.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ASSET = '0123456789abcdef.png';
const board = (href) =>
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
      'width="100" height="100" viewBox="0 0 100 100">' +
      `<image width="100" height="100" xlink:href="${href}"/></svg>`
  );
const FONT = () => Buffer.from([0x00, 0x01, 0x00, 0x00, 0x41]);

// A 'cards' template on disk, laid out like the migrated grapefruit.
function scaffold({ files = {}, entry = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-broken-img-'));
  const dir = path.join(root, 'resources', 'canva', 'templates', 'seed');
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify({
      seed: {
        slug: 'seed',
        dir: 'resources/canva/templates/seed',
        card_structure: 'cards',
        calibrated: false,
        title_font: 'Title.ttf',
        word_font: 'Word.ttf',
        ...entry,
      },
    }) + '\n',
    'utf8'
  );
  for (const [rel, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), bytes);
  }
  return { root, dir };
}

describe('broken image references in template artwork', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  it('names exactly the references that will not render, with why', () => {
    const { dir } = scaffold({ files: { ['assets/' + ASSET]: Buffer.from('png') } });
    const svg = [
      '<svg>',
      '<image xlink:href="data:image/png;base64,AAAA"/>',
      `<image xlink:href="../assets/${ASSET}"/>`,
      '<image xlink:href="../assets/gone.png"/>',
      '<image xlink:href="../assets/gone.png"/>',
      '<image href="../../../../etc/hosts"/>',
      '<image href="/data/templates/seed/assets/x.png"/>',
      '<image href="file:///Users/someone/logo.png"/>',
      '<image href="https://example.com/logo.png"/>',
      '<script>const s = `<image href="${href}">`;</script>',
      '</svg>',
    ].join('');
    expect(templates.brokenSvgImages(svg, path.join(dir, 'clean'), dir)).toEqual([
      { href: '../assets/gone.png', reason: 'missing' },
      { href: '../../../../etc/hosts', reason: 'outside' },
      { href: '/data/templates/seed/assets/x.png', reason: 'absolute' },
      { href: 'file:///Users/someone/logo.png', reason: 'external' },
      { href: 'https://example.com/logo.png', reason: 'external' },
    ]);
  });

  it('refuses a replacement board whose image is not in the template, and writes nothing', () => {
    const { root, dir } = scaffold({
      files: { 'clean/board.svg': board('data:image/png;base64,AA') },
    });
    const before = fs.readFileSync(path.join(dir, 'clean', 'board.svg'));
    const r = templates.replaceAsset({
      root,
      key: 'seed',
      role: 'clean-board',
      file: { filename: 'board.svg', data: board('../assets/' + ASSET) },
      shrinkImages: false,
    });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('../assets/' + ASSET);
    expect(r.brokenImages).toEqual([{ href: '../assets/' + ASSET, reason: 'missing' }]);
    expect(fs.readFileSync(path.join(dir, 'clean', 'board.svg'))).toEqual(before);
  });

  it('accepts the same board once the template holds that image', () => {
    const { root, dir } = scaffold({ files: { ['assets/' + ASSET]: Buffer.from('png') } });
    const r = templates.replaceAsset({
      root,
      key: 'seed',
      role: 'clean-board',
      file: { filename: 'board.svg', data: board('../assets/' + ASSET) },
      shrinkImages: false,
    });
    expect(r.error).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'clean', 'board.svg'))).toBe(true);
  });

  it('reports a stored board that names a missing image on the checklist', () => {
    const { root } = scaffold({ files: { 'clean/board.svg': board('../assets/' + ASSET) } });
    const st = templates.listTemplateStatuses(root).find((t) => t.key === 'seed');
    const asset = st.assets.find((a) => a.role === 'clean-board');
    expect(asset.brokenImages).toEqual([{ href: '../assets/' + ASSET, reason: 'missing' }]);
    expect(st.imageNotes).toHaveLength(1);
    expect(st.imageNotes[0].role).toBe('clean-board');
    expect(st.imageNotes[0].text).toContain('../assets/' + ASSET);
    // The file is there; it is not MISSING, so the checklist verdict is untouched.
    expect(st.missingRequired).not.toContain('clean-board');
  });

  it('says nothing about a template whose images all resolve', () => {
    const { root } = scaffold({
      files: {
        'clean/board.svg': board('../assets/' + ASSET),
        ['assets/' + ASSET]: Buffer.from('png'),
      },
    });
    const st = templates.listTemplateStatuses(root).find((t) => t.key === 'seed');
    expect(st.imageNotes).toEqual([]);
    expect(st.assets.find((a) => a.role === 'clean-board').brokenImages).toBeUndefined();
  });

  it('refuses a new template whose card names a shared image that was not uploaded', () => {
    const { root } = scaffold();
    const cards = (layer, withRef) =>
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
        filename: n + '.svg',
        data: n === 2 && withRef ? board('../assets/' + ASSET) : board('data:image/png;base64,AA'),
      }));
    const upload = (assets) => ({
      root,
      fields: { slug: 'new-one', display_he: 'חדש', title_text: '{NAME}', name_form: 'hebrew' },
      files: {
        title_font: { filename: 'Title.ttf', data: FONT() },
        word_font: { filename: 'Word.ttf', data: FONT() },
      },
      fileLists: {
        clean_cards: cards('clean', true),
        filled_cards: cards('filled', false),
        ...(assets ? { assets } : {}),
      },
      shrinkImages: false,
      runRecipe: false,
    });
    const r = templates.onboardTemplate(upload(null));
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('clean/2.svg');
    expect(r.error).toContain('../assets/' + ASSET);
    expect(fs.existsSync(path.join(root, 'resources', 'canva', 'templates', 'new-one'))).toBe(
      false
    );

    // Uploaded alongside it, the same card is accepted.
    const ok = templates.onboardTemplate(upload([{ filename: ASSET, data: Buffer.from('png') }]));
    expect(ok.error).toBeUndefined();
  });
});
