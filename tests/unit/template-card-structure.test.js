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

  // ...and SAYS SO. This was the one merge branch with no `else`, and the gap
  // was not academic: validateCardSlots refuses a titles map missing any front,
  // so a deck with a single unmeasurable card (מרקאנה's front 9, whose clean
  // plate is exported at a different scale from its filled twin) had its ENTIRE
  // card_slots block dropped — words included — while the run still reported
  // calibrated: true. The owner pressed "זהה מחדש", was told it worked, and the
  // geometry never moved, with nothing naming the front that caused it.
  it('reports a refused card_slots in notes instead of dropping it silently', () => {
    const p = themesWith({ slug: 'demo', card_structure: 'cards', card_slots: null });
    templates.applyCalibration(p, 'demo', {
      card_slots: { words: SLOTS.words, titles: { 2: SLOTS.titles['2'] } },
    });
    const entry = JSON.parse(fs.readFileSync(p, 'utf8')).demo;
    expect(entry.card_slots).toBeNull();
    const notes = (entry.notes || []).join(' ');
    expect(notes).toMatch(/card_slots/);
    expect(notes).toMatch(/9\.svg/); // name the front that is missing
  });

  it('does not claim the template cannot render when only card_slots was refused', () => {
    // That tail is about title_style specifically. A rejected card_slots leaves
    // a template that renders fine on its previous geometry, and saying it
    // cannot render sends the owner hunting for a fault that is not there.
    const p = themesWith({ slug: 'demo', card_structure: 'cards', card_slots: null });
    templates.applyCalibration(p, 'demo', {
      card_slots: { words: SLOTS.words, titles: { 2: SLOTS.titles['2'] } },
    });
    const notes = (JSON.parse(fs.readFileSync(p, 'utf8')).demo.notes || []).join(' ');
    expect(notes).not.toMatch(/cannot render/);
  });

  // The LEADING — how far apart the title's lines are stacked, as a fraction of
  // the type size. The calibrator measures it off the design's own artwork, and
  // it is inseparable from the size it was measured beside: a size that lands
  // without its spacing prints the right type stacked the wrong way. It has to
  // survive this whitelist, or the measurement never reaches the card.
  const TS = {
    fill: '#97d8e6',
    outline: '#0d3e43',
    outline_w: 0.05,
    arch: 0,
    shadow: false,
    size: 23.9,
  };

  it('writes the measured title leading', () => {
    const p = themesWith({ slug: 'demo', title_style: null });
    templates.applyCalibration(p, 'demo', { title_style: { ...TS, leading: 1.13 } });
    const entry = JSON.parse(fs.readFileSync(p, 'utf8')).demo;
    expect(entry.title_style.leading).toBe(1.13);
    expect(entry.title_style.size).toBe(23.9);
  });

  it('leaves the leading absent when nothing measured one', () => {
    // A single-line title has no spacing to measure. Absent must stay absent —
    // the renderer then keeps its own step, which is how every design already
    // in production goes on rendering exactly as it does today.
    const p = themesWith({ slug: 'demo', title_style: null });
    templates.applyCalibration(p, 'demo', { title_style: { ...TS } });
    const entry = JSON.parse(fs.readFileSync(p, 'utf8')).demo;
    expect('leading' in entry.title_style).toBe(false);
  });

  it('accepts every leading the measurement can actually return', () => {
    // The bounds are calibrate.py's own search grid (0.30..2.00). A value the
    // measurement can legitimately produce must not be refused, because
    // title_style is validated as a WHOLE: one rejected field throws away the
    // colours and sizes measured beside it and the template goes on reporting
    // itself uncalibrated. סנטוריני's back really does measure 0.48, which the
    // old 0.5 floor would have thrown the whole entry away over.
    for (const good of [0.3, 0.48, 0.78, 2]) {
      const p = themesWith({ slug: 'demo', title_style: null });
      templates.applyCalibration(p, 'demo', { title_style: { ...TS, leading: good } });
      expect(JSON.parse(fs.readFileSync(p, 'utf8')).demo.title_style.leading).toBe(good);
    }
  });

  // ONE TEXT BOX. Set by calibration where the original's title ink has no row
  // structure left to read — a ring thick enough welds the lines into one mass
  // (סיישל) — and it tells the renderer to stack the lines at exactly the
  // leading above instead of opening them up to keep the outlines apart. It has
  // to survive this whitelist for the same reason the leading does: it is the
  // other half of the same reading, and without it the title re-spaces.
  it('writes the one_block flag beside the leading it belongs to', () => {
    const p = themesWith({ slug: 'demo', title_style: null });
    templates.applyCalibration(p, 'demo', {
      title_style: { ...TS, leading: 0.75, one_block: true },
    });
    const entry = JSON.parse(fs.readFileSync(p, 'utf8')).demo;
    expect(entry.title_style.one_block).toBe(true);
    expect(entry.title_style.leading).toBe(0.75);
  });

  it('leaves one_block absent on a design whose rows can be read', () => {
    const p = themesWith({ slug: 'demo', title_style: null });
    templates.applyCalibration(p, 'demo', { title_style: { ...TS, leading: 0.75 } });
    expect('one_block' in JSON.parse(fs.readFileSync(p, 'utf8')).demo.title_style).toBe(false);
  });

  it('refuses a one_block that is not a boolean', () => {
    const p = themesWith({ slug: 'demo', title_style: null });
    templates.applyCalibration(p, 'demo', { title_style: { ...TS, one_block: 'yes' } });
    expect(JSON.parse(fs.readFileSync(p, 'utf8')).demo.title_style).toBeNull();
  });

  it('refuses a leading that would overprint or split the title', () => {
    // Outside the grid it is not a design, it is a mis-measurement, and it would
    // print on every card of a paid order — so the whole title_style is refused
    // and the old one kept, exactly as a bad colour is.
    for (const bad of [0.2, 3, 'x', null]) {
      const p = themesWith({ slug: 'demo', title_style: null });
      templates.applyCalibration(p, 'demo', { title_style: { ...TS, leading: bad } });
      const got = JSON.parse(fs.readFileSync(p, 'utf8')).demo.title_style;
      if (bad === null) {
        expect('leading' in got).toBe(false); // null = "not measured", not an error
      } else {
        expect(got).toBeNull();
      }
    }
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

  // Distinguishable bytes. The shared FONT() helper above ignores its argument,
  // so a test written with it cannot tell the new file from the old one — which
  // is how the assertions below used to pass no matter where the upload landed.
  const FONT_BYTES = (label) =>
    Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from(label)]);

  it('records the uploaded name so file and themes.json still agree', () => {
    const { root, dir } = scaffoldWithNestedFont();
    const bytes = FONT_BYTES('NEWWORDFONT');
    const r = templates.replaceAsset({
      root,
      key: 'nested',
      role: 'word-font',
      file: { filename: 'comixno2clm_medium-webfont.ttf', data: bytes },
      shrinkImages: false,
    });
    expect(r.error).toBeUndefined();
    // The generator reads themes.json verbatim, so whatever is recorded there is
    // the file it opens — the invariant is that the two agree, not that the name
    // never changes.
    const entry = JSON.parse(
      fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8')
    ).nested;
    expect(entry.word_font).toBe('comixno2clm_medium-webfont.ttf');
    expect(fs.readFileSync(path.join(dir, 'fonts', entry.word_font)).equals(bytes)).toBe(true);
  });

  it('a word-font upload leaves the title font alone even when they share a file', () => {
    // Both roles start on ONE nested file. Replacing the word font must not drag
    // the title font along — that is exactly the trap that made a template's two
    // fonts impossible to separate.
    const { root, dir } = scaffoldWithNestedFont();
    templates.replaceAsset({
      root,
      key: 'nested',
      role: 'word-font',
      file: { filename: 'whatever.ttf', data: FONT_BYTES('WORDONLY') },
      shrinkImages: false,
    });
    const entry = JSON.parse(
      fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8')
    ).nested;
    expect(entry.word_font).toBe('whatever.ttf');
    expect(entry.title_font).toBe('Cafe Regular/Cafe Regular.ttf');
    expect(entry.word_font).not.toBe(entry.title_font);
    // The shared file still holds the ORIGINAL bytes — the title font is intact.
    const shared = path.join(dir, 'fonts', 'Cafe Regular', 'Cafe Regular.ttf');
    expect(fs.readFileSync(shared).equals(FONT())).toBe(true);
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

// ---- ONE-FRONT mode --------------------------------------------------------
// The upload shortcut for a deck where every card carries the SAME design: one
// front + one back instead of nine files per layer.
//
// The thing these pin hardest is that it is a NARROWER FRONT LIST, not a copy.
// build.py picks a card's front with `fronts[card["front"] % len(fronts)]`, so a
// one-element list lands all 103 word cards on that one design by arithmetic —
// no duplicated artwork on disk, in the image or in a render, and nothing to
// drift apart when the owner re-uploads the design. Everything downstream must
// therefore read the ENTRY's front list rather than a hardcoded 2..9.
describe('single-card layout — ONE front for the whole deck', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  // The four files the mode takes: front + back, clean + filled.
  function oneFrontUpload(overrides = {}) {
    return {
      fields: {
        slug: 'one-demo',
        display_he: 'עיצוב אחד',
        title_text: '{NAME}',
        name_form: 'hebrew',
        card_structure: 'cards',
        card_fronts: 'one',
        ...(overrides.fields || {}),
      },
      files: {
        title_font: { filename: 'Title.ttf', data: FONT() },
        word_font: { filename: 'Word.ttf', data: FONT() },
        clean_1: { filename: '1.svg', data: SVG('clean-back') },
        clean_2: { filename: '2.svg', data: SVG('clean-front') },
        filled_1: { filename: '1.svg', data: SVG('filled-back') },
        filled_2: { filename: '2.svg', data: SVG('filled-front') },
        ...(overrides.files || {}),
      },
      fileLists: overrides.fileLists || {},
    };
  }
  // A valid saved calibration for a ONE-front deck: the four shared word slots
  // plus the single title position the deck actually has.
  function oneFrontSlots() {
    const box = (y0) => ({ x0: 0.1, y0, x1: 0.9, y1: y0 + 0.1 });
    return {
      words: [box(0.3), box(0.45), box(0.6), box(0.75)],
      titles: { 2: { ...box(0.05), x1: 0.92 } },
    };
  }
  function onboardOne(root, overrides) {
    return templates.onboardTemplate({
      root,
      ...oneFrontUpload(overrides),
      shrinkImages: false,
      runRecipe: false,
    });
  }

  it('registers FOUR files and a single-index front list — no duplicated artwork', () => {
    const root = makeScaffold();
    const r = onboardOne(root);
    expect(r.error).toBeUndefined();
    expect(r.card_structure).toBe('cards');
    expect(r.card_fronts).toEqual([2]);

    const dir = path.join(root, 'resources', 'canva', 'templates', 'one-demo');
    for (const layer of ['clean', 'filled']) {
      expect(fs.existsSync(path.join(dir, layer, '1.svg'))).toBe(true);
      expect(fs.existsSync(path.join(dir, layer, '2.svg'))).toBe(true);
      // The whole point: 3..9 are NOT copies of 2 — they do not exist at all.
      for (let n = 3; n <= 9; n += 1) {
        expect(fs.existsSync(path.join(dir, layer, n + '.svg'))).toBe(false);
      }
    }
    const entry = templates.loadThemes(templates.themesPathFor(root))['one-demo'];
    expect(entry.card_structure).toBe('cards');
    // The generator's own `cards` block — this is what makes the deck cycle a
    // single front (config.fronts reads cards.fronts first).
    expect(entry.cards).toEqual({ back: 1, fronts: [2] });
    expect(entry.card_slots).toBeNull();
    expect(entry.calibrated).toBe(false);
    expect(templates.entryFrontNumbers(entry)).toEqual([2]);
  });

  it('a NORMAL eight-front upload is completely unaffected — still no cards block', () => {
    const root = makeScaffold();
    const r = templates.onboardTemplate({
      root,
      ...cardsUpload(),
      shrinkImages: false,
      runRecipe: false,
    });
    expect(r.error).toBeUndefined();
    expect(r.card_fronts).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    const entry = templates.loadThemes(templates.themesPathFor(root))['card-demo'];
    // No `cards` key at all: the entry is byte-for-byte what onboarding has
    // always produced, and the generator's [2..9] default still applies.
    expect('cards' in entry).toBe(false);
    expect(templates.entryFrontNumbers(entry)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    const st = templates.computeTemplateStatus(root, 'card-demo', entry);
    expect(st.card_fronts).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    for (const layer of ['clean', 'filled']) {
      for (let n = 1; n <= 9; n += 1) {
        expect(st.assets.map((a) => a.role)).toContain(layer + '-' + n);
      }
    }
  });

  it('rejects a missing FRONT in Hebrew, naming the file and the slot', () => {
    const root = makeScaffold();
    const up = oneFrontUpload();
    delete up.files.clean_2;
    const r = templates.onboardTemplate({ root, ...up, shrinkImages: false, runRecipe: false });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('2.svg');
    expect(r.error).toContain('פנים');
    expect(r.error).toContain('clean');
    // ...and nothing was registered.
    expect(templates.loadThemes(templates.themesPathFor(root))['one-demo']).toBeUndefined();
  });

  it('rejects a missing BACK in Hebrew, naming the file and the slot', () => {
    const root = makeScaffold();
    const up = oneFrontUpload();
    delete up.files.filled_1;
    const r = templates.onboardTemplate({ root, ...up, shrinkImages: false, runRecipe: false });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('1.svg');
    expect(r.error).toContain('גב הקלף');
    expect(r.error).toContain('filled');
    // The message is the ONE-FRONT one, not the eighteen-file one.
    expect(r.error).toContain('4 קבצים');
    expect(r.error).not.toContain('18 קבצים');
  });

  it('refuses files this deck has no card for, rather than writing dead assets', () => {
    const root = makeScaffold();
    const r = onboardOne(root, {
      files: { clean_5: { filename: '5.svg', data: SVG('stray') } },
    });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toContain('5.svg');
    expect(r.error).toContain('אינם בשימוש');
  });

  it("refuses card_fronts:'one' on the legacy sheet layout, which has no fronts to narrow", () => {
    const root = makeScaffold();
    const r = templates.normalizeMetadata({
      root,
      fields: {
        slug: 'sheet-one',
        display_he: 'גיליון',
        title_text: '{NAME}',
        name_form: 'hebrew',
        card_structure: 'sheet',
        card_fronts: 'one',
      },
    });
    expect(r.error).toMatch(/card_structure/);
    expect(
      templates.normalizeMetadata({ root, fields: { slug: 'x', card_fronts: 'lots' } }).error
    ).toBeTruthy();
  });

  it('asks for FOUR numbered assets in the checklist, and reads complete with them', () => {
    const root = makeScaffold();
    onboardOne(root, {
      files: {
        clean_board: { filename: 'board.svg', data: SVG('cb') },
        filled_board: { filename: 'board.svg', data: SVG('fb') },
      },
    });
    const entry = templates.loadThemes(templates.themesPathFor(root))['one-demo'];
    const st = templates.computeTemplateStatus(root, 'one-demo', entry);
    expect(st.card_fronts).toEqual([2]);
    const roles = st.assets.map((a) => a.role);
    expect(roles).toContain('clean-1');
    expect(roles).toContain('clean-2');
    // The seven fronts this deck does not have must not be listed as missing —
    // the checklist would never read complete.
    for (let n = 3; n <= 9; n += 1) {
      expect(roles).not.toContain('clean-' + n);
      expect(roles).not.toContain('filled-' + n);
    }
    expect(st.missingRequired).toEqual([]);
    expect(st.complete).toBe(true);
  });

  it('refuses to replace an asset role this deck has no card for', () => {
    const root = makeScaffold();
    onboardOne(root);
    const r = templates.replaceAsset({
      root,
      key: 'one-demo',
      role: 'clean-5',
      file: { filename: 'x.svg', data: SVG('nope') },
      shrinkImages: false,
    });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toMatch(/does not belong to this template/);
    // ...while its own front still replaces normally.
    const ok = templates.replaceAsset({
      root,
      key: 'one-demo',
      role: 'clean-2',
      file: { filename: 'x.svg', data: SVG('new-front') },
      shrinkImages: false,
    });
    expect(ok.error).toBeUndefined();
  });

  it('calibrates with ONE title position, and still demands one per front on a normal deck', () => {
    // The one-front deck: a single title box is the complete calibration.
    expect(templates.validateCardSlots(oneFrontSlots(), [2]).error).toBeUndefined();
    // The same blob against the default eight-front deck is INCOMPLETE, and says
    // exactly which fronts have no title position.
    const short = templates.validateCardSlots(oneFrontSlots());
    expect(short.error).toContain('3.svg');
    expect(short.error).toContain('9.svg');
    // A form that posts more fronts than the deck has writes no dead geometry.
    const extra = templates.validateCardSlots(cardSlots(), [2]);
    expect(extra.error).toBeUndefined();
    expect(Object.keys(extra.value.titles)).toEqual(['2']);
  });

  it('saves the one-front calibration and flips calibrated:true', () => {
    const root = makeScaffold();
    onboardOne(root);
    const style = { fill: '#112233', outline: '#ffffff', outline_w: 0.05, arch: 0, shadow: false };
    const r = templates.updateTemplateSettings({
      root,
      key: 'one-demo',
      patch: { title_style: style, card_slots: oneFrontSlots(), calibrated: true },
    });
    expect(r.error).toBeUndefined();
    const entry = templates.loadThemes(templates.themesPathFor(root))['one-demo'];
    expect(entry.calibrated).toBe(true);
    expect(Object.keys(entry.card_slots.titles)).toEqual(['2']);
    // The `cards` block survives the save — losing it would silently restore the
    // eight-front cycle and send the deck looking for 3.svg..9.svg.
    expect(entry.cards).toEqual({ back: 1, fronts: [2] });
  });

  it('lets the DETECTED calibration land on a one-front entry (the "זהה מחדש" path)', () => {
    const root = makeScaffold();
    onboardOne(root);
    const p = templates.themesPathFor(root);
    templates.applyCalibration(p, 'one-demo', { card_slots: oneFrontSlots() });
    const entry = templates.loadThemes(p)['one-demo'];
    expect(Object.keys(entry.card_slots.titles)).toEqual(['2']);
  });

  it('shows the deck’s own front as the storefront picture', () => {
    expect(templates.filledImageRel({ card_structure: 'cards' }, 'front')).toBe('filled/2.svg');
    expect(
      templates.filledImageRel(
        { card_structure: 'cards', cards: { back: 1, fronts: [2] } },
        'front'
      )
    ).toBe('filled/2.svg');
    expect(
      templates.filledImageRel({ card_structure: 'cards', cards: { back: 1, fronts: [2] } }, 'back')
    ).toBe('filled/1.svg');
  });

  it('creates a one-front SHELL for the per-asset upload flow', () => {
    const root = makeScaffold();
    const r = templates.createTemplateShell({
      root,
      fields: {
        slug: 'shell-one',
        display_he: 'שלד',
        title_text: '{NAME}',
        name_form: 'hebrew',
        card_structure: 'cards',
        card_fronts: 'one',
      },
    });
    expect(r.error).toBeUndefined();
    expect(r.card_fronts).toEqual([2]);
    expect(r.theme.cards).toEqual({ back: 1, fronts: [2] });
    expect(r.note).toContain('2.svg');
  });

  it('reads a junk/duplicate/out-of-range front list as the default, never as a filename', () => {
    const f = templates.entryFrontNumbers;
    expect(f({})).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(f({ cards: { fronts: [] } })).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(f({ cards: { fronts: ['x', null, 99, 0] } })).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    // 1 is the BACK, never a front.
    expect(f({ cards: { fronts: [1, 2, 2, 3] } })).toEqual([2, 3]);
    // The legacy flat key the generator also reads.
    expect(f({ fronts: [4] })).toEqual([4]);
  });
});

// CONVERTING AN EXISTING TEMPLATE. Onboarding could always take one front + one
// back, but only for a NEW template — an owner moving a shipped SHEET deck onto
// the card layout had no way to say "every card carries the same design", so the
// checklist demanded all eighteen numbered files. These cover the settings patch
// that does it, and the file housekeeping that "replace" implies: the previous
// layout's SVGs must not survive the conversion, including via the additive
// shipped→owner backfill that runs on every asset write.
describe('converting an existing template to the single-card layout', () => {
  let templates;
  let root;
  let dataDir;

  function reload(withStore) {
    if (withStore) {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-cvt-data-'));
      process.env.DATA_DIR = dataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    delete require.cache[require.resolve(path.join(serverDir, 'template-store.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  }

  // A shipped SHEET template: entry with no card_structure + the four sheet SVGs.
  function seedSheet(key = 'sheet-demo') {
    const themesPath = templates.themesPathFor(root);
    const themes = templates.loadThemes(themesPath);
    themes[key] = { slug: key, display_he: 'גיליון', calibrated: true };
    fs.writeFileSync(themesPath, JSON.stringify(themes, null, 1) + '\n', 'utf8');
    const dir = path.join(root, 'resources', 'canva', 'templates', key);
    for (const layer of ['clean', 'filled']) {
      fs.mkdirSync(path.join(dir, layer), { recursive: true });
      for (const f of ['fronts.svg', 'backs.svg', 'board.svg']) {
        fs.writeFileSync(path.join(dir, layer, f), SVG(layer + '-' + f).toString(), 'utf8');
      }
    }
    return { key, dir };
  }

  const entryOf = (key) => templates.loadThemes(templates.themesPathFor(root))[key];

  beforeAll(() => {
    reload(false);
    root = makeScaffold();
  });
  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('one save switches layout AND front mode, recording a narrow front list', () => {
    const { key } = seedSheet('cvt-one');
    const r = templates.updateTemplateSettings({
      root,
      key,
      patch: { card_structure: 'cards', card_fronts: 'one' },
    });
    expect(r.error).toBeUndefined();
    // A narrower FRONT LIST — never nine copies of one file.
    expect(entryOf(key).cards).toEqual({ back: 1, fronts: [2] });
    expect(r.settings.card_structure).toBe('cards');
    expect(r.settings.card_fronts).toEqual([2]);
  });

  it('the checklist then asks for FOUR card files instead of eighteen', () => {
    const { key } = seedSheet('cvt-list');
    templates.updateTemplateSettings({
      root,
      key,
      patch: { card_structure: 'cards', card_fronts: 'one' },
    });
    const st = templates.computeTemplateStatus(root, key, entryOf(key));
    const cardRoles = st.assets
      .map((a) => a.role)
      .filter((r) => /^(clean|filled)-\d+$/.test(r))
      .sort();
    expect(cardRoles).toEqual(['clean-1', 'clean-2', 'filled-1', 'filled-2']);
    // The board is shared by both layouts and stays; the sheet's own files go.
    expect(st.assets.map((a) => a.role)).toContain('clean-board');
    expect(st.assets.map((a) => a.role)).not.toContain('clean-fronts');
  });

  it('the conversion drops `calibrated` — the geometry was measured on other art', () => {
    const { key } = seedSheet('cvt-cal');
    expect(entryOf(key).calibrated).toBe(true);
    templates.updateTemplateSettings({ root, key, patch: { card_structure: 'cards' } });
    expect(entryOf(key).calibrated).toBe(false);
  });

  it('an explicit calibrated:true in the SAME save cannot resurrect the geometry', () => {
    const { key } = seedSheet('cvt-cal2');
    const r = templates.updateTemplateSettings({
      root,
      key,
      patch: { card_fronts: 'one', card_structure: 'cards', calibrated: true },
    });
    // Refused outright (no card_slots for the new layout) — never silently true.
    expect(r.error).toBeUndefined();
    expect(entryOf(key).calibrated).toBe(false);
  });

  it("refuses card_fronts:'one' on a template that stays a sheet", () => {
    const { key } = seedSheet('cvt-refuse');
    const r = templates.updateTemplateSettings({ root, key, patch: { card_fronts: 'one' } });
    expect(r.error).toMatch(/requires card_structure/);
    expect(entryOf(key).cards).toBeUndefined();
  });

  it('rejects an unknown front mode', () => {
    const { key } = seedSheet('cvt-bad');
    const r = templates.updateTemplateSettings({ root, key, patch: { card_fronts: 'seven' } });
    expect(r.error).toMatch(/card_fronts must be one of/);
  });

  it('switching back to `all` drops the block entirely (byte-for-byte the default)', () => {
    const { key } = seedSheet('cvt-back');
    templates.updateTemplateSettings({
      root,
      key,
      patch: { card_structure: 'cards', card_fronts: 'one' },
    });
    expect(entryOf(key).cards).toEqual({ back: 1, fronts: [2] });
    const r = templates.updateTemplateSettings({ root, key, patch: { card_fronts: 'all' } });
    expect(r.error).toBeUndefined();
    expect('cards' in entryOf(key)).toBe(false);
    expect(r.settings.card_fronts).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('a no-op front-mode save on an unconverted sheet changes nothing', () => {
    const { key } = seedSheet('cvt-noop');
    const r = templates.updateTemplateSettings({ root, key, patch: { card_fronts: 'all' } });
    // Nothing to change — and it must not be reported as a successful conversion.
    expect(r.error).toMatch(/no valid settings/);
    expect(entryOf(key).calibrated).toBe(true);
  });

  it('NEVER deletes from the shipped image dir (a checkout with no DATA_DIR)', () => {
    const { key, dir } = seedSheet('cvt-shipped');
    templates.updateTemplateSettings({
      root,
      key,
      patch: { card_structure: 'cards', card_fronts: 'one' },
    });
    // The repo's own artwork survives; it is simply no longer read.
    expect(fs.existsSync(path.join(dir, 'clean', 'fronts.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'filled', 'backs.svg'))).toBe(true);
  });

  describe('with a persistent store (production shape)', () => {
    beforeAll(() => {
      reload(true);
      root = makeScaffold();
    });

    it('the sheet SVGs do not survive into the owner copy on the first card upload', () => {
      const { key } = seedSheet('cvt-store');
      templates.updateTemplateSettings({
        root,
        key,
        patch: { card_structure: 'cards', card_fronts: 'one' },
      });
      // The first upload is what claims the owner dir, copying the shipped one in.
      const up = templates.replaceAsset({
        root,
        key,
        role: 'clean-2',
        file: { filename: '2.svg', data: SVG('the-one-front') },
      });
      expect(up.error).toBeUndefined();

      const ownerDir = path.join(dataDir, 'templates', key);
      const rel = (p) => path.join(ownerDir, p);
      // What the owner uploaded, and the board both layouts share: present.
      expect(fs.existsSync(rel('clean/2.svg'))).toBe(true);
      expect(fs.existsSync(rel('clean/board.svg'))).toBe(true);
      // The previous layout's art: gone, and NOT restored by the additive
      // shipped→owner backfill that runs on every write.
      for (const dead of ['clean/fronts.svg', 'clean/backs.svg', 'filled/fronts.svg']) {
        expect(fs.existsSync(rel(dead)), dead + ' should not be copied across').toBe(false);
      }
    });

    it('a template left on the sheet layout keeps its files copied across as before', () => {
      const { key } = seedSheet('cvt-untouched');
      const up = templates.replaceAsset({
        root,
        key,
        role: 'clean-fronts',
        file: { filename: 'fronts.svg', data: SVG('new-fronts') },
        // Seeded calibrated, and this one is NOT being converted — so the
        // replace-on-a-calibrated-template guard applies and has to be confirmed.
        force: true,
      });
      expect(up.error).toBeUndefined();
      const ownerDir = path.join(dataDir, 'templates', key);
      // Nothing is pruned from a template that was never converted.
      expect(fs.existsSync(path.join(ownerDir, 'clean', 'backs.svg'))).toBe(true);
      expect(fs.existsSync(path.join(ownerDir, 'filled', 'fronts.svg'))).toBe(true);
    });
  });
});

// PER-FRONT BACKS. Some templates are authored as eight complete card STYLES —
// a front AND its own matching back each. The single-back layout could not
// express that at all, so those templates were impossible to upload. The backs
// are numbered 10-17, DISJOINT from the fronts (2-9), and paired POSITIONALLY:
// 10 prints on the reverse of 2, 11 of 3, … 17 of 9.
describe('per-front backs — eight styles, each with its own back', () => {
  let templates;
  let root;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
    root = makeScaffold();
    templates.onboardTemplate({ root, ...cardsUpload(), shrinkImages: false, runRecipe: false });
  });

  const entryOf = (key) => templates.loadThemes(templates.themesPathFor(root))[key];
  const cardRoles = (key) =>
    templates
      .computeTemplateStatus(root, key, entryOf(key))
      .assets.map((a) => a.role)
      .filter((r) => /^clean-\d+$/.test(r))
      .map((r) => Number(r.split('-')[1]))
      .sort((a, b) => a - b);

  it('switching to per-front backs records the positional pairing', () => {
    const r = templates.updateTemplateSettings({
      root,
      key: 'card-demo',
      patch: { card_backs: 'per-front' },
    });
    expect(r.error).toBeUndefined();
    expect(entryOf('card-demo').cards.fronts).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(entryOf('card-demo').cards.backs).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    expect(r.settings.card_backs).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('drops the shared back — nothing on a paired deck ever prints it', () => {
    expect('back' in entryOf('card-demo').cards).toBe(false);
    // …and the checklist stops asking for 1.svg, which the owner could never
    // meaningfully fill on this layout.
    expect(cardRoles('card-demo')).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
  });

  it('names each back by the STYLE it belongs to, not by its file number', () => {
    const st = templates.computeTemplateStatus(root, 'card-demo', entryOf('card-demo'));
    const label = (role) => st.assets.find((a) => a.role === role).label;
    expect(label('clean-10')).toContain('גב 1');
    expect(label('clean-17')).toContain('גב 8');
    expect(label('clean-2')).toContain('פנים 1');
  });

  it('the paired back roles are accepted by the replace API', () => {
    const up = templates.replaceAsset({
      root,
      key: 'card-demo',
      role: 'clean-17',
      file: { filename: '17.svg', data: SVG('back-of-front-9') },
    });
    expect(up.error).toBeUndefined();
    expect(up.path).toMatch(/17\.svg$/);
  });

  it('rejects a back number outside the 10-17 range', () => {
    const up = templates.replaceAsset({
      root,
      key: 'card-demo',
      role: 'clean-18',
      file: { filename: '18.svg', data: SVG('nope') },
    });
    expect(up.error).toMatch(/unknown asset role/);
  });

  it('the conversion drops `calibrated` — each back may carry its title elsewhere', () => {
    expect(entryOf('card-demo').calibrated).toBe(false);
  });

  it('switching back to a shared back restores the single 1.svg slot', () => {
    const r = templates.updateTemplateSettings({
      root,
      key: 'card-demo',
      patch: { card_backs: 'shared' },
    });
    expect(r.error).toBeUndefined();
    expect('backs' in entryOf('card-demo').cards).toBe(false);
    expect(entryOf('card-demo').cards.back).toBe(1);
    expect(cardRoles('card-demo')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('pairs only the fronts the deck actually renders (one-front + its own back)', () => {
    templates.updateTemplateSettings({
      root,
      key: 'card-demo',
      patch: { card_fronts: 'one' },
    });
    templates.updateTemplateSettings({
      root,
      key: 'card-demo',
      patch: { card_backs: 'per-front' },
    });
    // One front renders, so exactly one back is paired with it — not eight.
    expect(entryOf('card-demo').cards.fronts).toEqual([2]);
    expect(entryOf('card-demo').cards.backs).toEqual([10]);
    expect(cardRoles('card-demo')).toEqual([2, 10]);
  });

  it("refuses 'per-front' on a template that stays a sheet", () => {
    const themesPath = templates.themesPathFor(root);
    const themes = templates.loadThemes(themesPath);
    themes['pb-sheet'] = { slug: 'pb-sheet', display_he: 'גיליון' };
    fs.writeFileSync(themesPath, JSON.stringify(themes, null, 1) + '\n', 'utf8');
    const r = templates.updateTemplateSettings({
      root,
      key: 'pb-sheet',
      patch: { card_backs: 'per-front' },
    });
    expect(r.error).toMatch(/requires card_structure/);
  });

  it('rejects an unknown back mode', () => {
    const r = templates.updateTemplateSettings({
      root,
      key: 'card-demo',
      patch: { card_backs: 'sometimes' },
    });
    expect(r.error).toMatch(/card_backs must be one of/);
  });

  it('a shared-back template reports an EMPTY back list, not null', () => {
    const themes = templates.loadThemes(templates.themesPathFor(root));
    const st = templates.computeTemplateStatus(root, 'seed-theme', themes['seed-theme']);
    // A legacy sheet has no card layout at all.
    expect(st.card_backs).toEqual([]);
  });
});
