// @vitest-environment node
//
// Admin template onboarding: (1) the pure-ish write + themes.json-append logic in
// server/templates.js, and (2) the multipart POST /api/admin/templates endpoint
// booted on the real Express app. Both run against a THROWAWAY repo scaffold
// (TEMPLATE_ROOT) so nothing touches the real resources/ or generator/themes.json.
// The recipe step is exercised with a fast FAKE "python" (a shell script) that
// writes generator/recipes/<slug>.json — no Chrome/Pillow needed in CI.
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
// A buffer that passes the sfnt-magic font check (0x00010000 = TrueType), for
// exercising the font-replace happy path now that filename extension is ignored.
const FONT = (label = '') =>
  Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from(label)]);

// Build a fresh throwaway repo scaffold. The real themes.json always ships with
// entries; an EMPTY mapping is now treated as missing/corrupt and refused (so a
// lone entry can't wipe the file), hence we seed one existing theme here so
// onboarding always appends alongside it.
//
// NOTE ON DATA_DIR: with a persistent volume configured, the admin routes write
// to the OWNER STORE (DATA_DIR/templates) and never into the image tree — see
// server/template-store.js and templates-store.test.js. The pure-logic suites
// below deliberately run with DATA_DIR UNSET, which is the "image paths only"
// mode, so they assert the pre-store behaviour unchanged.
function makeScaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-root-'));
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify({ 'seed-theme': { slug: 'seed-theme', calibrated: true } }, null, 1) + '\n',
    'utf8'
  );
  return root;
}

// Standard set of valid onboarding files (clean+filled fronts/backs/board + fonts).
function validFiles() {
  return {
    clean_fronts: { filename: 'cf.svg', data: SVG('clean-fronts') },
    clean_backs: { filename: 'cb.svg', data: SVG('clean-backs') },
    clean_board: { filename: 'cbo.svg', data: SVG('clean-board') },
    filled_fronts: { filename: 'ff.svg', data: SVG('filled-fronts') },
    filled_backs: { filename: 'fb.svg', data: SVG('filled-backs') },
    filled_board: { filename: 'fbo.svg', data: SVG('filled-board') },
    title_font: { filename: 'Title.ttf', data: Buffer.from('TITLEFONT') },
    word_font: { filename: 'Word.ttf', data: Buffer.from('WORDFONT') },
  };
}

describe('templates.js pure logic', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR; // no owner store: image paths only, as before
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  it('isSafeSlug accepts good slugs and rejects unsafe ones', () => {
    expect(templates.isSafeSlug('bat-mitzvah-gold')).toBe(true);
    expect(templates.isSafeSlug('a1')).toBe(true);
    expect(templates.isSafeSlug('Bad')).toBe(false); // uppercase
    expect(templates.isSafeSlug('has space')).toBe(false);
    expect(templates.isSafeSlug('../etc')).toBe(false);
    expect(templates.isSafeSlug('trailing-')).toBe(false);
    expect(templates.isSafeSlug('')).toBe(false);
  });

  it('buildThemeEntry produces a PUBLIC-by-default, uncalibrated entry with null style/board/back', () => {
    const e = templates.buildThemeEntry({
      slug: 'demo',
      displayHe: 'דמו',
      titleText: "{NAME}'S\nB-DAY",
      titleFont: 'Title.ttf',
      wordFont: 'Word.ttf',
      nameForm: 'english',
      extraFields: ['AGE'],
    });
    expect(e.visibility).toBe('public'); // default: not private
    expect(e.calibrated).toBe(false);
    expect(e.title_style).toBeNull();
    expect(e.board).toBeNull();
    expect(e.back).toBeNull();
    expect(e.recipe).toBe('demo');
    expect(e.dir).toBe('resources/canva/templates/demo');
    expect(e.title_lines).toEqual(["{NAME}'S", 'B-DAY']);
    expect(e.extra_fields).toEqual(['AGE']);
    expect(e.language).toBe('english');
  });

  it('buildThemeEntry honors an explicit visibility (private on request)', () => {
    const pub = templates.buildThemeEntry({ slug: 'a', nameForm: 'english' });
    expect(pub.visibility).toBe('public');
    const priv = templates.buildThemeEntry({
      slug: 'b',
      nameForm: 'english',
      visibility: 'private',
    });
    expect(priv.visibility).toBe('private');
    // Any non-'private' value (incl. junk) falls back to public.
    expect(templates.buildThemeEntry({ slug: 'c', visibility: 'weird' }).visibility).toBe('public');
  });

  it('writeTemplateFiles lands the SVGs + fonts on disk', () => {
    const root = makeScaffold();
    const out = templates.writeTemplateFiles({
      root,
      slug: 'demo',
      clean: { fronts: SVG('cf'), backs: SVG('cb'), board: SVG('cbo') },
      filled: { fronts: SVG('ff'), backs: SVG('fb'), board: SVG('fbo') },
      fonts: {
        title: { name: 'Title.ttf', data: Buffer.from('T') },
        word: { name: 'Word.ttf', data: Buffer.from('W') },
      },
    });
    const dir = out.dir;
    for (const role of ['fronts', 'backs', 'board']) {
      expect(fs.existsSync(path.join(dir, 'clean', role + '.svg'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'filled', role + '.svg'))).toBe(true);
    }
    expect(fs.existsSync(path.join(dir, 'fonts', 'Title.ttf'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'fonts', 'Word.ttf'))).toBe(true);
    expect(out.fonts).toEqual({ title: 'Title.ttf', word: 'Word.ttf' });
    // no chasers board was supplied -> the optional variant file is NOT created
    expect(fs.existsSync(path.join(dir, 'clean', 'board-chasers.svg'))).toBe(false);
  });

  it('writeTemplateFiles lands the optional chasers board variant when supplied', () => {
    const root = makeScaffold();
    const out = templates.writeTemplateFiles({
      root,
      slug: 'demo-ch',
      clean: { fronts: SVG('cf'), backs: SVG('cb'), board: SVG('cbo'), board_chasers: SVG('cch') },
      filled: { fronts: SVG('ff'), backs: SVG('fb'), board: SVG('fbo') },
      fonts: {
        title: { name: 'Title.ttf', data: Buffer.from('T') },
        word: { name: 'Word.ttf', data: Buffer.from('W') },
      },
    });
    // the normal board is untouched and the chasers variant lands next to it
    expect(fs.existsSync(path.join(out.dir, 'clean', 'board.svg'))).toBe(true);
    expect(fs.existsSync(path.join(out.dir, 'clean', 'board-chasers.svg'))).toBe(true);
  });

  it('appendThemeEntry adds the entry, keeps existing ones, and refuses to overwrite a key', () => {
    const root = makeScaffold();
    const themesPath = path.join(root, 'generator', 'themes.json');
    templates.appendThemeEntry(themesPath, 'demo', { slug: 'demo', calibrated: false });
    const themes = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
    expect(themes.demo.slug).toBe('demo');
    // the pre-existing (seeded) theme is preserved, not wiped
    expect(themes['seed-theme'].slug).toBe('seed-theme');
    expect(() => templates.appendThemeEntry(themesPath, 'demo', {})).toThrow(/already registered/);
    // atomic write leaves no leftover temp file behind
    const leftover = fs
      .readdirSync(path.join(root, 'generator'))
      .filter((f) => f.startsWith('.themes.') && f.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });

  it('loadThemes/appendThemeEntry THROW on a corrupt themes.json and never wipe it', () => {
    const root = makeScaffold();
    const themesPath = path.join(root, 'generator', 'themes.json');
    // a non-empty but unparseable file (e.g. a truncated write)
    const corrupt = '{ "seed-theme": { "slug": "seed-theme"';
    fs.writeFileSync(themesPath, corrupt, 'utf8');
    expect(() => templates.loadThemes(themesPath)).toThrow(/unparseable/);
    expect(() => templates.appendThemeEntry(themesPath, 'new-one', { slug: 'new-one' })).toThrow(
      /unparseable/
    );
    // the corrupt file is left exactly as-is — no partial overwrite
    expect(fs.readFileSync(themesPath, 'utf8')).toBe(corrupt);
  });

  it('appendThemeEntry refuses to write when the loaded mapping is empty', () => {
    const root = makeScaffold();
    const themesPath = path.join(root, 'generator', 'themes.json');
    fs.writeFileSync(themesPath, '{}\n', 'utf8');
    expect(() => templates.appendThemeEntry(themesPath, 'x', { slug: 'x' })).toThrow(/empty/);
    // the file is untouched (not overwritten with a lone entry)
    expect(JSON.parse(fs.readFileSync(themesPath, 'utf8'))).toEqual({});
  });

  it('onboardTemplate (runRecipe:false) writes files + a PUBLIC-by-default uncalibrated theme entry', () => {
    const root = makeScaffold();
    const r = templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: {
        slug: 'party-x',
        display_he: 'דוגרי מסיבה',
        title_text: "{NAME}'S PARTY",
        name_form: 'english-caps',
        extra_fields: 'AGE',
      },
      files: validFiles(),
    });
    expect(r.error).toBeUndefined();
    expect(r.key).toBe('party-x');
    expect(r.calibrated).toBe(false);
    expect(r.visibility).toBe('public'); // uploads are public by default now
    expect(r.recipe).toBe('skipped');

    const themes = JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8'));
    expect(themes['party-x'].visibility).toBe('public');
    expect(themes['party-x'].calibrated).toBe(false);
    expect(themes['party-x'].name_form).toBe('english-caps');
    expect(themes['party-x'].extra_fields).toEqual(['AGE']);
    expect(themes['party-x'].title_font).toBe('Title.ttf');
    expect(themes['party-x'].word_font).toBe('Word.ttf');

    const dir = path.join(root, 'resources', 'canva', 'templates', 'party-x');
    expect(fs.existsSync(path.join(dir, 'clean', 'fronts.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'filled', 'board.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'fonts', 'Title.ttf'))).toBe(true);
    // no chasers board was uploaded -> the optional variant is absent (additive)
    expect(fs.existsSync(path.join(dir, 'clean', 'board-chasers.svg'))).toBe(false);
  });

  // Auto-calibration on upload. generator/calibrate.py measures the title's slot
  // and paints from the artwork; before this was wired it existed as a CLI that
  // nothing called, so every freshly uploaded template opened its calibration
  // panel completely empty and the owner typed every number by hand.
  describe('onboardTemplate runs auto-calibration', () => {
    const ok = () => ({ status: 0, stdout: '', stderr: '' });
    // Stand-in for calibrate.py: writes the --out blob and exits 0.
    const fakeCalibrate = (blob) => (_bin, args) => {
      fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(blob), 'utf8');
      return ok();
    };
    const MEASURED = {
      title_style: {
        fill: '#97d8e6',
        outline: '#0d3e43',
        outline_w: 0.05,
        arch: 0.1,
        shadow: true,
      },
      board: {
        frac: { x0: 0.02, y0: 0.88, x1: 0.14, y1: 0.98 },
        fill: '#ffffff',
        outline: '#000000',
      },
      back: null,
      word_size: 12,
      confidence: { 'title_style.fill': 'high', 'board.frac': 'low' },
      notes: ['לא ניתן היה למדוד עובי מתאר'],
    };
    const readEntry = (root, slug) =>
      JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8'))[slug];

    // recipe_diff.py writes generator/recipes/<slug>.json; this stands in for it.
    const recipeRunnerFor = (root) => (_bin, args) => {
      const dir = path.join(root, 'generator', 'recipes');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, args[args.length - 1] + '.json'), '{}', 'utf8');
      return ok();
    };

    const onboard = (root, opts) =>
      templates.onboardTemplate({
        root,
        recipeRunner: recipeRunnerFor(root),
        fields: { slug: 'cal-x', display_he: 'כיול', title_text: '{NAME}', name_form: 'hebrew' },
        files: validFiles(),
        ...opts,
      });

    it('stores what it measured, and leaves calibrated FALSE for a human', () => {
      const root = makeScaffold();
      const r = onboard(root, { calibrateRunner: fakeCalibrate(MEASURED) });
      expect(r.error).toBeUndefined();
      expect(r.calibration).toBe('measured');

      const entry = readEntry(root, 'cal-x');
      expect(entry.title_style.fill).toBe('#97d8e6');
      expect(entry.title_style.outline_w).toBe(0.05);
      expect(entry.board.frac.x0).toBe(0.02);
      expect(entry.word_size).toBe(12);
      // Advisory fields the form renders as "check this one".
      expect(entry.confidence['board.frac']).toBe('low');
      expect(entry.notes[0]).toContain('עובי מתאר');
      // Measuring is not approving: nothing is orderable until the owner saves.
      expect(entry.calibrated).toBe(false);
      expect(r.calibrated).toBe(false);
    });

    it('a template that cannot be measured is still registered, just unfilled', () => {
      const root = makeScaffold();
      const r = onboard(root, {
        calibrateRunner: () => ({ status: 1, stdout: '', stderr: 'no ink found' }),
      });
      expect(r.error).toBeUndefined();
      expect(r.key).toBe('cal-x');
      expect(r.calibration).toBe('failed');
      expect(r.calibration_detail).toContain('no ink');
      expect(readEntry(root, 'cal-x').title_style).toBeNull(); // shell default, untouched
    });

    it('a value the detector could not measure is left ABSENT, not written as null', () => {
      // calibrate.py omits what it cannot measure rather than guessing. Writing an
      // omitted `board` as null would read like a deliberate "this design has no
      // board title" and silently drop the name from the printed board.
      const root = makeScaffold();
      const withoutBoard = { ...MEASURED };
      delete withoutBoard.board;
      onboard(root, { calibrateRunner: fakeCalibrate(withoutBoard) });
      const entry = readEntry(root, 'cal-x');
      expect(entry.title_style.fill).toBe('#97d8e6'); // what WAS measured landed
      expect(entry.board).toBeNull(); // still the shell default, not overwritten
    });

    it('skips calibration when the recipe failed — the back slot needs its cells', () => {
      const root = makeScaffold();
      let called = false;
      const r = templates.onboardTemplate({
        root,
        recipeRunner: () => ({ status: 1, stdout: '', stderr: 'no grid' }),
        calibrateRunner: () => {
          called = true;
          return ok();
        },
        fields: { slug: 'cal-y', display_he: 'x', title_text: '{NAME}', name_form: 'hebrew' },
        files: validFiles(),
      });
      expect(r.recipe).toBe('failed');
      expect(called).toBe(false);
      expect(r.calibration).toBe('skipped');
      expect(r.error).toBeUndefined(); // still registered
    });
  });

  it('onboardTemplate accepts an OPTIONAL chasers board and lands clean/board-chasers.svg', () => {
    const root = makeScaffold();
    const files = {
      ...validFiles(),
      clean_board_chasers: { filename: 'bch.svg', data: SVG('bch') },
    };
    const r = templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: {
        slug: 'party-ch',
        display_he: 'צ׳ייסרים',
        title_text: "{NAME}'S PARTY",
        name_form: 'english-caps',
      },
      files,
    });
    expect(r.error).toBeUndefined();
    const dir = path.join(root, 'resources', 'canva', 'templates', 'party-ch');
    expect(fs.existsSync(path.join(dir, 'clean', 'board.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'clean', 'board-chasers.svg'))).toBe(true);
  });

  it('onboardTemplate rejects a chasers board that is not an SVG', () => {
    const root = makeScaffold();
    const files = {
      ...validFiles(),
      clean_board_chasers: { filename: 'bch.bin', data: Buffer.from('not-an-svg-at-all') },
    };
    const r = templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: { slug: 'party-badch', display_he: 'x', title_text: 'x', name_form: 'english' },
      files,
    });
    expect(r.error).toMatch(/chasers board does not look like an SVG/);
  });

  it('onboardTemplate rejects an unsafe slug, a duplicate, and missing files', () => {
    const root = makeScaffold();
    expect(
      templates.onboardTemplate({
        root,
        runRecipe: false,
        fields: { slug: 'Bad Slug' },
        files: validFiles(),
      }).error
    ).toMatch(/invalid slug/);

    // seed a theme then try to reuse the key
    templates.appendThemeEntry(path.join(root, 'generator', 'themes.json'), 'taken', {
      slug: 'taken',
    });
    const dup = templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: { slug: 'taken', display_he: 'x', title_text: 'x', name_form: 'english' },
      files: validFiles(),
    });
    expect(dup.error).toMatch(/already exists/);

    const missing = validFiles();
    delete missing.clean_board;
    const miss = templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: { slug: 'nofile', display_he: 'x', title_text: 'x', name_form: 'english' },
      files: missing,
    });
    expect(miss.error).toMatch(/missing clean board/);
  });

  it('runRecipeDiff reports ok when the runner writes the recipe json', () => {
    const root = makeScaffold();
    // pretend the template files already exist
    fs.mkdirSync(path.join(root, 'resources', 'canva', 'templates', 'rx', 'clean'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, 'resources', 'canva', 'templates', 'rx', 'filled'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, 'resources', 'canva', 'templates', 'rx', 'clean', 'fronts.svg'),
      SVG('c')
    );
    fs.writeFileSync(
      path.join(root, 'resources', 'canva', 'templates', 'rx', 'filled', 'fronts.svg'),
      SVG('f')
    );
    const runner = () => {
      fs.mkdirSync(path.join(root, 'generator', 'recipes'), { recursive: true });
      fs.writeFileSync(path.join(root, 'generator', 'recipes', 'rx.json'), '{"cards":[]}');
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    const res = templates.runRecipeDiff({ root, slug: 'rx', runner });
    expect(res.ok).toBe(true);
  });

  it('parseMultipart round-trips fields + files from a raw body', () => {
    const boundary = 'X-BOUND-123';
    const body = buildMultipart(boundary, [
      { name: 'slug', value: 'demo' },
      { name: 'title_font', filename: 'T.ttf', data: Buffer.from('FONTBYTES') },
    ]);
    const { fields, files } = templates.parseMultipart(body, boundary);
    expect(fields.slug).toBe('demo');
    expect(files.title_font.filename).toBe('T.ttf');
    expect(files.title_font.data.toString()).toBe('FONTBYTES');
  });
});

describe('templates.js full editing (status / rename / replace)', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR; // no owner store: image paths only, as before
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  // Onboard one template into a fresh scaffold so status/rename/replace have a
  // real on-disk template to act on.
  function onboard(root, slug, extraFiles) {
    return templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: { slug, display_he: 'שם התחלתי', title_text: '{NAME}', name_form: 'hebrew' },
      files: { ...validFiles(), ...(extraFiles || {}) },
    });
  }

  it('computeTemplateStatus reports present/missing incl. the OPTIONAL chasers board', () => {
    const root = makeScaffold();
    onboard(root, 'stat-x');
    const themes = templates.loadThemes(templates.themesPathFor(root));
    const st = templates.computeTemplateStatus(root, 'stat-x', themes['stat-x']);
    const by = Object.fromEntries(st.assets.map((a) => [a.role, a]));
    expect(by['clean-fronts'].present).toBe(true);
    expect(by['filled-board'].present).toBe(true);
    expect(by['title-font'].present).toBe(true);
    expect(by['word-font'].present).toBe(true);
    // no chasers board was uploaded -> missing + optional + flagged off
    expect(by['clean-board-chasers'].present).toBe(false);
    expect(by['clean-board-chasers'].optional).toBe(true);
    expect(st.chasersBoard).toBe(false);
    // an OPTIONAL asset missing does not make the template incomplete
    expect(st.complete).toBe(true);
    // A fresh template has no auto-calibration hints.
    expect(st.confidence).toBeNull();
    expect(st.notes).toBeNull();
  });

  it('computeTemplateStatus passes through auto-calibration confidence + notes when present', () => {
    const root = makeScaffold();
    onboard(root, 'stat-conf');
    const themes = templates.loadThemes(templates.themesPathFor(root));
    // Auto-calibration attaches measurement hints to the entry (never validated
    // or persisted by the save path — pure pass-through for the form).
    themes['stat-conf'].confidence = { 'title_style.fill': 'high', 'board.frac': 'low' };
    themes['stat-conf'].notes = ['לא זוהתה תיבת שם על הלוח בביטחון'];
    const st = templates.computeTemplateStatus(root, 'stat-conf', themes['stat-conf']);
    expect(st.confidence).toEqual({ 'title_style.fill': 'high', 'board.frac': 'low' });
    expect(st.notes).toEqual(['לא זוהתה תיבת שם על הלוח בביטחון']);
    // Malformed hints degrade to null rather than leaking a bad shape.
    themes['stat-conf'].confidence = 'nope';
    themes['stat-conf'].notes = 'not-an-array';
    const st2 = templates.computeTemplateStatus(root, 'stat-conf', themes['stat-conf']);
    expect(st2.confidence).toBeNull();
    expect(st2.notes).toBeNull();
  });

  it('listTemplateStatuses flips chasersBoard true when the variant exists', () => {
    const root = makeScaffold();
    onboard(root, 'stat-ch', { clean_board_chasers: { filename: 'b.svg', data: SVG('ch') } });
    const st = templates.listTemplateStatuses(root).find((t) => t.key === 'stat-ch');
    expect(st.chasersBoard).toBe(true);
    expect(st.assets.find((a) => a.role === 'clean-board-chasers').present).toBe(true);
    // the seeded theme is also listed
    expect(templates.listTemplateStatuses(root).some((t) => t.key === 'seed-theme')).toBe(true);
  });

  it('renameTemplate updates display_he, persists, trims, and keeps slug/dir stable', () => {
    const root = makeScaffold();
    onboard(root, 'ren-x');
    const before = templates.loadThemes(templates.themesPathFor(root))['ren-x'];
    const r = templates.renameTemplate({ root, key: 'ren-x', displayName: '  שם חדש  ' });
    expect(r.error).toBeUndefined();
    expect(r.display_he).toBe('שם חדש'); // trimmed
    const after = templates.loadThemes(templates.themesPathFor(root))['ren-x'];
    expect(after.display_he).toBe('שם חדש');
    expect(after.slug).toBe(before.slug); // slug/identity untouched
    expect(after.dir).toBe(before.dir); // path untouched
    expect(r.slug).toBe(before.slug);
  });

  it('renameTemplate validates non-empty + length and unknown key', () => {
    const root = makeScaffold();
    onboard(root, 'ren-v');
    expect(templates.renameTemplate({ root, key: 'ren-v', displayName: '   ' }).error).toMatch(
      /required/
    );
    expect(
      templates.renameTemplate({ root, key: 'ren-v', displayName: 'x'.repeat(200) }).error
    ).toMatch(/too long/);
    const nf = templates.renameTemplate({ root, key: 'ghost', displayName: 'ok' });
    expect(nf.error).toMatch(/not found/);
    expect(nf.httpStatus).toBe(404);
  });

  it('updateTemplateSettings edits language/name_form/visibility/extra_fields, keeps identity', () => {
    const root = makeScaffold();
    onboard(root, 'set-x');
    const before = templates.loadThemes(templates.themesPathFor(root))['set-x'];
    const r = templates.updateTemplateSettings({
      root,
      key: 'set-x',
      patch: {
        language: 'english',
        name_form: 'english-caps',
        visibility: 'private',
        extra_fields: 'YEARS, NAME1  NAME2',
        display_he: '  שם מוגדר  ',
      },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings).toEqual({
      display_he: 'שם מוגדר',
      language: 'english',
      name_form: 'english-caps',
      visibility: 'private',
      extra_fields: ['YEARS', 'NAME1', 'NAME2'],
      // A settings-only patch leaves the calibration look-pass untouched (this
      // template is freshly onboarded → still uncalibrated).
      title_style: null,
      board: null,
      back: null,
      word_size: null,
      // Names no seed pool → the generic fallback (see the wordlist tests below).
      wordlist: null,
      calibrated: false,
      // Reported so the settings form can re-read the saved layout without a
      // refetch. This template is a legacy sheet, which has no front list at all.
      card_structure: 'sheet',
      card_fronts: null,
      // A legacy sheet has no card layout, so no per-front backs either.
      card_backs: [],
    });
    const after = templates.loadThemes(templates.themesPathFor(root))['set-x'];
    expect(after.visibility).toBe('private');
    expect(after.language).toBe('english');
    expect(after.extra_fields).toEqual(['YEARS', 'NAME1', 'NAME2']);
    expect(after.slug).toBe(before.slug); // identity untouched
    expect(after.dir).toBe(before.dir);
    expect(after.recipe).toBe(before.recipe);
  });

  // Which seed pool tops a template's orders up to a full deck. This used to be
  // fixed in the shipped themes.json — i.e. changeable only by a deploy — and the
  // wordlists screen surfaced it read-only. It is now a normal setting, which is
  // what puts it on the whole-entry copy-on-write path the generator reads.
  it('updateTemplateSettings re-points a template at another seed pool', () => {
    const root = makeScaffold();
    onboard(root, 'set-wl');
    const r = templates.updateTemplateSettings({
      root,
      key: 'set-wl',
      patch: { wordlist: 'friends-350.txt' },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings.wordlist).toBe('friends-350.txt');
    // Persisted on the entry — this is the byte the generator reads at topup.
    const after = templates.loadThemes(templates.themesPathFor(root))['set-wl'];
    expect(after.wordlist).toBe('friends-350.txt');
  });

  it('updateTemplateSettings clears the pool back to the generic default', () => {
    const root = makeScaffold();
    onboard(root, 'set-wl0');
    templates.updateTemplateSettings({
      root,
      key: 'set-wl0',
      patch: { wordlist: 'family-350.txt' },
    });
    const r = templates.updateTemplateSettings({ root, key: 'set-wl0', patch: { wordlist: null } });
    expect(r.error).toBeUndefined();
    expect(r.settings.wordlist).toBe(null);
    // The KEY is dropped rather than stored as null, so the entry reads like a
    // shipped theme that simply names no pool (topup: `wordlist or GENERIC`).
    const after = templates.loadThemes(templates.themesPathFor(root))['set-wl0'];
    expect('wordlist' in after).toBe(false);
  });

  it('updateTemplateSettings refuses a pool that does not exist', () => {
    const root = makeScaffold();
    onboard(root, 'set-wlx');
    // A typo here would NOT fail at generation time — topup treats a missing pool
    // as empty and quietly ships a shorter deck — so it has to be caught on write.
    for (const bad of ['nope-350.txt', '../../etc/passwd', 'sub/dir.txt', '   ']) {
      const r = templates.updateTemplateSettings({
        root,
        key: 'set-wlx',
        patch: { wordlist: bad },
      });
      expect(r.httpStatus).toBe(400);
      expect(r.error).toMatch(/unknown wordlist|no valid settings/);
    }
    const after = templates.loadThemes(templates.themesPathFor(root))['set-wlx'];
    expect('wordlist' in after).toBe(false); // nothing partially written
  });

  it('updateTemplateSettings rejects invalid values and unknown keys (no partial write)', () => {
    const root = makeScaffold();
    onboard(root, 'set-v');
    expect(
      templates.updateTemplateSettings({ root, key: 'set-v', patch: { language: 'klingon' } }).error
    ).toMatch(/language must be/);
    expect(
      templates.updateTemplateSettings({ root, key: 'set-v', patch: { visibility: 'secret' } })
        .error
    ).toMatch(/visibility must be/);
    expect(
      templates.updateTemplateSettings({ root, key: 'set-v', patch: { name_form: 'nope' } }).error
    ).toMatch(/name_form must be/);
    expect(templates.updateTemplateSettings({ root, key: 'set-v', patch: {} }).error).toMatch(
      /no valid settings/
    );
    const nf = templates.updateTemplateSettings({
      root,
      key: 'ghost',
      patch: { visibility: 'public' },
    });
    expect(nf.httpStatus).toBe(404);
    // A bad value did not partially mutate the entry.
    const after = templates.loadThemes(templates.themesPathFor(root))['set-v'];
    expect(after.visibility).toBe('public'); // still the onboarding default
  });

  // A full, valid calibration blob (mirrors the shipped "trip comeback" theme).
  const CAL = {
    title_style: {
      fill: '#97d8e6',
      outline: '#0d3e43',
      outline_w: 0.05,
      arch: 0.11,
      shadow: true,
      size: 23.9,
      board_size: 20,
      back_size: 18,
      align: 'center',
      italic: false,
    },
    board: {
      frac: { x0: 0.02, y0: 0.883, x1: 0.135, y1: 0.985 },
      fill: '#97d8e6',
      outline: '#0d3e43',
    },
    back: {
      frac: { x0: 0.227, y0: 0.333, x1: 0.738, y1: 0.544 },
      fill: '#fff7cd',
      outline: '#0c464c',
    },
    word_size: 12,
  };

  it('updateTemplateSettings writes the calibration look-pass and flips calibrated:true', () => {
    const root = makeScaffold();
    onboard(root, 'cal-set'); // onboarded → calibrated:false, title_style/board/back null
    const before = templates.loadThemes(templates.themesPathFor(root))['cal-set'];
    expect(before.calibrated).toBe(false);
    expect(before.title_style).toBeNull();

    const r = templates.updateTemplateSettings({
      root,
      key: 'cal-set',
      patch: { ...CAL, calibrated: true },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings.calibrated).toBe(true);
    expect(r.settings.title_style).toEqual(CAL.title_style);
    expect(r.settings.board).toEqual(CAL.board);
    expect(r.settings.back).toEqual(CAL.back);
    expect(r.settings.word_size).toBe(12);

    const after = templates.loadThemes(templates.themesPathFor(root))['cal-set'];
    expect(after.calibrated).toBe(true);
    expect(after.title_style).toEqual(CAL.title_style);
    expect(after.board).toEqual(CAL.board);
    expect(after.back).toEqual(CAL.back);
    expect(after.word_size).toBe(12);
    // Identity untouched.
    expect(after.slug).toBe(before.slug);
    expect(after.dir).toBe(before.dir);
  });

  it('updateTemplateSettings REFUSES calibrated:true without a title_style (guards the renderer)', () => {
    const root = makeScaffold();
    onboard(root, 'cal-guard');
    const r = templates.updateTemplateSettings({
      root,
      key: 'cal-guard',
      patch: { calibrated: true },
    });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toMatch(/without a title_style/);
    // Nothing was flipped.
    expect(templates.loadThemes(templates.themesPathFor(root))['cal-guard'].calibrated).toBe(false);
  });

  it('updateTemplateSettings rejects malformed calibration values (no partial write)', () => {
    const root = makeScaffold();
    onboard(root, 'cal-bad');
    const bad = [
      { patch: { title_style: { ...CAL.title_style, fill: 'red' } }, re: /fill must be a hex/ },
      { patch: { title_style: { ...CAL.title_style, outline_w: 2 } }, re: /outline_w must be/ },
      { patch: { title_style: { ...CAL.title_style, align: 'top' } }, re: /align must be/ },
      {
        patch: {
          board: { frac: { x0: 0.9, y0: 0, x1: 0.1, y1: 1 }, fill: '#fff', outline: '#000' },
        },
        re: /x0 must be < x1/,
      },
      {
        patch: { back: { frac: { x0: 0, y0: 0, x1: 1, y1: 1 }, fill: 'nope', outline: '#000' } },
        re: /back.fill must be a hex/,
      },
      { patch: { word_size: -3 }, re: /word_size must be/ },
    ];
    for (const c of bad) {
      const r = templates.updateTemplateSettings({ root, key: 'cal-bad', patch: c.patch });
      expect(r.httpStatus).toBe(400);
      expect(r.error).toMatch(c.re);
    }
    // Still uncalibrated, no title_style leaked in.
    const after = templates.loadThemes(templates.themesPathFor(root))['cal-bad'];
    expect(after.calibrated).toBe(false);
    expect(after.title_style).toBeNull();
  });

  it('updateTemplateSettings accepts board/back = null (no honoree name on that surface) + drops word_size:null', () => {
    const root = makeScaffold();
    onboard(root, 'cal-null');
    const r = templates.updateTemplateSettings({
      root,
      key: 'cal-null',
      patch: {
        title_style: CAL.title_style,
        board: null,
        back: null,
        word_size: null,
        calibrated: true,
      },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings.board).toBeNull();
    expect(r.settings.back).toBeNull();
    expect(r.settings.word_size).toBeNull();
    const after = templates.loadThemes(templates.themesPathFor(root))['cal-null'];
    expect(after.calibrated).toBe(true);
    expect(after.board).toBeNull();
    expect('word_size' in after).toBe(false); // null dropped, matches shipped themes
  });

  it('validateCalibration accepts a full blob and rejects a missing title_style', () => {
    expect(templates.validateCalibration(CAL).value).toMatchObject({
      title_style: CAL.title_style,
      board: CAL.board,
      back: CAL.back,
      word_size: 12,
    });
    expect(templates.validateCalibration({ board: CAL.board }).error).toMatch(/title_style/);
    // Optional slots may be null; title_style alone is enough to preview.
    const min = templates.validateCalibration({ title_style: CAL.title_style });
    expect(min.error).toBeUndefined();
    expect(min.value.board).toBeNull();
    expect(min.value.word_size).toBeNull();
    // A shared-back template posts no `backs` at all, and must not grow one.
    expect(min.value.backs).toBeNull();
  });

  // A deck whose eight styles each have their OWN back (#315) calibrates each of
  // them: they are separate artwork, so the honoree's name may sit somewhere else
  // on each — or on none — and one shared answer misplaces it on seven in eight.
  it('validateCalibration takes a per-back map, keeps an explicit null, and pins a per-back size', () => {
    const v = templates.validateCalibration({
      title_style: CAL.title_style,
      backs: { 10: { ...CAL.back, size: 17 }, 11: null },
    });
    expect(v.error).toBeUndefined();
    expect(v.value.backs['10']).toMatchObject({ ...CAL.back, size: 17 });
    // null is an ANSWER ("this back carries no title"), so it has to survive the
    // round-trip — dropping the key would read as "nobody has measured it yet"
    // and fall back to the shared `back` the old artwork was measured against.
    expect('11' in v.value.backs).toBe(true);
    expect(v.value.backs['11']).toBeNull();
  });

  it('validateCalibration rejects a malformed per-back map', () => {
    const withBacks = (backs) =>
      templates.validateCalibration({ title_style: CAL.title_style, backs });
    expect(withBacks({ front: CAL.back }).error).toMatch(/card number/);
    expect(withBacks({ 10: { ...CAL.back, fill: 'nope' } }).error).toMatch(/backs\.10\.fill/);
    expect(withBacks({ 10: { ...CAL.back, size: -3 } }).error).toMatch(/backs\.10\.size/);
    expect(
      withBacks({ 10: { ...CAL.back, frac: { x0: 0.9, y0: 0.1, x1: 0.2, y1: 0.5 } } }).error
    ).toMatch(/backs\.10\.frac/);
    expect(withBacks([CAL.back]).error).toMatch(/backs must be an object/);
  });

  it('deleteTemplate removes the entry + files, refuses an in-use theme + the last theme', () => {
    const root = makeScaffold();
    onboard(root, 'del-x');
    const dir = path.join(root, 'resources', 'canva', 'templates', 'del-x');
    fs.mkdirSync(path.join(root, 'generator', 'recipes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'generator', 'recipes', 'del-x.json'), '{}');
    expect(fs.existsSync(dir)).toBe(true);

    // In-use guard: a theme a live design maps to is refused (409).
    const guarded = templates.deleteTemplate({
      root,
      key: 'del-x',
      inUseThemes: new Set(['del-x']),
    });
    expect(guarded.httpStatus).toBe(409);
    expect(fs.existsSync(dir)).toBe(true); // nothing removed

    // Not in use → deleted: entry gone, dir + recipe removed.
    const ok = templates.deleteTemplate({
      root,
      key: 'del-x',
      inUseThemes: new Set(['bachelorette']),
    });
    expect(ok.ok).toBe(true);
    expect(templates.loadThemes(templates.themesPathFor(root))['del-x']).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(root, 'generator', 'recipes', 'del-x.json'))).toBe(false);
    // seed-theme survives.
    expect(templates.loadThemes(templates.themesPathFor(root))['seed-theme']).toBeDefined();

    // Unknown key → 404.
    expect(templates.deleteTemplate({ root, key: 'ghost' }).httpStatus).toBe(404);
    // Refuses to empty themes.json (only seed-theme left).
    expect(templates.deleteTemplate({ root, key: 'seed-theme' }).httpStatus).toBe(409);
  });

  it('replaceAsset writes the right SVG path, validates SVG, leaves other assets intact', () => {
    const root = makeScaffold();
    onboard(root, 'rep-x');
    const dir = path.join(root, 'resources', 'canva', 'templates', 'rep-x');
    const r = templates.replaceAsset({
      root,
      key: 'rep-x',
      role: 'clean-fronts',
      file: { filename: 'new.svg', data: SVG('REPLACED') },
    });
    expect(r.error).toBeUndefined();
    expect(r.path).toBe(
      path.join('resources', 'canva', 'templates', 'rep-x', 'clean', 'fronts.svg')
    );
    expect(fs.readFileSync(path.join(dir, 'clean', 'fronts.svg'), 'utf8')).toContain('REPLACED');
    // the other onboarded assets are untouched
    expect(fs.existsSync(path.join(dir, 'filled', 'board.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'fonts', 'Title.ttf'))).toBe(true);
    // reject a non-SVG payload for an SVG role
    const bad = templates.replaceAsset({
      root,
      key: 'rep-x',
      role: 'clean-board',
      file: { filename: 'x.bin', data: Buffer.from('not an svg at all') },
    });
    expect(bad.error).toMatch(/does not look like an SVG/);
  });

  it('createTemplateShell registers metadata + an EMPTY dir (no files, public, uncalibrated)', () => {
    const root = makeScaffold();
    const r = templates.createTemplateShell({
      root,
      fields: {
        slug: 'shell-x',
        display_he: 'תבנית ריקה',
        title_text: '{NAME}',
        name_form: 'english',
        extra_fields: 'AGE',
        visibility: 'private',
      },
    });
    expect(r.error).toBeUndefined();
    expect(r.shell).toBe(true);
    expect(r.key).toBe('shell-x');
    expect(r.visibility).toBe('private');
    // themes.json gained the entry; NO fonts recorded yet; uncalibrated.
    const themes = templates.loadThemes(templates.themesPathFor(root));
    expect(themes['shell-x'].calibrated).toBe(false);
    expect(themes['shell-x'].title_font).toBeUndefined();
    expect(themes['shell-x'].extra_fields).toEqual(['AGE']);
    // the dir exists with empty clean/filled/fonts subdirs and NO asset files.
    const dir = path.join(root, 'resources', 'canva', 'templates', 'shell-x');
    expect(fs.existsSync(path.join(dir, 'clean'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'clean', 'fronts.svg'))).toBe(false);
    // The shell shows in the status list with every required asset MISSING.
    const st = templates.listTemplateStatuses(root).find((t) => t.key === 'shell-x');
    expect(st.complete).toBe(false);
    expect(st.assets.find((a) => a.role === 'clean-fronts').present).toBe(false);

    // Bad metadata is rejected; a dup slug is refused.
    expect(templates.createTemplateShell({ root, fields: { slug: 'BAD SLUG' } }).error).toMatch(
      /slug/
    );
    expect(
      templates.createTemplateShell({
        root,
        fields: { slug: 'shell-x', display_he: 'x', title_text: '{NAME}', name_form: 'english' },
      }).httpStatus
    ).toBe(400);
  });

  it('replacing a font keeps the name of the file the owner uploaded', () => {
    // The old behaviour wrote over whatever filename was already on record and
    // threw the uploaded name away, so the owner's file "disappeared" into the
    // previous one.
    const root = makeScaffold();
    onboard(root, 'ren-x'); // ships title_font Title.ttf, word_font Word.ttf
    const dir = path.join(root, 'resources', 'canva', 'templates', 'ren-x');

    const r = templates.replaceAsset({
      root,
      key: 'ren-x',
      role: 'title-font',
      file: { filename: 'Santorini-Display.otf', data: FONT('NEWTITLE') },
    });
    expect(r.error).toBeUndefined();

    const themes = templates.loadThemes(templates.themesPathFor(root));
    expect(themes['ren-x'].title_font).toBe('Santorini-Display.otf');
    expect(fs.readFileSync(path.join(dir, 'fonts', 'Santorini-Display.otf')).toString()).toContain(
      'NEWTITLE'
    );
    // ...and the OTHER role is untouched by a title-font upload.
    expect(themes['ren-x'].word_font).toBe('Word.ttf');
    expect(fs.readFileSync(path.join(dir, 'fonts', 'Word.ttf')).toString()).toBe('WORDFONT');
  });

  it('two roles sharing ONE font file can be pulled apart by uploading two files', () => {
    // The anniversary/סנטוריני shape: title_font and word_font both naming the
    // same file. Uploading a distinct font to each role used to write both onto
    // that one shared file, so the last upload silently became the font for BOTH
    // surfaces and the title/word fonts could never differ.
    const root = makeScaffold();
    onboard(root, 'share-x', {
      title_font: { filename: 'Shared.ttf', data: Buffer.from('SHARED') },
      word_font: { filename: 'Shared.ttf', data: Buffer.from('SHARED') },
    });
    const dir = path.join(root, 'resources', 'canva', 'templates', 'share-x');
    const before = templates.loadThemes(templates.themesPathFor(root));
    expect(before['share-x'].title_font).toBe(before['share-x'].word_font); // the trap

    templates.replaceAsset({
      root,
      key: 'share-x',
      role: 'title-font',
      file: { filename: 'TitleOnly.otf', data: FONT('TITLEONLY') },
    });
    templates.replaceAsset({
      root,
      key: 'share-x',
      role: 'word-font',
      file: { filename: 'WordOnly.otf', data: FONT('WORDONLY') },
    });

    const themes = templates.loadThemes(templates.themesPathFor(root));
    expect(themes['share-x'].title_font).toBe('TitleOnly.otf');
    expect(themes['share-x'].word_font).toBe('WordOnly.otf');
    expect(themes['share-x'].title_font).not.toBe(themes['share-x'].word_font);
    // Two files, each holding its OWN bytes — neither overwrote the other.
    expect(fs.readFileSync(path.join(dir, 'fonts', 'TitleOnly.otf')).toString()).toContain(
      'TITLEONLY'
    );
    expect(fs.readFileSync(path.join(dir, 'fonts', 'WordOnly.otf')).toString()).toContain(
      'WORDONLY'
    );
  });

  it('re-uploading a font under the SAME name just replaces its bytes', () => {
    // No rename, nothing new to record — the plain "I fixed the font file" case
    // must keep working exactly as before.
    const root = makeScaffold();
    onboard(root, 'same-x');
    const dir = path.join(root, 'resources', 'canva', 'templates', 'same-x');
    const r = templates.replaceAsset({
      root,
      key: 'same-x',
      role: 'word-font',
      file: { filename: 'Word.ttf', data: FONT('REVISED') },
    });
    expect(r.error).toBeUndefined();
    const themes = templates.loadThemes(templates.themesPathFor(root));
    expect(themes['same-x'].word_font).toBe('Word.ttf');
    expect(fs.readFileSync(path.join(dir, 'fonts', 'Word.ttf')).toString()).toContain('REVISED');
  });

  it('a font upload with no usable filename still lands on the recorded one', () => {
    // A browser that sends no filename must not break re-uploading an existing
    // font — there is a recorded path to fall back on.
    const root = makeScaffold();
    onboard(root, 'noname-x');
    const dir = path.join(root, 'resources', 'canva', 'templates', 'noname-x');
    const r = templates.replaceAsset({
      root,
      key: 'noname-x',
      role: 'title-font',
      file: { filename: '', data: FONT('FALLBACK') },
    });
    expect(r.error).toBeUndefined();
    const themes = templates.loadThemes(templates.themesPathFor(root));
    expect(themes['noname-x'].title_font).toBe('Title.ttf');
    expect(fs.readFileSync(path.join(dir, 'fonts', 'Title.ttf')).toString()).toContain('FALLBACK');
  });

  it('a shell + per-asset uploads builds a complete template (records the font too)', () => {
    const root = makeScaffold();
    templates.createTemplateShell({
      root,
      fields: { slug: 'shell-y', display_he: 'y', title_text: '{NAME}', name_form: 'english' },
    });
    // Upload each required SVG + both fonts separately.
    for (const role of [
      'clean-fronts',
      'clean-backs',
      'clean-board',
      'filled-fronts',
      'filled-backs',
      'filled-board',
    ]) {
      const r = templates.replaceAsset({
        root,
        key: 'shell-y',
        role,
        file: { filename: 'x.svg', data: SVG(role) },
      });
      expect(r.error).toBeUndefined();
    }
    const tf = templates.replaceAsset({
      root,
      key: 'shell-y',
      role: 'title-font',
      file: { filename: 'MyTitle.ttf', data: FONT('T') },
    });
    expect(tf.error).toBeUndefined();
    templates.replaceAsset({
      root,
      key: 'shell-y',
      role: 'word-font',
      file: { filename: 'MyWord.ttf', data: FONT('W') },
    });
    // The font filename is now recorded in themes.json so the generator can find it.
    const themes = templates.loadThemes(templates.themesPathFor(root));
    expect(themes['shell-y'].title_font).toBe('MyTitle.ttf');
    expect(themes['shell-y'].word_font).toBe('MyWord.ttf');
    // The template is now complete (all required assets present).
    const st = templates.listTemplateStatuses(root).find((t) => t.key === 'shell-y');
    expect(st.complete).toBe(true);
  });

  it('replaceAsset SHRINKS an oversized embedded-image SVG (best-effort, injected runner)', () => {
    const root = makeScaffold();
    onboard(root, 'shr-x');
    const dir = path.join(root, 'resources', 'canva', 'templates', 'shr-x');
    // A >300KB SVG carrying a data:image — big enough to trip the shrink threshold.
    const heavy = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,' +
        'A'.repeat(400 * 1024) +
        '"/></svg>'
    );
    // Inject a fake shrinker that returns a much smaller still-SVG buffer.
    const small = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">shrunk</svg>');
    const runner = () => ({ status: 0, stdout: small });
    const r = templates.replaceAsset({
      root,
      key: 'shr-x',
      role: 'clean-fronts',
      file: { filename: 'big.svg', data: heavy },
      shrinkRunner: runner,
    });
    expect(r.error).toBeUndefined();
    const written = fs.readFileSync(path.join(dir, 'clean', 'fronts.svg'));
    expect(written.length).toBeLessThan(heavy.length); // the shrunk buffer landed
    expect(written.toString()).toContain('shrunk');
    // shrinkImages:false writes the original bytes unchanged.
    const r2 = templates.replaceAsset({
      root,
      key: 'shr-x',
      role: 'clean-backs',
      file: { filename: 'big.svg', data: heavy },
      shrinkImages: false,
    });
    expect(r2.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'clean', 'backs.svg')).length).toBe(heavy.length);
  });

  it('replaceAsset ADDS the optional chasers board where none existed', () => {
    const root = makeScaffold();
    onboard(root, 'rep-ch');
    const dir = path.join(root, 'resources', 'canva', 'templates', 'rep-ch');
    expect(fs.existsSync(path.join(dir, 'clean', 'board-chasers.svg'))).toBe(false);
    const r = templates.replaceAsset({
      root,
      key: 'rep-ch',
      role: 'clean-board-chasers',
      file: { filename: 'c.svg', data: SVG('CHASERS') },
    });
    expect(r.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'clean', 'board-chasers.svg'), 'utf8')).toContain(
      'CHASERS'
    );
  });

  it('replaceAsset accepts a font by sfnt magic and lands it under its own name', () => {
    // The file is validated by CONTENT (sfnt magic), not by extension. It is
    // written under the name it was uploaded with, and themes.json is updated to
    // point at it — the generator reads the recorded name, so the two must move
    // together or the upload writes a file nobody reads.
    const root = makeScaffold();
    onboard(root, 'rep-f');
    const dir = path.join(root, 'resources', 'canva', 'templates', 'rep-f');
    const good = FONT('NEWTITLEFONT');
    const r = templates.replaceAsset({
      root,
      key: 'rep-f',
      role: 'title-font',
      file: { filename: 'New.ttf', data: good },
    });
    expect(r.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'fonts', 'New.ttf')).equals(good)).toBe(true);
    const themes = templates.loadThemes(templates.themesPathFor(root));
    expect(themes['rep-f'].title_font).toBe('New.ttf');
  });

  it('replaceAsset rejects a non-font uploaded as .ttf and leaves the old font intact', () => {
    const root = makeScaffold();
    onboard(root, 'rep-junk');
    const dir = path.join(root, 'resources', 'canva', 'templates', 'rep-junk');
    const before = fs.readFileSync(path.join(dir, 'fonts', 'Title.ttf'));
    // Junk bytes with a trusted-looking .ttf name — validation is by CONTENT
    // (sfnt magic), not the filename, so this must be rejected...
    const bad = templates.replaceAsset({
      root,
      key: 'rep-junk',
      role: 'title-font',
      file: { filename: 'Title.ttf', data: Buffer.from('not a real font at all') },
    });
    expect(bad.error).toMatch(/does not look like a font/);
    expect(bad.httpStatus).toBe(400);
    // ...and the real font the generator reads is untouched (no partial overwrite).
    expect(fs.readFileSync(path.join(dir, 'fonts', 'Title.ttf')).equals(before)).toBe(true);
  });

  it('rename/replace reject prototype-polluting keys without mutating Object.prototype', () => {
    const root = makeScaffold();
    onboard(root, 'rep-proto');
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const rn = templates.renameTemplate({ root, key, displayName: 'pwn' });
      expect(rn.error).toMatch(/not found/);
      expect(rn.httpStatus).toBe(404);
      const rp = templates.replaceAsset({
        root,
        key,
        role: 'clean-fronts',
        file: { filename: 'x.svg', data: SVG('x') },
      });
      expect(rp.error).toMatch(/not found/);
      expect(rp.httpStatus).toBe(404);
    }
    // Object.prototype was never polluted by any of the above.
    expect({}.display_he).toBeUndefined();
    expect({}.slug).toBeUndefined();
    // the real template is still renamable normally
    expect(
      templates.renameTemplate({ root, key: 'rep-proto', displayName: 'ok' }).error
    ).toBeUndefined();
  });

  it('replaceAsset on a CALIBRATED template requires force to replace an SVG role', () => {
    const root = makeScaffold();
    onboard(root, 'cal-x');
    const themesPath = templates.themesPathFor(root);
    const dir = path.join(root, 'resources', 'canva', 'templates', 'cal-x');
    // Flip the (freshly onboarded, uncalibrated) template to calibrated.
    const themes = templates.loadThemes(themesPath);
    themes['cal-x'].calibrated = true;
    templates.writeThemesFile(themesPath, themes);
    const before = fs.readFileSync(path.join(dir, 'clean', 'fronts.svg'), 'utf8');

    // No force -> blocked (409, calibrationWarning) and the file is NOT overwritten.
    const blocked = templates.replaceAsset({
      root,
      key: 'cal-x',
      role: 'clean-fronts',
      file: { filename: 'n.svg', data: SVG('NEW-ART') },
    });
    expect(blocked.httpStatus).toBe(409);
    expect(blocked.calibrationWarning).toBe(true);
    expect(blocked.error).toMatch(/calibrated/i);
    expect(fs.readFileSync(path.join(dir, 'clean', 'fronts.svg'), 'utf8')).toBe(before);

    // With force -> the swap goes through.
    const forced = templates.replaceAsset({
      root,
      key: 'cal-x',
      role: 'clean-fronts',
      file: { filename: 'n.svg', data: SVG('NEW-ART') },
      force: true,
    });
    expect(forced.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'clean', 'fronts.svg'), 'utf8')).toContain('NEW-ART');

    // A FONT role on the same calibrated template does NOT require force (no
    // geometry to protect).
    const font = templates.replaceAsset({
      root,
      key: 'cal-x',
      role: 'title-font',
      file: { filename: 'F.ttf', data: FONT('CAL-FONT') },
    });
    expect(font.error).toBeUndefined();
  });

  it('replaceAsset ADDS a new SVG asset on a CALIBRATED template without force (nothing to replace)', () => {
    const root = makeScaffold();
    onboard(root, 'cal-add');
    const themesPath = templates.themesPathFor(root);
    const themes = templates.loadThemes(themesPath);
    themes['cal-add'].calibrated = true;
    templates.writeThemesFile(themesPath, themes);
    const chasers = path.join(
      root,
      'resources',
      'canva',
      'templates',
      'cal-add',
      'clean',
      'board-chasers.svg'
    );
    expect(fs.existsSync(chasers)).toBe(false); // no current art at this role

    // First-time add of the optional chasers board is NOT replacing existing art,
    // so it must write directly even though the template is calibrated — no 409.
    const r = templates.replaceAsset({
      root,
      key: 'cal-add',
      role: 'clean-board-chasers',
      file: { filename: 'bc.svg', data: SVG('CHASERS-ADD') },
    });
    expect(r.error).toBeUndefined();
    expect(r.calibrationWarning).toBeUndefined();
    expect(fs.readFileSync(chasers, 'utf8')).toContain('CHASERS-ADD');
  });

  it('replaceAsset on a NON-calibrated template replaces an SVG role freely (no force)', () => {
    const root = makeScaffold();
    onboard(root, 'uncal-x'); // onboarded templates are calibrated:false
    const dir = path.join(root, 'resources', 'canva', 'templates', 'uncal-x');
    const r = templates.replaceAsset({
      root,
      key: 'uncal-x',
      role: 'clean-fronts',
      file: { filename: 'n.svg', data: SVG('FREE-SWAP') },
    });
    expect(r.error).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'clean', 'fronts.svg'), 'utf8')).toContain('FREE-SWAP');
  });

  it('replaceAsset rejects unknown / traversing role names (whitelist)', () => {
    const root = makeScaffold();
    onboard(root, 'rep-w');
    for (const role of ['../../etc/passwd', 'clean/../../x', 'bogus', '..', 'clean-fronts.svg']) {
      const r = templates.replaceAsset({
        root,
        key: 'rep-w',
        role,
        file: { filename: 'x.svg', data: SVG('x') },
      });
      expect(r.error).toMatch(/unknown asset role/);
      expect(r.httpStatus).toBe(400);
    }
    // the real front SVG was never overwritten by any traversal attempt
    const dir = path.join(root, 'resources', 'canva', 'templates', 'rep-w');
    expect(fs.readFileSync(path.join(dir, 'clean', 'fronts.svg'), 'utf8')).toContain(
      'clean-fronts'
    );
  });

  it('replaceAsset rejects an unknown template key and an empty upload', () => {
    const root = makeScaffold();
    onboard(root, 'rep-e');
    const ghost = templates.replaceAsset({
      root,
      key: 'ghost',
      role: 'clean-fronts',
      file: { filename: 'x.svg', data: SVG('x') },
    });
    expect(ghost.error).toMatch(/not found/);
    expect(ghost.httpStatus).toBe(404);
    const empty = templates.replaceAsset({
      root,
      key: 'rep-e',
      role: 'clean-fronts',
      file: { filename: 'x.svg', data: Buffer.alloc(0) },
    });
    expect(empty.error).toMatch(/no file/);
    expect(empty.httpStatus).toBe(400);
  });
});

// -- multipart body builder + endpoint test -----------------------------------

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
        )
      );
      chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data)));
      chunks.push(Buffer.from('\r\n'));
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

function onboardParts() {
  const f = validFiles();
  return [
    { name: 'slug', value: 'endpoint-demo' },
    { name: 'display_he', value: 'דוגרי אנדפוינט' },
    { name: 'title_text', value: "{NAME}'S B-DAY" },
    { name: 'name_form', value: 'english' },
    { name: 'extra_fields', value: 'AGE' },
    ...Object.entries(f).map(([name, file]) => ({
      name,
      filename: file.filename,
      data: file.data,
    })),
  ];
}

// This suite boots the REAL app with a DATA_DIR, i.e. the production shape: the
// image tree (TEMPLATE_ROOT) is the read-only base and every write lands in the
// persistent owner store at DATA_DIR/templates. Assertions therefore look at the
// store, not at the scaffold — templates-store.test.js proves the image tree
// stays untouched.
describe('POST /api/admin/templates', () => {
  let app;
  let server;
  let base;
  let root;

  // The owner store the routes write to (see server/template-store.js).
  const storeDir = () => path.join(process.env.DATA_DIR, 'templates');
  const ownerThemes = () =>
    JSON.parse(fs.readFileSync(path.join(storeDir(), 'themes.json'), 'utf8'));

  beforeAll(async () => {
    root = makeScaffold();
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-data-'));
    process.env.GENERATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-gen-'));
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.TEMPLATE_ROOT = root;

    // FAKE python: write generator/recipes/<slug>.json next to the script arg.
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-py-'));
    const fake = path.join(fakeDir, 'fake-recipe.sh');
    fs.writeFileSync(
      fake,
      [
        '#!/bin/sh',
        '# $1=script $2=filled $3=clean $4=slug',
        'd=$(dirname "$1")',
        'mkdir -p "$d/recipes"',
        'printf \'{"theme":"%s","cards":[]}\' "$4" > "$d/recipes/$4.json"',
        'echo "wrote recipe for $4"',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.PYTHON = fake;

    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'templates.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) server.close();
  });

  async function upload(parts, { withKey = true } = {}) {
    const boundary = '----dugriTest' + Math.random().toString(16).slice(2);
    const body = buildMultipart(boundary, parts);
    const url = base + '/api/admin/templates' + (withKey ? '?key=' + ADMIN_KEY : '');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('403 without the admin key', async () => {
    const r = await upload(onboardParts(), { withKey: false });
    expect(r.status).toBe(403);
  });

  it('onboards a new private template: files land, recipe produced, themes.json gains an uncalibrated entry', async () => {
    const r = await upload(onboardParts());
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.key).toBe('endpoint-demo');
    expect(r.body.calibrated).toBe(false);
    expect(r.body.visibility).toBe('public');
    expect(r.body.recipe).toBe('generated');
    expect(r.body.note).toMatch(/calibrat/i);

    // files landed in the PERSISTENT owner store, not in the (ephemeral) image tree
    const dir = path.join(storeDir(), 'endpoint-demo');
    expect(fs.existsSync(path.join(dir, 'clean', 'fronts.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'filled', 'backs.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'fonts', 'Title.ttf'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'fonts', 'Word.ttf'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'resources', 'canva', 'templates', 'endpoint-demo'))).toBe(
      false
    );

    // The recipe was produced. This fake python writes next to the script (the
    // image layer); the real generator half writes into the owner store. The
    // resolver accepts EITHER, which is what makes recipe:'generated' true here.
    expect(fs.existsSync(path.join(root, 'generator', 'recipes', 'endpoint-demo.json'))).toBe(true);

    // the owner themes.json gained a public, uncalibrated entry; the image's
    // themes.json is untouched
    const themes = ownerThemes();
    expect(themes['endpoint-demo'].visibility).toBe('public');
    expect(themes['endpoint-demo'].calibrated).toBe(false);
    expect(themes['endpoint-demo'].title_style).toBeNull();
    expect(themes['endpoint-demo'].extra_fields).toEqual(['AGE']);
    const shipped = JSON.parse(
      fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8')
    );
    expect(shipped['endpoint-demo']).toBeUndefined();
  });

  it('409/400-style rejects a duplicate slug', async () => {
    const r = await upload(onboardParts());
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/already exists/);
  });

  it('400 on an invalid slug', async () => {
    const parts = onboardParts().map((p) =>
      p.name === 'slug' ? { name: 'slug', value: 'Bad Slug!' } : p
    );
    const r = await upload(parts);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid slug/);
  });

  it('400 when a required SVG is missing', async () => {
    const parts = onboardParts().filter((p) => p.name !== 'clean_board');
    // also give it a fresh slug so it fails on the missing file, not a dup
    const fresh = parts.map((p) =>
      p.name === 'slug' ? { name: 'slug', value: 'missing-svg' } : p
    );
    const r = await upload(fresh);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/missing clean board/);
  });

  it('GET /api/admin/templates lists statuses incl. chasers-board (403 without key)', async () => {
    const no = await fetch(base + '/api/admin/templates');
    expect(no.status).toBe(403);
    const res = await fetch(base + '/api/admin/templates?key=' + ADMIN_KEY);
    expect(res.status).toBe(200);
    const data = await res.json();
    const t = data.templates.find((x) => x.key === 'endpoint-demo');
    expect(t).toBeTruthy();
    expect(t.chasersBoard).toBe(false);
    const cb = t.assets.find((a) => a.role === 'clean-board-chasers');
    expect(cb.present).toBe(false);
    expect(cb.optional).toBe(true);
  });

  it('POST rename updates the label (200), keeps slug stable, 403 no key, 400 empty', async () => {
    const url = base + '/api/admin/templates/endpoint-demo/rename';
    const no = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_he: 'x' }),
    });
    expect(no.status).toBe(403);
    const ok = await fetch(url + '?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_he: 'שם ערוך' }),
    });
    expect(ok.status).toBe(200);
    const themes = ownerThemes();
    expect(themes['endpoint-demo'].display_he).toBe('שם ערוך');
    expect(themes['endpoint-demo'].slug).toBe('endpoint-demo'); // slug stays stable
    const bad = await fetch(url + '?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_he: '   ' }),
    });
    expect(bad.status).toBe(400);
  });

  it('POST asset replace swaps one file (200), 403 no key, 400 unknown role', async () => {
    const boundary = '----dugriTestR' + Math.random().toString(16).slice(2);
    const body = buildMultipart(boundary, [
      { name: 'file', filename: 'new.svg', data: SVG('REPLACED-BY-ENDPOINT') },
    ]);
    const post = (role, withKey) =>
      fetch(
        base +
          '/api/admin/templates/endpoint-demo/assets/' +
          role +
          (withKey ? '?key=' + ADMIN_KEY : ''),
        {
          method: 'POST',
          headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
          body,
        }
      );
    const no = await post('clean-fronts', false);
    expect(no.status).toBe(403);
    const ok = await post('clean-fronts', true);
    expect(ok.status).toBe(200);
    const file = fs.readFileSync(
      path.join(storeDir(), 'endpoint-demo', 'clean', 'fronts.svg'),
      'utf8'
    );
    expect(file).toContain('REPLACED-BY-ENDPOINT');
    const badRole = await post('bogus-role', true);
    expect(badRole.status).toBe(400);
    expect((await badRole.json()).error).toMatch(/unknown asset role/);
  });

  it('rename/replace routes reject a __proto__ key (404, no pollution)', async () => {
    const rn = await fetch(base + '/api/admin/templates/__proto__/rename?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_he: 'pwn' }),
    });
    expect(rn.status).toBe(404);
    const boundary = '----dugriProto' + Math.random().toString(16).slice(2);
    const body = buildMultipart(boundary, [{ name: 'file', filename: 'x.svg', data: SVG('x') }]);
    const rp = await fetch(
      base + '/api/admin/templates/constructor/assets/clean-fronts?key=' + ADMIN_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body,
      }
    );
    expect(rp.status).toBe(404);
    // Object.prototype was not polluted by the crafted keys.
    expect({}.display_he).toBeUndefined();
  });

  it('POST /:key/settings edits language/visibility/extra_fields; DELETE removes a template', async () => {
    // 'endpoint-demo' was onboarded above (public, hebrew-ish defaults). Edit it.
    const set = await fetch(base + '/api/admin/templates/endpoint-demo/settings?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visibility: 'private',
        language: 'english',
        extra_fields: 'AGE,YEARS',
      }),
    });
    expect(set.status).toBe(200);
    const setBody = await set.json();
    expect(setBody.settings).toMatchObject({
      visibility: 'private',
      language: 'english',
      extra_fields: ['AGE', 'YEARS'],
    });
    let themes = ownerThemes();
    expect(themes['endpoint-demo'].visibility).toBe('private');

    // A bad value is rejected (400), no write.
    const bad = await fetch(base + '/api/admin/templates/endpoint-demo/settings?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'klingon' }),
    });
    expect(bad.status).toBe(400);

    // 403 without the admin key.
    const noauth = await fetch(base + '/api/admin/templates/endpoint-demo/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(noauth.status).toBe(403);

    // DELETE removes the template (it isn't in THEME_BY_DESIGN, so not in use).
    const del = await fetch(base + '/api/admin/templates/endpoint-demo?key=' + ADMIN_KEY, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBe(true);
    themes = ownerThemes();
    expect(themes['endpoint-demo']).toBeUndefined();
    expect(fs.existsSync(path.join(storeDir(), 'endpoint-demo'))).toBe(false);

    // DELETE an unknown key → 404.
    const gone = await fetch(base + '/api/admin/templates/nope-x?key=' + ADMIN_KEY, {
      method: 'DELETE',
    });
    expect(gone.status).toBe(404);
  });

  it('POST /create makes an empty shell, then a per-asset upload lands on it', async () => {
    // Create the shell from METADATA ONLY (JSON, no files).
    const create = await fetch(base + '/api/admin/templates/create?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'shell-ep',
        display_he: 'ריק אנדפוינט',
        title_text: '{NAME}',
        name_form: 'english',
        visibility: 'public',
      }),
    });
    expect(create.status).toBe(201);
    const cbody = await create.json();
    expect(cbody.shell).toBe(true);
    // It shows in the list with clean-fronts MISSING.
    let list = await (await fetch(base + '/api/admin/templates?key=' + ADMIN_KEY)).json();
    let st = list.templates.find((t) => t.key === 'shell-ep');
    expect(st).toBeTruthy();
    expect(st.assets.find((a) => a.role === 'clean-fronts').present).toBe(false);

    // Upload ONE asset separately (multipart) — it lands, no giant combined POST.
    const boundary = '----dugriShell' + Math.random().toString(16).slice(2);
    const body = buildMultipart(boundary, [
      { name: 'file', filename: 'fronts.svg', data: SVG('SHELL-FRONTS') },
    ]);
    const up = await fetch(
      base + '/api/admin/templates/shell-ep/assets/clean-fronts?key=' + ADMIN_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body,
      }
    );
    expect(up.status).toBe(200);
    list = await (await fetch(base + '/api/admin/templates?key=' + ADMIN_KEY)).json();
    st = list.templates.find((t) => t.key === 'shell-ep');
    expect(st.assets.find((a) => a.role === 'clean-fronts').present).toBe(true);

    // Bad metadata → 400; 403 without the key.
    const bad = await fetch(base + '/api/admin/templates/create?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'BAD SLUG' }),
    });
    expect(bad.status).toBe(400);
    const noauth = await fetch(base + '/api/admin/templates/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'x' }),
    });
    expect(noauth.status).toBe(403);
  });
});

// The pure slug↔product-id bridge that carries an admin rename to the storefront:
// design (id + theme) × themes.json -> { id: display_he }. Exposes ONLY names.
describe('templates.designDisplayNames — the storefront name bridge', () => {
  let templates;
  beforeAll(() => {
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  const themes = {
    bachelorette: { slug: 'bachelorette', display_he: 'דוגרי רווקות', title_font: 'secret.ttf' },
    anniversary: { slug: 'anniversary', display_he: 'דוגרי יום נישואין' },
    'birthday-girls': { slug: 'birthday-girls', display_he: '  יום הולדת בנות  ' },
    'no-name': { slug: 'no-name' }, // no display_he
  };
  const designs = [
    { id: 'bachelorette', theme: 'bachelorette' },
    { id: 'marriage', theme: 'anniversary' },
    { id: 'birthday', theme: 'birthday-girls' },
    { id: 'ghost', theme: 'unmapped-theme' }, // theme absent from themes.json
    { id: 'blank', theme: 'no-name' }, // theme present but no display_he
  ];

  it('maps each design id to its theme display_he (trimmed), omitting unmapped/blank', () => {
    const names = templates.designDisplayNames(themes, designs);
    expect(names).toEqual({
      bachelorette: 'דוגרי רווקות',
      marriage: 'דוגרי יום נישואין',
      birthday: 'יום הולדת בנות', // trimmed
    });
    // unmapped theme + a theme with no display_he are omitted (page keeps built-in)
    expect('ghost' in names).toBe(false);
    expect('blank' in names).toBe(false);
  });

  it('exposes ONLY names — no other theme field (slug/fonts) leaks', () => {
    const names = templates.designDisplayNames(themes, designs);
    const serialized = JSON.stringify(names);
    expect(serialized).not.toContain('secret.ttf');
    expect(serialized).not.toContain('slug');
    for (const v of Object.values(names)) expect(typeof v).toBe('string');
  });

  it('a renamed theme flows straight through to the design name', () => {
    const renamed = { ...themes, bachelorette: { ...themes.bachelorette, display_he: 'שם חדש' } };
    expect(templates.designDisplayNames(renamed, designs).bachelorette).toBe('שם חדש');
  });

  it('the endpoint feeds the PUBLIC subset, so a private design name never leaks', () => {
    const t = {
      pubtheme: { display_he: 'PUBLIC NAME' },
      privtheme: { display_he: 'PRIVATE SECRET NAME' },
    };
    const full = [
      { id: 'pub', theme: 'pubtheme', public: true },
      { id: 'priv', theme: 'privtheme', public: false },
    ];
    // GET /api/design-names passes PUBLIC_DESIGNS (the public subset) — mirror that
    // filter here: the private design is dropped before mapping, so its name is
    // never produced.
    const names = templates.designDisplayNames(
      t,
      full.filter((d) => d.public)
    );
    expect(names).toEqual({ pub: 'PUBLIC NAME' });
    expect(JSON.stringify(names)).not.toContain('PRIVATE SECRET NAME');
  });

  it('is defensive: bad themes/designs and prototype-pollution keys yield {}', () => {
    expect(templates.designDisplayNames(null, designs)).toEqual({});
    expect(templates.designDisplayNames(themes, null)).toEqual({});
    expect(templates.designDisplayNames(themes, 'nope')).toEqual({});
    // a design pointing at a dangerous key resolves to nothing (ownTheme guard)
    expect(templates.designDisplayNames(themes, [{ id: 'x', theme: '__proto__' }])).toEqual({});
    expect(templates.designDisplayNames(themes, [{ id: 'x', theme: 'constructor' }])).toEqual({});
  });
});

// An over-sized upload is rejected by body-parser (express.raw) with a 413 BEFORE
// the route handler runs. Boot the app with a deliberately TINY limit and confirm
// the error middleware turns that into a legible JSON message (not a bare 413) so
// the admin UI can explain what happened. See TEMPLATE_UPLOAD_LIMIT in index.js.
describe('POST /api/admin/templates — oversized upload', () => {
  let app;
  let server;
  let base;
  let prevLimit;

  beforeAll(async () => {
    const root = makeScaffold();
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-413-data-'));
    process.env.GENERATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-413-gen-'));
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.TEMPLATE_ROOT = root;
    prevLimit = process.env.TEMPLATE_UPLOAD_LIMIT;
    process.env.TEMPLATE_UPLOAD_LIMIT = '2kb'; // tiny, so a small body trips it

    delete require.cache[require.resolve(path.join(serverDir, 'index.js'))];
    app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) server.close();
    if (prevLimit === undefined) delete process.env.TEMPLATE_UPLOAD_LIMIT;
    else process.env.TEMPLATE_UPLOAD_LIMIT = prevLimit;
    // Reload index.js on the real limit so later suites (if any) aren't affected.
    delete require.cache[require.resolve(path.join(serverDir, 'index.js'))];
  });

  it('returns a legible 413 (not a bare status) when the body exceeds the limit', async () => {
    const boundary = '----dugri413' + Math.random().toString(16).slice(2);
    const big = Buffer.alloc(10 * 1024, 0x41); // 10kb > 2kb limit
    const body = buildMultipart(boundary, [
      { name: 'clean_fronts', filename: 'big.svg', data: big },
    ]);
    const res = await fetch(base + '/api/admin/templates?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
    });
    expect(res.status).toBe(413);
    const data = await res.json().catch(() => ({}));
    expect(data.error).toBeTruthy();
    expect(String(data.detail)).toMatch(/size limit/i);
  });
});

// -- embedded-image shrinking -------------------------------------------------
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const shrinkRepoRoot = path.join(serverDir, '..');
// A buffer big enough to clear SHRINK_MIN_BYTES and containing an embedded image,
// so the real code path (spawn the shrinker) is exercised via an injected runner.
const BIG_IMG_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,' +
    'A'.repeat(400 * 1024) +
    '"/></svg>'
);

describe('templates.shrinkSvgImages (best-effort, injected runner)', () => {
  let templates;
  beforeAll(() => {
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  it('uses the shrunk output when it is smaller and still an SVG', () => {
    const small = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">tiny</svg>');
    const out = templates.shrinkSvgImages(BIG_IMG_SVG, {
      runner: () => ({ status: 0, stdout: small }),
    });
    expect(out).toBe(small);
  });

  it('keeps the original when the runner exits non-zero', () => {
    const runner = () => ({ status: 1, stdout: Buffer.from('<svg>x</svg>'), stderr: 'boom' });
    expect(templates.shrinkSvgImages(BIG_IMG_SVG, { runner })).toBe(BIG_IMG_SVG);
  });

  it('keeps the original when the output is not smaller', () => {
    const bigger = Buffer.concat([BIG_IMG_SVG, Buffer.from('xxxx')]);
    expect(
      templates.shrinkSvgImages(BIG_IMG_SVG, { runner: () => ({ status: 0, stdout: bigger }) })
    ).toBe(BIG_IMG_SVG);
  });

  it('keeps the original when the output does not look like an SVG', () => {
    const runner = () => ({ status: 0, stdout: Buffer.from('not-an-svg-at-all') });
    expect(templates.shrinkSvgImages(BIG_IMG_SVG, { runner })).toBe(BIG_IMG_SVG);
  });

  it('keeps the original when the runner throws', () => {
    const runner = () => {
      throw new Error('spawn failed');
    };
    expect(templates.shrinkSvgImages(BIG_IMG_SVG, { runner })).toBe(BIG_IMG_SVG);
  });

  it('never spawns for a small buffer or a vector-only SVG', () => {
    let called = 0;
    const runner = () => {
      called += 1;
      return { status: 0, stdout: Buffer.from('<svg>x</svg>') };
    };
    const small = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg">data:image/png;base64,AAAA</svg>'
    );
    const vectorOnly = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg">' + 'p'.repeat(400 * 1024) + '</svg>'
    );
    expect(templates.shrinkSvgImages(small, { runner })).toBe(small);
    expect(templates.shrinkSvgImages(vectorOnly, { runner })).toBe(vectorOnly);
    expect(called).toBe(0);
  });
});

describe('templates.shrinkSvgImages with real Python (skipped without Pillow)', () => {
  const hasPillow =
    nodeSpawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;
  let templates;
  beforeAll(() => {
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  it.runIf(hasPillow)('downsizes a large embedded image end-to-end', () => {
    // Build an SVG holding a big NOISY (incompressible) 1200px PNG via Pillow.
    const gen = nodeSpawnSync(
      'python3',
      [
        '-c',
        'import io,base64,os;from PIL import Image;' +
          'im=Image.frombytes("RGB",(1200,1200),os.urandom(1200*1200*3));' +
          'b=io.BytesIO();im.save(b,format="PNG");' +
          'print(base64.b64encode(b.getvalue()).decode())',
      ],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
    );
    const b64 = String(gen.stdout || '').trim();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<image xlink:href="data:image/png;base64,' +
        b64 +
        '"/></svg>'
    );
    const prev = process.env.TEMPLATE_IMAGE_MAXPX;
    process.env.TEMPLATE_IMAGE_MAXPX = '600'; // force a downsize from 1200px
    try {
      const out = templates.shrinkSvgImages(svg, { root: shrinkRepoRoot, pythonBin: 'python3' });
      expect(out.length).toBeLessThan(svg.length);
      expect(templates.looksLikeSvg(out)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TEMPLATE_IMAGE_MAXPX;
      else process.env.TEMPLATE_IMAGE_MAXPX = prev;
    }
  });
});

// Thumbnails in the asset checklist: nine near-identical rows are only tellable
// apart by LOOKING at the file. They cannot use <img> — that context blocks
// external references, and a de-duplicated card's whole background IS one, so
// every card rendered as an identical blank rectangle. Injected inline instead,
// which means the markup must not be able to execute anything.
describe('sanitizeSvgForDom (thumbnail injection)', () => {
  const src = fs.readFileSync(path.join(serverDir, 'index.js'), 'utf8');
  const fn = src.match(/function sanitizeSvgForDom[\s\S]*?\n}\n/)[0];
  const sanitize = eval(fn + ';sanitizeSvgForDom');

  it('strips <script> blocks and self-closing script tags', () => {
    expect(sanitize('<svg><script>alert(1)</script><rect/></svg>')).not.toMatch(/script/i);
    expect(sanitize('<svg><script src="x.js"/><rect/></svg>')).not.toMatch(/script/i);
  });

  it('strips inline event handlers in either quote style', () => {
    expect(sanitize('<svg><g onload="evil()"/></svg>')).not.toMatch(/onload/i);
    expect(sanitize("<svg><g onclick='evil()'/></svg>")).not.toMatch(/onclick/i);
  });

  it('strips javascript: hrefs', () => {
    expect(sanitize('<svg><a xlink:href="javascript:evil()"/></svg>')).not.toMatch(/javascript:/i);
  });

  it('leaves the artwork itself alone', () => {
    const art =
      '<svg><image xlink:href="/api/template-asset/x/y.png"/><rect fill="#711d20"/></svg>';
    expect(sanitize(art)).toBe(art);
  });
});
