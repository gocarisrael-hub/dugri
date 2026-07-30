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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

  it('a single-card upload whose detection fails is still registered, and says so', () => {
    // Best-effort, exactly as for a sheet: a template that cannot be measured is
    // registered anyway, with the calibration panel left for the owner.
    const root = makeScaffold();
    const r = templates.onboardTemplate({
      root,
      ...cardsUpload(),
      shrinkImages: false,
      recipeRunner: () => ({ status: 1, stderr: 'no chrome here' }),
    });

    expect(r.key).toBe('card-demo');
    expect(r.recipe).toBe('failed');
    expect(r.note).toMatch(/did not run\/succeed/);
    const entry = JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8'))[
      'card-demo'
    ];
    expect(entry.calibrated).toBe(false);
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

  it('does NOT re-run detection on a plain replace (it is a button now)', () => {
    // A full pass is 18 Chrome start-ups — each card's clean/filled pair rendered
    // separately, ~38s on a laptop — and this ran on EVERY uploaded file, so
    // re-uploading nine files meant nine passes before the owner could do
    // anything. The admin panel has an explicit 'זהה מחדש' button instead.
    const calls = [];
    const r = templates.replaceAsset({
      root,
      key: 'card-demo',
      role: 'clean-5',
      file: { filename: 'x.svg', data: SVG('brand-new-front') },
      shrinkImages: false,
      recipeRunner: (bin, args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    expect(r.error).toBeUndefined();
    expect(calls.length).toBe(0);
    expect(r.redetect).toBeNull();
  });

  it('re-runs detection on replace when explicitly asked to', () => {
    // The 409 stops art being swapped SILENTLY under a calibrated template, but
    // once it IS swapped the detected recipe describes a picture that is no
    // longer there — including the INK COLOURS, which card_slots does not carry.
    // So the capability stays, opt-in.
    const calls = [];
    const r = templates.replaceAsset({
      root,
      key: 'card-demo',
      role: 'clean-5',
      file: { filename: 'x.svg', data: SVG('brand-new-front') },
      shrinkImages: false,
      redetectOnReplace: true,
      recipeRunner: (bin, args) => {
        calls.push(args);
        // Stand in for recipe_diff: success means a recipe actually LANDED, which
        // is what runRecipeDiff verifies rather than trusting the exit code.
        const out = path.join(root, 'generator', 'recipes', 'card-demo.json');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify({ theme: 'card-demo', format: 2 }), 'utf8');
        return { status: 0 };
      },
    });

    expect(r.error).toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toBe('--single');
    expect(r.redetect).toEqual({ ok: true, detail: null });
  });

  it('a failed re-detection is reported, not swallowed, and destroys nothing', () => {
    // (opt-in path — see above)
    // recipe_diff writes only on success, so the template keeps the geometry it
    // had. What must NOT happen is a silent pass: a forced replace that moved the
    // art and left stale slots would be the very thing the 409 exists to prevent.
    const dir = path.join(root, 'resources', 'canva', 'templates', 'card-demo');
    const before = fs.existsSync(path.join(dir, 'clean', '6.svg'));

    const r = templates.replaceAsset({
      root,
      key: 'card-demo',
      role: 'clean-6',
      file: { filename: 'x.svg', data: SVG('another-front') },
      shrinkImages: false,
      redetectOnReplace: true,
      recipeRunner: () => ({ status: 1, stderr: 'chrome missing' }),
    });

    expect(r.error).toBeUndefined(); // the REPLACE still succeeded
    expect(r.redetect.ok).toBe(false);
    expect(r.redetect.detail).toMatch(/chrome missing/);
    expect(fs.existsSync(path.join(dir, 'clean', '6.svg'))).toBe(before);
    expect(fs.readFileSync(path.join(dir, 'clean', '6.svg'), 'utf8')).toContain('another-front');
  });

  it('does NOT re-detect for a font or for a legacy sheet template', () => {
    // Detection measures the numbered card artwork. A font swap changes no slot
    // geometry, and a sheet template's recipe is not measured this way at all.
    let spawned = 0;
    const runner = () => {
      spawned += 1;
      return { status: 0 };
    };

    const font = templates.replaceAsset({
      root,
      key: 'card-demo',
      role: 'title-font',
      file: { filename: 'x.ttf', data: FONT() },
      shrinkImages: false,
      recipeRunner: runner,
    });
    expect(font.error).toBeUndefined();
    expect(font.redetect).toBeNull();

    const sheet = templates.replaceAsset({
      root,
      key: 'seed-theme',
      role: 'clean-fronts',
      file: { filename: 'x.svg', data: SVG('sheet-art') },
      shrinkImages: false,
      recipeRunner: runner,
    });
    expect(sheet.error).toBeUndefined();
    expect(sheet.redetect).toBeNull();

    expect(spawned).toBe(0);
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

// The detector measures a single-card template's slots and returns them in its
// blob, but applyCalibration merged only title_style/board/back/word_size — so
// card_slots was silently dropped, the admin form kept opening on its hardcoded
// defaults (boxes roughly twice the real width), and the preview came back with
// giant words and a title clipped off both card edges.
describe('applyCalibration — detected card_slots reach themes.json', () => {
  let templates;
  beforeAll(() => {
    // No owner store, so persistThemeEntry writes the shipped file these tests
    // read back — the same convention the other pure suites here use. (With a
    // store configured it writes the VOLUME instead, which is the whole point of
    // routing this through persistThemeEntry.)
    delete process.env.DATA_DIR;
    templates = require(path.join(serverDir, 'templates.js'));
  });

  const SLOTS = {
    words: [0, 1, 2, 3].map((i) => ({
      x0: 0.478,
      y0: 0.356 + i * 0.09,
      x1: 0.703,
      y1: 0.398 + i * 0.09,
    })),
    titles: Object.fromEntries(
      [2, 3, 4, 5, 6, 7, 8, 9].map((n) => [
        String(n),
        { x0: 0.271, y0: 0.109, x1: 0.728, y1: 0.204 },
      ])
    ),
  };

  function themesWith(entry) {
    const root = makeScaffold();
    const p = path.join(root, 'generator', 'themes.json');
    fs.writeFileSync(p, JSON.stringify({ demo: entry }), 'utf8');
    return p;
  }

  it('writes card_slots from the calibration blob', () => {
    const p = themesWith({ slug: 'demo', card_structure: 'cards', card_slots: null });
    templates.applyCalibration(p, 'demo', { card_slots: SLOTS });
    const entry = JSON.parse(fs.readFileSync(p, 'utf8')).demo;
    expect(entry.card_slots).not.toBeNull();
    expect(entry.card_slots.words).toHaveLength(4);
    expect(entry.card_slots.words[0].x0).toBeCloseTo(0.478, 3);
    expect(Object.keys(entry.card_slots.titles).sort()).toEqual([
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });

  it('leaves card_slots alone when the blob carries none', () => {
    const p = themesWith({ slug: 'demo', card_structure: 'cards', card_slots: SLOTS });
    templates.applyCalibration(p, 'demo', { word_size: 21.3 });
    const entry = JSON.parse(fs.readFileSync(p, 'utf8')).demo;
    expect(entry.card_slots.words).toHaveLength(4);
    expect(entry.word_size).toBe(21.3);
  });

  it('refuses a malformed card_slots rather than writing geometry the form would reject', () => {
    const p = themesWith({ slug: 'demo', card_structure: 'cards', card_slots: null });
    // three word boxes, and a title map missing most fronts
    templates.applyCalibration(p, 'demo', {
      card_slots: { words: SLOTS.words.slice(0, 3), titles: { 2: SLOTS.titles['2'] } },
    });
    expect(JSON.parse(fs.readFileSync(p, 'utf8')).demo.card_slots).toBeNull();
  });
});

// --- "in the store" vs "public/private" -------------------------------------
// Two DIFFERENT questions that used to share one field. `visibility` decides how
// an on-sale design is reached (open grid, or unlocked with an access code);
// `in_store` decides whether it is on sale at all. Conflating them meant taking a
// design off the shop floor still left it orderable by every code already issued.
describe('in_store — is the template offered in the shop at all', () => {
  let templates;
  beforeAll(() => {
    // Image paths only — a DATA_DIR left set by another suite would send these
    // writes to the owner store instead of the scaffold's themes.json.
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  it('a template that predates the flag is for sale, unchanged', () => {
    // Absent MUST read as true or every existing template would vanish from the
    // shop the moment this shipped.
    expect(templates.inStore({})).toBe(true);
    expect(templates.inStore({ visibility: 'public' })).toBe(true);
    expect(templates.inStore(null)).toBe(true);
    expect(templates.inStore(undefined)).toBe(true);
  });

  it('only an explicit false takes it off the shop floor', () => {
    expect(templates.inStore({ in_store: false })).toBe(false);
    expect(templates.inStore({ in_store: true })).toBe(true);
  });

  it('is INDEPENDENT of visibility — a private design can still be on sale', () => {
    // private + in store = hidden from the grid, reachable with a code.
    expect(templates.inStore({ visibility: 'private' })).toBe(true);
    // off the shop floor, whatever the visibility says.
    expect(templates.inStore({ visibility: 'private', in_store: false })).toBe(false);
    expect(templates.inStore({ visibility: 'public', in_store: false })).toBe(false);
  });

  it('the settings patch accepts it, and coerces the form value', () => {
    const root = makeScaffold();
    templates.onboardTemplate({ root, ...cardsUpload(), shrinkImages: false, runRecipe: false });
    const themesPath = path.join(root, 'generator', 'themes.json');

    templates.updateTemplateSettings({ root, key: 'card-demo', patch: { in_store: false } });
    let entry = JSON.parse(fs.readFileSync(themesPath, 'utf8'))['card-demo'];
    expect(entry.in_store).toBe(false);

    // Back on sale.
    templates.updateTemplateSettings({ root, key: 'card-demo', patch: { in_store: true } });
    entry = JSON.parse(fs.readFileSync(themesPath, 'utf8'))['card-demo'];
    expect(entry.in_store).toBe(true);

    // A string 'false' (what a <select> hands back) must not read as truthy.
    templates.updateTemplateSettings({ root, key: 'card-demo', patch: { in_store: 'false' } });
    entry = JSON.parse(fs.readFileSync(themesPath, 'utf8'))['card-demo'];
    expect(entry.in_store).toBe(false);
  });

  it('is reported on the status payload so the admin shows the real state', () => {
    const root = makeScaffold();
    templates.onboardTemplate({ root, ...cardsUpload(), shrinkImages: false, runRecipe: false });
    const themesPath = path.join(root, 'generator', 'themes.json');
    const entryNow = () => JSON.parse(fs.readFileSync(themesPath, 'utf8'))['card-demo'];

    // A fresh template reports true even though the key is absent from the entry.
    expect(templates.computeTemplateStatus(root, 'card-demo', entryNow()).in_store).toBe(true);

    templates.updateTemplateSettings({ root, key: 'card-demo', patch: { in_store: false } });
    expect(templates.computeTemplateStatus(root, 'card-demo', entryNow()).in_store).toBe(false);
  });
});

// Replacing a font wrote to a DIFFERENT path than the generator reads, for any
// theme whose font is recorded with a SUBDIRECTORY — which is how most shipped
// themes record theirs:
//
//   themes.json word_font : "Cafe Regular/Cafe Regular.ttf"
//   generator READS       : fonts/Cafe Regular/Cafe Regular.ttf
//   panel WROTE           : fonts/Cafe Regular.ttf   (basename'd)
//
// so the upload landed in a file nobody read and the old font rendered forever.
describe('replaceAsset — replacing a nested font actually takes effect', () => {
  let templates;
  beforeAll(() => {
    templates = require(path.join(serverDir, 'templates.js'));
  });

  function scaffoldWithNestedFont() {
    const root = makeScaffold();
    const dir = path.join(root, 'resources', 'canva', 'templates', 'nested');
    fs.mkdirSync(path.join(dir, 'fonts', 'Cafe Regular'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'clean'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'fonts', 'Cafe Regular', 'Cafe Regular.ttf'), FONT());
    fs.writeFileSync(
      path.join(root, 'generator', 'themes.json'),
      JSON.stringify({
        nested: {
          slug: 'nested',
          dir: 'resources/canva/templates/nested',
          recipe: 'nested',
          word_font: 'Cafe Regular/Cafe Regular.ttf',
          title_font: 'Cafe Regular/Cafe Regular.ttf',
        },
      }),
      'utf8'
    );
    return { root, dir };
  }

  it('writes to the nested path the generator actually reads', () => {
    const { root, dir } = scaffoldWithNestedFont();
    const bytes = FONT('NEWWORDFONT');
    const r = templates.replaceAsset({
      root,
      key: 'nested',
      role: 'word-font',
      file: { filename: 'comixno2clm_medium-webfont.ttf', data: bytes },
      shrinkImages: false,
    });
    expect(r.error).toBeUndefined();
    // The generator reads themes.json verbatim, so THIS is the file it opens.
    const read = path.join(dir, 'fonts', 'Cafe Regular', 'Cafe Regular.ttf');
    expect(fs.readFileSync(read).equals(bytes)).toBe(true);
    // ...and no stray flat copy that nothing reads.
    expect(fs.existsSync(path.join(dir, 'fonts', 'Cafe Regular.ttf'))).toBe(false);
  });

  it('leaves the recorded font name (and the other role) untouched', () => {
    const { root } = scaffoldWithNestedFont();
    templates.replaceAsset({
      root,
      key: 'nested',
      role: 'word-font',
      file: { filename: 'whatever.ttf', data: FONT() },
      shrinkImages: false,
    });
    const entry = JSON.parse(
      fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8')
    ).nested;
    expect(entry.word_font).toBe('Cafe Regular/Cafe Regular.ttf');
    expect(entry.title_font).toBe('Cafe Regular/Cafe Regular.ttf');
  });

  it('refuses a recorded font path that would climb out of fonts/', () => {
    const { root } = scaffoldWithNestedFont();
    const themesPath = path.join(root, 'generator', 'themes.json');
    const themes = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
    themes.nested.word_font = '../../../etc/evil.ttf';
    fs.writeFileSync(themesPath, JSON.stringify(themes), 'utf8');
    const r = templates.replaceAsset({
      root,
      key: 'nested',
      role: 'word-font',
      file: { filename: 'x.ttf', data: FONT() },
      shrinkImages: false,
    });
    // No recorded path resolves, so it falls back to the uploaded basename
    // inside fonts/ — never outside it.
    expect(r.error || /fonts[/\\]x\.ttf$/.test(r.path || '')).toBeTruthy();
    expect(r.path || '').not.toMatch(/\.\./);
  });
});

// Re-detection used to fire on EVERY asset replace. A full pass is 18 Chrome
// start-ups (each card's clean/filled pair rendered separately) — ~38s on a
// laptop — so re-uploading nine files meant nine full passes before the owner
// could do anything. It is an explicit button now.
describe('re-detection is opt-in, and available on demand', () => {
  let templates;
  beforeAll(() => {
    templates = require(path.join(serverDir, 'templates.js'));
  });

  it('exposes redetectTemplate for the button', () => {
    expect(typeof templates.redetectTemplate).toBe('function');
  });

  it('refuses to re-detect a template that does not exist', () => {
    const root = makeScaffold();
    const r = templates.redetectTemplate({ root, key: 'no-such-template' });
    expect(r.error).toBeTruthy();
    expect(r.httpStatus).toBe(404);
  });

  it('reports a detection failure instead of silently leaving stale slots', () => {
    const root = makeScaffold();
    const r0 = templates.onboardTemplate({ root, ...cardsUpload(), shrinkImages: false });
    expect(r0.error).toBeUndefined();
    const r = templates.redetectTemplate({
      root,
      key: 'card-demo',
      recipeRunner: () => ({ status: 1, stderr: 'chrome exploded' }),
    });
    expect(r.error).toMatch(/detection failed/);
    expect(r.httpStatus).toBe(422);
  });

  // A run can succeed and still have REFUSED to regularise something. Reporting
  // that as plain success is what let grapefruit come back with unevenly spaced
  // words from press after press of this button: the detector declined the
  // even-spacing snap on every container run, answered ok, and the only record
  // was a log line on a machine nobody was watching.
  const writeRecipe = (root, body) => {
    const target = path.join(root, 'generator', 'recipes', 'card-demo.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ theme: 'card-demo', format: 2, ...body }));
  };

  it('reports the regularisations detection refused, not just success', () => {
    const root = makeScaffold();
    expect(
      templates.onboardTemplate({ root, ...cardsUpload(), shrinkImages: false }).error
    ).toBeUndefined();
    const refusal = 'word slots: mids are not one progression — left as measured';
    const r = templates.redetectTemplate({
      root,
      key: 'card-demo',
      recipeRunner: () => (writeRecipe(root, { declined: [refusal] }), { status: 0 }),
      calibrateRunner: () => ({ status: 1, stderr: 'not the subject of this test' }),
    });
    expect(r.error).toBeUndefined();
    expect(r.declined).toEqual([refusal]);
  });

  it('reports nothing refused when the detection was clean', () => {
    const root = makeScaffold();
    expect(
      templates.onboardTemplate({ root, ...cardsUpload(), shrinkImages: false }).error
    ).toBeUndefined();
    const r = templates.redetectTemplate({
      root,
      key: 'card-demo',
      recipeRunner: () => (writeRecipe(root, {}), { status: 0 }),
      calibrateRunner: () => ({ status: 1, stderr: 'not the subject of this test' }),
    });
    expect(r.declined).toEqual([]);
  });
});

// Runtime writes must land on the VOLUME, not inside the container image. The
// image filesystem is ephemeral on Railway: a detected calibration written there
// survived until the next deploy and then silently vanished, so the owner
// pressed "detect again", saw it succeed, and later found the template back to
// "recipe is missing".
describe('applyCalibration persists to the owner store, not the image', () => {
  let templates;
  let dataDir;
  let root;

  beforeAll(() => {
    root = makeScaffold();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-vol-'));
    process.env.DATA_DIR = dataDir;
    // Fresh require so the store module picks up DATA_DIR.
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('server', ''))) delete require.cache[k];
    }
    templates = require(path.join(serverDir, 'templates.js'));
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('server', ''))) delete require.cache[k];
    }
  });

  it('writes the entry under DATA_DIR and leaves the shipped file alone', () => {
    const imagePath = path.join(root, 'generator', 'themes.json');
    fs.writeFileSync(
      imagePath,
      JSON.stringify({ volt: { slug: 'volt', card_structure: 'cards', word_size: null } }),
      'utf8'
    );
    const before = fs.readFileSync(imagePath, 'utf8');

    templates.applyCalibration(imagePath, 'volt', { word_size: 21.3 });

    // The shipped file is untouched...
    expect(fs.readFileSync(imagePath, 'utf8')).toBe(before);
    // ...and the value landed on the volume, where it survives a deploy.
    const ownerPath = path.join(dataDir, 'templates', 'themes.json');
    expect(fs.existsSync(ownerPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).volt.word_size).toBe(21.3);
  });
});

// A measured-but-invalid calibration field used to be discarded in silence.
// calibrate emits a title_style whose paints it could not read, validateTitleStyle
// refuses the whole object because fill/outline are not hex colours, the entry
// keeps title_style: null — and the owner gets a template that detects fine,
// writes card_slots fine, and whose preview refuses with "not calibrated yet",
// with nothing anywhere saying a value was produced and thrown away.
describe('applyCalibration reports what it rejected', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    templates = require(path.join(serverDir, 'templates.js'));
  });

  function entryAfter(blob, seed = { slug: 't1', title_style: null }) {
    const root = makeScaffold();
    const p = path.join(root, 'generator', 'themes.json');
    fs.writeFileSync(p, JSON.stringify({ t1: seed }), 'utf8');
    templates.applyCalibration(p, 't1', blob);
    return JSON.parse(fs.readFileSync(p, 'utf8')).t1;
  }

  it('keeps the old value and says which field was refused, and why', () => {
    const e = entryAfter({ title_style: { arch: 0, shadow: false, outline_w: 0.05 } });
    expect(e.title_style).toBeNull();
    const notes = (e.notes || []).join(' ');
    expect(notes).toMatch(/REJECTED/);
    expect(notes).toMatch(/title_style/);
    expect(notes).toMatch(/hex color/);
  });

  it('says nothing when everything validates', () => {
    const e = entryAfter({
      title_style: {
        fill: '#711d20',
        outline: '#711d20',
        outline_w: 0.05,
        arch: 0,
        shadow: false,
      },
    });
    expect(e.title_style.fill).toBe('#711d20');
    expect((e.notes || []).join(' ')).not.toMatch(/REJECTED/);
  });
});
