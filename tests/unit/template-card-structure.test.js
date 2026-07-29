// @vitest-environment node
//
// The PORTRAIT SINGLE-CARD asset layout ('cards'): clean/filled 1.svg-9.svg,
// where 1 is the card back and 2-9 the eight fronts, with the BOARD kept out of
// that set as its own output file. Covers onboarding/validation, the per-template
// asset checklist, the shared-word-slots + per-front-title calibration blob, and
// — throughout — that a template on the LEGACY sheet layout behaves exactly as it
// did before any of this existed.
//
// Runs against a THROWAWAY repo scaffold so nothing touches the real resources/
// or generator/themes.json, mirroring tests/unit/admin-templates.test.js.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
const SVG = (label) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${label}</svg>`);
const FONT = () => Buffer.from([0x00, 0x01, 0x00, 0x00, 0x41]);

function makeScaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-cards-root-'));
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify({ 'seed-theme': { slug: 'seed-theme', calibrated: true } }, null, 1) + '\n',
    'utf8'
  );
  return root;
}

// The nine numbered SVGs of one layer, as a single multi-file pick would deliver
// them: one part per file, all sharing the input's name.
function cardParts(layer, numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  return numbers.map((n) => ({ filename: n + '.svg', data: SVG(layer + '-' + n) }));
}
function cardsUpload(overrides = {}) {
  return {
    fields: {
      slug: 'card-demo',
      display_he: 'קלף בודד',
      title_text: '{NAME}',
      name_form: 'hebrew',
      ...(overrides.fields || {}),
    },
    files: {
      title_font: { filename: 'Title.ttf', data: FONT() },
      word_font: { filename: 'Word.ttf', data: FONT() },
      ...(overrides.files || {}),
    },
    fileLists: {
      clean_cards: cardParts('clean'),
      filled_cards: cardParts('filled'),
      ...(overrides.fileLists || {}),
    },
  };
}
// A valid saved calibration for a single card: four shared word slots + a title
// position for each of the eight fronts.
function cardSlots() {
  const box = (y0) => ({ x0: 0.1, y0, x1: 0.9, y1: y0 + 0.1 });
  const titles = {};
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) titles[String(n)] = { ...box(0.05), x1: 0.92 };
  return { words: [box(0.3), box(0.45), box(0.6), box(0.75)], titles };
}

describe('single-card layout — onboarding + validation', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR; // image paths only, as the other pure suites do
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  it('parseMultipart keeps EVERY part of a repeated name (the nine-file picker)', () => {
    const boundary = 'bx';
    const chunks = [];
    for (const n of [1, 2, 3]) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="clean_cards"; ` +
            `filename="${n}.svg"\r\n\r\n`
        ),
        SVG('c' + n),
        Buffer.from('\r\n')
      );
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const { files, fileLists } = templates.parseMultipart(Buffer.concat(chunks), boundary);
    expect(fileLists.clean_cards.map((f) => f.filename)).toEqual(['1.svg', '2.svg', '3.svg']);
    // `files` still holds one entry per name, so every existing caller is unchanged.
    expect(files.clean_cards.filename).toBe('3.svg');
  });

  it('onboards the NEW layout: 18 numbered files land, no recipe run, entry says cards', () => {
    const root = makeScaffold();
    const up = cardsUpload();
    const r = templates.onboardTemplate({
      root,
      ...up,
      shrinkImages: false,
      runRecipe: false,
    });
    expect(r.error).toBeUndefined();
    expect(r.card_structure).toBe('cards');
    const dir = path.join(root, 'resources', 'canva', 'templates', 'card-demo');
    for (const layer of ['clean', 'filled']) {
      for (let n = 1; n <= 9; n += 1) {
        expect(fs.existsSync(path.join(dir, layer, n + '.svg'))).toBe(true);
      }
      // the sheet layout's files are NOT created
      expect(fs.existsSync(path.join(dir, layer, 'fronts.svg'))).toBe(false);
    }
    const entry = JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8'))[
      'card-demo'
    ];
    expect(entry.card_structure).toBe('cards');
    expect(entry.card_slots).toBeNull();
    expect(entry.calibrated).toBe(false);
  });

  // Detection used to be skipped for single-card templates, because recipe_diff
  // only understood the 8-up sheet and their slots had to be measured by hand.
  // It understands the single-card structure now, so skipping it left every card
  // template arriving with an empty recipe and no sign detection had simply never
  // been attempted.
  it('RUNS recipe_diff for a single-card template, in --single mode', () => {
    const root = makeScaffold();
    const calls = [];
    templates.onboardTemplate({
      root,
      ...cardsUpload(),
      shrinkImages: false,
      recipeRunner: (bin, args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    expect(calls).toHaveLength(1);
    const args = calls[0];
    // The detector takes the template DIRECTORY, not a fronts.svg pair — a
    // single-card template has no sheet to diff.
    expect(args).toContain('--single');
    expect(args.some((a) => String(a).endsWith('recipe_diff.py'))).toBe(true);
    expect(args.some((a) => String(a).endsWith('fronts.svg'))).toBe(false);
    expect(args[args.length - 1]).toBe('card-demo');
  });

  it('the BOARD is optional on a deck-first upload, and lands when supplied', () => {
    const root = makeScaffold();
    const r = templates.onboardTemplate({
      root,
      ...cardsUpload({
        files: {
          clean_board: { filename: 'board.svg', data: SVG('cb') },
          filled_board: { filename: 'board.svg', data: SVG('fb') },
        },
      }),
      shrinkImages: false,
      runRecipe: false,
    });
    expect(r.error).toBeUndefined();
    const dir = path.join(root, 'resources', 'canva', 'templates', 'card-demo');
    expect(fs.existsSync(path.join(dir, 'clean', 'board.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'filled', 'board.svg'))).toBe(true);
  });

  it('NAMES every missing and misnamed file instead of failing on the first one', () => {
    const root = makeScaffold();
    const r = templates.onboardTemplate({
      root,
      ...cardsUpload({
        fileLists: {
          // 3 and 7 missing from clean; filled carries a junk name instead of 7
          clean_cards: cardParts('clean', [1, 2, 4, 5, 6, 8, 9]),
          filled_cards: [
            ...cardParts('filled', [1, 2, 3, 4, 5, 6, 8, 9]),
            { filename: 'front7 (1).svg', data: SVG('junk') },
          ],
        },
      }),
      shrinkImages: false,
      runRecipe: false,
    });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('3.svg');
    expect(r.error).toContain('7.svg');
    expect(r.error).toContain('front7 (1).svg');
    // clean's list is reported separately from filled's
    expect(r.error).toMatch(/clean/);
    expect(r.error).toMatch(/filled/);
    // nothing was registered
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8'))['card-demo']
    ).toBeUndefined();
  });

  it('a HALF-correct new-layout upload is judged as new-layout, not as a legacy one', () => {
    // Only 1.svg + 2.svg picked. Sniffing on PRESENCE (not completeness) is what
    // makes the message name the seven missing cards rather than "missing clean
    // fronts SVG", which would send the owner looking for the wrong file.
    const root = makeScaffold();
    const r = templates.onboardTemplate({
      root,
      ...cardsUpload({
        fileLists: { clean_cards: cardParts('clean', [1, 2]), filled_cards: cardParts('filled') },
      }),
      shrinkImages: false,
      runRecipe: false,
    });
    expect(r.error).toContain('9.svg');
    expect(r.error).not.toMatch(/fronts SVG/);
  });

  it('accepts explicit per-slot parts (clean_1..clean_9) as well as the picker', () => {
    const root = makeScaffold();
    const files = { title_font: { filename: 'T.ttf', data: FONT() } };
    files.word_font = { filename: 'W.ttf', data: FONT() };
    for (let n = 1; n <= 9; n += 1) {
      files['clean_' + n] = { filename: 'x.svg', data: SVG('c' + n) };
      files['filled_' + n] = { filename: 'y.svg', data: SVG('f' + n) };
    }
    const r = templates.onboardTemplate({
      root,
      fields: { slug: 'explicit', display_he: 'מפורש', title_text: '{NAME}', name_form: 'hebrew' },
      files,
      shrinkImages: false,
      runRecipe: false,
    });
    expect(r.error).toBeUndefined();
    expect(r.card_structure).toBe('cards');
  });

  it('writes de-duplicated shared images into assets/, and rejects a junk asset name', () => {
    const root = makeScaffold();
    const ok = templates.onboardTemplate({
      root,
      ...cardsUpload({
        fileLists: { assets: [{ filename: '0123456789abcdef.png', data: Buffer.from('img') }] },
      }),
      shrinkImages: false,
      runRecipe: false,
    });
    expect(ok.error).toBeUndefined();
    const dir = path.join(root, 'resources', 'canva', 'templates', 'card-demo');
    expect(fs.existsSync(path.join(dir, 'assets', '0123456789abcdef.png'))).toBe(true);

    const bad = templates.onboardTemplate({
      root: makeScaffold(),
      ...cardsUpload({
        fileLists: { assets: [{ filename: '../evil.png', data: Buffer.from('x') }] },
      }),
      shrinkImages: false,
      runRecipe: false,
    });
    expect(bad.httpStatus).toBe(400);
    expect(bad.error).toContain('assets');
  });

  it('a LEGACY sheet upload is untouched: fronts/backs/board, recipe run, no structure key', () => {
    const root = makeScaffold();
    const files = {
      clean_fronts: { filename: 'a.svg', data: SVG('cf') },
      clean_backs: { filename: 'b.svg', data: SVG('cb') },
      clean_board: { filename: 'c.svg', data: SVG('cbo') },
      filled_fronts: { filename: 'd.svg', data: SVG('ff') },
      filled_backs: { filename: 'e.svg', data: SVG('fb') },
      filled_board: { filename: 'f.svg', data: SVG('fbo') },
      title_font: { filename: 'T.ttf', data: FONT() },
      word_font: { filename: 'W.ttf', data: FONT() },
    };
    let spawned = 0;
    const r = templates.onboardTemplate({
      root,
      fields: {
        slug: 'sheet-demo',
        display_he: 'גיליון',
        title_text: '{NAME}',
        name_form: 'hebrew',
      },
      files,
      shrinkImages: false,
      recipeRunner: () => {
        spawned += 1;
        return { status: 1, stderr: 'no chrome' };
      },
    });
    expect(r.error).toBeUndefined();
    expect(r.card_structure).toBe('sheet');
    expect(spawned).toBe(1); // the sheet path still tries recipe detection
    const entry = JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8'))[
      'sheet-demo'
    ];
    expect('card_structure' in entry).toBe(false); // absent === legacy
    const dir = path.join(root, 'resources', 'canva', 'templates', 'sheet-demo');
    expect(fs.existsSync(path.join(dir, 'clean', 'fronts.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'clean', '1.svg'))).toBe(false);
  });

  it('createTemplateShell honours the layout (assets/ dir + a cards entry)', () => {
    const root = makeScaffold();
    const r = templates.createTemplateShell({
      root,
      fields: {
        slug: 'shell-cards',
        display_he: 'ריק',
        title_text: '{NAME}',
        name_form: 'hebrew',
        card_structure: 'cards',
      },
    });
    expect(r.card_structure).toBe('cards');
    expect(r.theme.card_structure).toBe('cards');
    expect(
      fs.existsSync(path.join(root, 'resources', 'canva', 'templates', 'shell-cards', 'assets'))
    ).toBe(true);
    expect(r.note).toContain('1.svg');
  });

  it('rejects an unknown card_structure', () => {
    const root = makeScaffold();
    const r = templates.createTemplateShell({
      root,
      fields: {
        slug: 'bad-structure',
        display_he: 'x',
        title_text: '{NAME}',
        name_form: 'hebrew',
        card_structure: 'origami',
      },
    });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('card_structure');
  });
});

describe('single-card layout — asset checklist + per-asset replace', () => {
  let templates;
  let root;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
    root = makeScaffold();
    templates.onboardTemplate({ root, ...cardsUpload(), shrinkImages: false, runRecipe: false });
  });

  it('lists the eighteen numbered roles plus the SEPARATE board, and no fronts/backs', () => {
    const themes = templates.loadThemes(templates.themesPathFor(root));
    const st = templates.computeTemplateStatus(root, 'card-demo', themes['card-demo']);
    const roles = st.assets.map((a) => a.role);
    for (const layer of ['clean', 'filled']) {
      for (let n = 1; n <= 9; n += 1) expect(roles).toContain(layer + '-' + n);
    }
    expect(roles).toContain('clean-board');
    expect(roles).toContain('filled-board');
    expect(roles).toContain('clean-board-chasers');
    expect(roles).not.toContain('clean-fronts');
    expect(roles).not.toContain('filled-backs');
    // The nine cards landed; the board did not (deck-first upload).
    expect(st.assets.find((a) => a.role === 'clean-1').present).toBe(true);
    expect(st.assets.find((a) => a.role === 'clean-board').present).toBe(false);
    expect(st.missingRequired).toContain('clean-board');
    // The layout + the card box the calibration form needs.
    expect(st.card_structure).toBe('cards');
    expect(st.card_viewbox).toEqual({ w: 223.92, h: 312 });
    expect(st.card_slots).toBeNull();
  });

  it('a template with no card_structure still reports the legacy checklist', () => {
    const st = templates.computeTemplateStatus(root, 'seed-theme', { slug: 'seed-theme' });
    const roles = st.assets.map((a) => a.role);
    expect(roles).toContain('clean-fronts');
    expect(roles).not.toContain('clean-1');
    expect(st.card_structure).toBe('sheet');
  });

  it('replaces ONE numbered card in place, leaving the other eight alone', () => {
    const r = templates.replaceAsset({
      root,
      key: 'card-demo',
      role: 'filled-4',
      file: { filename: 'whatever.svg', data: SVG('new-front-3') },
      shrinkImages: false,
    });
    expect(r.error).toBeUndefined();
    const dir = path.join(root, 'resources', 'canva', 'templates', 'card-demo');
    expect(fs.readFileSync(path.join(dir, 'filled', '4.svg'), 'utf8')).toContain('new-front-3');
    expect(fs.readFileSync(path.join(dir, 'filled', '5.svg'), 'utf8')).toContain('filled-5');
  });

  it('a role from the OTHER layout is refused with an explanation, not a crash', () => {
    const wrongOnCards = templates.replaceAsset({
      root,
      key: 'card-demo',
      role: 'clean-fronts',
      file: { filename: 'x.svg', data: SVG('x') },
      shrinkImages: false,
    });
    expect(wrongOnCards.httpStatus).toBe(400);
    expect(wrongOnCards.error).toContain('cards');

    const wrongOnSheet = templates.replaceAsset({
      root,
      key: 'seed-theme',
      role: 'clean-3',
      file: { filename: 'x.svg', data: SVG('x') },
      shrinkImages: false,
    });
    expect(wrongOnSheet.httpStatus).toBe(400);
    expect(wrongOnSheet.error).toContain('sheet');
  });

  it('maps a storefront picture slot to the right file per layout', () => {
    expect(templates.filledImageRel({ card_structure: 'cards' }, 'front')).toBe('filled/2.svg');
    expect(templates.filledImageRel({ card_structure: 'cards' }, 'back')).toBe('filled/1.svg');
    expect(templates.filledImageRel({ card_structure: 'cards' }, 'board')).toBe('filled/board.svg');
    expect(templates.filledImageRel({}, 'front')).toBe('filled/fronts.svg');
    expect(templates.filledImageRel({}, 'back')).toBe('filled/backs.svg');
    expect(templates.filledImageRel({}, 'unknown-slot')).toBeNull();
    // ...and resolves to a real file on disk for the onboarded cards template.
    const p = templates.templateImagePath(root, 'card-demo', 'front');
    expect(p.endsWith(path.join('filled', '2.svg'))).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });
});

describe('single-card calibration blob (shared words + per-front titles)', () => {
  let templates;
  let root;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
    root = makeScaffold();
    templates.onboardTemplate({ root, ...cardsUpload(), shrinkImages: false, runRecipe: false });
  });

  it('accepts four word slots + all eight title positions, and returns a fresh object', () => {
    const v = templates.validateCardSlots({ ...cardSlots(), junk: 'x' });
    expect(v.error).toBeUndefined();
    expect(v.value.words).toHaveLength(4);
    expect(Object.keys(v.value.titles).sort()).toEqual(['2', '3', '4', '5', '6', '7', '8', '9']);
    expect('junk' in v.value).toBe(false);
    // null is the uncalibrated state, not an error.
    expect(templates.validateCardSlots(null)).toEqual({ value: null });
  });

  it('rejects a missing front, a wrong word count, and an inverted/out-of-range box', () => {
    const missing = cardSlots();
    delete missing.titles['7'];
    expect(templates.validateCardSlots(missing).error).toContain('7.svg');

    const short = cardSlots();
    short.words.pop();
    expect(templates.validateCardSlots(short).error).toContain('4');

    const inverted = cardSlots();
    inverted.words[0] = { x0: 0.9, y0: 0.1, x1: 0.2, y1: 0.3 };
    expect(templates.validateCardSlots(inverted).error).toContain('x0 must be < x1');

    const off = cardSlots();
    off.titles['3'] = { x0: 0.1, y0: 0.1, x1: 1.4, y1: 0.3 };
    expect(templates.validateCardSlots(off).error).toContain('fraction 0..1');
  });

  it('saves card_slots and flips calibrated:true once the geometry is there', () => {
    const style = { fill: '#112233', outline: '#ffffff', outline_w: 0.05, arch: 0, shadow: false };
    const r = templates.updateTemplateSettings({
      root,
      key: 'card-demo',
      patch: { title_style: style, card_slots: cardSlots(), calibrated: true },
    });
    expect(r.error).toBeUndefined();
    const entry = templates.loadThemes(templates.themesPathFor(root))['card-demo'];
    expect(entry.calibrated).toBe(true);
    expect(entry.card_slots.words).toHaveLength(4);
    expect(entry.card_slots.titles['9'].x1).toBe(0.92);
    // ...and the saved blob comes back to the form through the status view.
    const st = templates.computeTemplateStatus(root, 'card-demo', entry);
    expect(st.card_slots.words[0].y0).toBe(0.3);
  });

  it('REFUSES calibrated:true on a single-card template with no card_slots', () => {
    const r2 = makeScaffold();
    templates.onboardTemplate({
      root: r2,
      ...cardsUpload({ fields: { slug: 'no-slots' } }),
      shrinkImages: false,
      runRecipe: false,
    });
    const r = templates.updateTemplateSettings({
      root: r2,
      key: 'no-slots',
      patch: {
        title_style: { fill: '#000000', outline: '#ffffff', outline_w: 0, arch: 0, shadow: false },
        calibrated: true,
      },
    });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('card_slots');
    // A SHEET template with the same patch still calibrates — unchanged behaviour.
    const ok = templates.updateTemplateSettings({
      root: r2,
      key: 'seed-theme',
      patch: {
        title_style: { fill: '#000000', outline: '#ffffff', outline_w: 0, arch: 0, shadow: false },
        calibrated: true,
      },
    });
    expect(ok.error).toBeUndefined();
  });

  it('switching layout drops calibrated:false — the slots no longer describe the art', () => {
    const r = templates.updateTemplateSettings({
      root,
      key: 'card-demo',
      patch: { card_structure: 'sheet' },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings.calibrated).toBe(false);
    const entry = templates.loadThemes(templates.themesPathFor(root))['card-demo'];
    expect(entry.card_structure).toBe('sheet');
    expect(entry.calibrated).toBe(false);
    // Re-selecting the SAME layout is a no-op, not a silent un-calibration.
    templates.updateTemplateSettings({
      root,
      key: 'card-demo',
      patch: { card_structure: 'cards', calibrated: false },
    });
    const back = templates.updateTemplateSettings({
      root,
      key: 'card-demo',
      patch: { card_structure: 'cards', calibrated: true },
    });
    expect(back.settings.calibrated).toBe(true);
  });

  it('validateCalibration (the live-preview path) carries card_slots through', () => {
    const v = templates.validateCalibration({
      title_style: { fill: '#000000', outline: '#ffffff', outline_w: 0, arch: 0, shadow: false },
      card_slots: cardSlots(),
    });
    expect(v.error).toBeUndefined();
    expect(v.value.card_slots.words).toHaveLength(4);
    // A sheet template sends none, and that is still valid.
    const sheet = templates.validateCalibration({
      title_style: { fill: '#000000', outline: '#ffffff', outline_w: 0, arch: 0, shadow: false },
    });
    expect(sheet.value.card_slots).toBeNull();
  });
});

// --- Endpoint: the multipart upload of a nine-file pick ----------------------
function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from('--' + boundary + '\r\n'));
    if (p.filename != null) {
      chunks.push(
        Buffer.from(
          'Content-Disposition: form-data; name="' +
            p.name +
            '"; filename="' +
            p.filename +
            '"\r\nContent-Type: application/octet-stream\r\n\r\n'
        ),
        Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data)),
        Buffer.from('\r\n')
      );
    } else {
      chunks.push(
        Buffer.from(
          'Content-Disposition: form-data; name="' + p.name + '"\r\n\r\n' + p.value + '\r\n'
        )
      );
    }
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return Buffer.concat(chunks);
}

describe('POST /api/admin/templates — single-card upload', () => {
  let server;
  let base;
  let root;

  beforeAll(async () => {
    root = makeScaffold();
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-cards-data-'));
    process.env.GENERATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-cards-gen-'));
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.TEMPLATE_ROOT = root;
    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'templates.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    const app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  async function upload(parts) {
    const boundary = '----dugriCards' + Math.random().toString(16).slice(2);
    const res = await fetch(base + '/api/admin/templates?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: buildMultipart(boundary, parts),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  function meta(slug) {
    return [
      { name: 'slug', value: slug },
      { name: 'display_he', value: 'קלף בודד' },
      { name: 'title_text', value: '{NAME}' },
      { name: 'name_form', value: 'hebrew' },
      { name: 'title_font', filename: 'T.ttf', data: FONT() },
      { name: 'word_font', filename: 'W.ttf', data: FONT() },
    ];
  }

  it('accepts nine files per layer posted under ONE field name', async () => {
    const parts = meta('e2e-cards');
    for (const layer of ['clean', 'filled']) {
      for (let n = 1; n <= 9; n += 1) {
        parts.push({ name: layer + '_cards', filename: n + '.svg', data: SVG(layer + n) });
      }
    }
    const r = await upload(parts);
    expect(r.status).toBe(201);
    expect(r.body.card_structure).toBe('cards');
    const dir = path.join(process.env.DATA_DIR, 'templates', 'e2e-cards');
    expect(fs.existsSync(path.join(dir, 'clean', '9.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'filled', '1.svg'))).toBe(true);
  });

  it('400s with the missing file names when the pick is short', async () => {
    const parts = meta('e2e-short');
    for (const layer of ['clean', 'filled']) {
      for (const n of [1, 2, 3]) {
        parts.push({ name: layer + '_cards', filename: n + '.svg', data: SVG(layer + n) });
      }
    }
    const r = await upload(parts);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('4.svg');
    expect(r.body.error).toContain('9.svg');
  });
});
