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

  it('buildThemeEntry produces a private, uncalibrated entry with null style/board/back', () => {
    const e = templates.buildThemeEntry({
      slug: 'demo',
      displayHe: 'דמו',
      titleText: "{NAME}'S\nB-DAY",
      titleFont: 'Title.ttf',
      wordFont: 'Word.ttf',
      nameForm: 'english',
      extraFields: ['AGE'],
    });
    expect(e.visibility).toBe('private');
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

  it('onboardTemplate (runRecipe:false) writes files + a private uncalibrated theme entry', () => {
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
    expect(r.visibility).toBe('private');
    expect(r.recipe).toBe('skipped');

    const themes = JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8'));
    expect(themes['party-x'].visibility).toBe('private');
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

  it('replaceAsset replaces a font (by sfnt magic) at the recorded path', () => {
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
    // written to the SAME filename the generator reads from themes.json
    expect(fs.readFileSync(path.join(dir, 'fonts', 'Title.ttf')).equals(good)).toBe(true);
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

describe('POST /api/admin/templates', () => {
  let app;
  let server;
  let base;
  let root;

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
    expect(r.body.visibility).toBe('private');
    expect(r.body.recipe).toBe('generated');
    expect(r.body.note).toMatch(/calibrat/i);

    // files landed under the throwaway TEMPLATE_ROOT
    const dir = path.join(root, 'resources', 'canva', 'templates', 'endpoint-demo');
    expect(fs.existsSync(path.join(dir, 'clean', 'fronts.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'filled', 'backs.svg'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'fonts', 'Title.ttf'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'fonts', 'Word.ttf'))).toBe(true);

    // recipe was produced by the fake python
    expect(fs.existsSync(path.join(root, 'generator', 'recipes', 'endpoint-demo.json'))).toBe(true);

    // themes.json gained a private, uncalibrated entry
    const themes = JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8'));
    expect(themes['endpoint-demo'].visibility).toBe('private');
    expect(themes['endpoint-demo'].calibrated).toBe(false);
    expect(themes['endpoint-demo'].title_style).toBeNull();
    expect(themes['endpoint-demo'].extra_fields).toEqual(['AGE']);
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
    const themes = JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8'));
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
      path.join(root, 'resources', 'canva', 'templates', 'endpoint-demo', 'clean', 'fronts.svg'),
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

  it('is defensive: bad themes/designs and prototype-pollution keys yield {}', () => {
    expect(templates.designDisplayNames(null, designs)).toEqual({});
    expect(templates.designDisplayNames(themes, null)).toEqual({});
    expect(templates.designDisplayNames(themes, 'nope')).toEqual({});
    // a design pointing at a dangerous key resolves to nothing (ownTheme guard)
    expect(templates.designDisplayNames(themes, [{ id: 'x', theme: '__proto__' }])).toEqual({});
    expect(templates.designDisplayNames(themes, [{ id: 'x', theme: 'constructor' }])).toEqual({});
  });
});
