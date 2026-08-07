// @vitest-environment node
//
// The two OPTIONAL second fonts a template may carry:
//
//   word_font_alt   the face EVERY English word is set in, when one is uploaded
//   title_font_alt  the second title face, used when the title's script is not
//                   the one the template's own title face is set in
//
// Both are additive. The rule that has to hold above all others is that
// uploading NOTHING leaves every template exactly as it is: the roles are
// `optional`, so a template with neither is COMPLETE, not broken. Get that wrong
// and every template shipped to date reports as missing two files.
//
// Also covered here: the first upload to a role with no filename on record (the
// path that had never existed before — every other font role always had one),
// removal (the undo for a font uploaded to the wrong template), and the
// four-font version of the anniversary trap, where two roles name ONE file.
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

const SVG = (label) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${label}</svg>`);
// Passes the sfnt magic check (0x00010000 = TrueType) with identifiable bytes.
const FONT = (label = '') =>
  Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from(label)]);

function makeScaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-altfont-'));
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify({ 'seed-theme': { slug: 'seed-theme', calibrated: true } }, null, 1) + '\n',
    'utf8'
  );
  return root;
}

function validFiles() {
  return {
    clean_fronts: { filename: 'cf.svg', data: SVG('clean-fronts') },
    clean_backs: { filename: 'cb.svg', data: SVG('clean-backs') },
    clean_board: { filename: 'cbo.svg', data: SVG('clean-board') },
    filled_fronts: { filename: 'ff.svg', data: SVG('filled-fronts') },
    filled_backs: { filename: 'fb.svg', data: SVG('filled-backs') },
    filled_board: { filename: 'fbo.svg', data: SVG('filled-board') },
    title_font: { filename: 'Title.ttf', data: FONT('TITLEFONT') },
    word_font: { filename: 'Word.ttf', data: FONT('WORDFONT') },
  };
}

describe('optional second fonts (word_font_alt / title_font_alt)', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR; // image paths only
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  function onboard(root, slug, extraFiles) {
    return templates.onboardTemplate({
      root,
      runRecipe: false,
      shrinkImages: false,
      fields: { slug, display_he: 'שם התחלתי', title_text: '{NAME}', name_form: 'hebrew' },
      files: { ...validFiles(), ...(extraFiles || {}) },
    });
  }
  const themeOf = (root, key) => templates.loadThemes(templates.themesPathFor(root))[key];
  const statusOf = (root, key) => templates.computeTemplateStatus(root, key, themeOf(root, key));
  const byRole = (st) => Object.fromEntries(st.assets.map((a) => [a.role, a]));

  it('a template with NEITHER second font is complete, and its entry carries no alt keys', () => {
    const root = makeScaffold();
    onboard(root, 'plain-x');
    const st = statusOf(root, 'plain-x');
    const by = byRole(st);
    // The roles are listed (so she can upload one), optional, and absent.
    expect(by['word-font-alt'].optional).toBe(true);
    expect(by['title-font-alt'].optional).toBe(true);
    expect(by['word-font-alt'].present).toBe(false);
    expect(by['title-font-alt'].present).toBe(false);
    // ...and none of that makes the template broken. This is the assertion that
    // protects every template shipped before this feature existed.
    expect(st.complete).toBe(true);
    expect(st.missingRequired).toEqual([]);
    // An ABSENT key, not an empty string: config.resolve_*_font_alt reads "no
    // second face" from the key not being there.
    const entry = themeOf(root, 'plain-x');
    expect('word_font_alt' in entry).toBe(false);
    expect('title_font_alt' in entry).toBe(false);
  });

  it('every SHIPPED template still reports complete — no alt font is ever missingRequired', () => {
    // Run against the REAL repo. The alt roles must never appear in any
    // template's missingRequired, whatever else is or is not on disk.
    const themes = templates.loadThemes(templates.themesPathFor(repoRoot));
    const keys = Object.keys(themes);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const st = templates.computeTemplateStatus(repoRoot, key, themes[key]);
      expect(st.missingRequired).not.toContain('word-font-alt');
      expect(st.missingRequired).not.toContain('title-font-alt');
    }
  });

  it('the FIRST upload to a role with no filename on record writes the file and records it', () => {
    // The path that mattered most: every other font role always had a recorded
    // filename, so `rel` was never null before an alt role existed.
    const root = makeScaffold();
    onboard(root, 'first-x');
    const r = templates.replaceAsset({
      root,
      key: 'first-x',
      role: 'word-font-alt',
      file: { filename: 'Latin.otf', data: FONT('LATIN') },
    });
    expect(r.error).toBeUndefined();
    const dir = path.join(root, 'resources', 'canva', 'templates', 'first-x');
    expect(fs.readFileSync(path.join(dir, 'fonts', 'Latin.otf')).toString()).toContain('LATIN');
    expect(themeOf(root, 'first-x').word_font_alt).toBe('Latin.otf');
    // ...and the role now reads as present, with the file NAMED on the row.
    const by = byRole(statusOf(root, 'first-x'));
    expect(by['word-font-alt'].present).toBe(true);
    expect(by['word-font-alt'].fontName).toBe('Latin.otf');
  });

  it('four distinct uploads produce four distinct fonts — the anniversary trap, doubled', () => {
    // title_font === word_font is a real shipped shape (anniversary/סנטוריני).
    // With four roles there are more ways for one upload to land on another's
    // file; each role must end up naming exactly what was uploaded to it.
    const root = makeScaffold();
    onboard(root, 'four-x', {
      title_font: { filename: 'Shared.ttf', data: FONT('SHARED') },
      word_font: { filename: 'Shared.ttf', data: FONT('SHARED') },
    });
    expect(themeOf(root, 'four-x').title_font).toBe(themeOf(root, 'four-x').word_font); // the trap
    for (const [role, name, tag] of [
      ['title-font', 'T.otf', 'TITLE'],
      ['word-font', 'W.otf', 'WORD'],
      ['title-font-alt', 'TA.otf', 'TITLEALT'],
      ['word-font-alt', 'WA.otf', 'WORDALT'],
    ]) {
      const r = templates.replaceAsset({
        root,
        key: 'four-x',
        role,
        file: { filename: name, data: FONT(tag) },
      });
      expect(r.error).toBeUndefined();
    }
    const e = themeOf(root, 'four-x');
    expect([e.title_font, e.word_font, e.title_font_alt, e.word_font_alt]).toEqual([
      'T.otf',
      'W.otf',
      'TA.otf',
      'WA.otf',
    ]);
    const dir = path.join(root, 'resources', 'canva', 'templates', 'four-x', 'fonts');
    expect(fs.readFileSync(path.join(dir, 'T.otf')).toString()).toContain('TITLE');
    expect(fs.readFileSync(path.join(dir, 'W.otf')).toString()).toContain('WORD');
    expect(fs.readFileSync(path.join(dir, 'TA.otf')).toString()).toContain('TITLEALT');
    expect(fs.readFileSync(path.join(dir, 'WA.otf')).toString()).toContain('WORDALT');
  });

  it('junk bytes are refused on an alt role too, leaving nothing recorded', () => {
    const root = makeScaffold();
    onboard(root, 'junk-x');
    const r = templates.replaceAsset({
      root,
      key: 'junk-x',
      role: 'title-font-alt',
      file: { filename: 'NotAFont.ttf', data: Buffer.from('this is a zip, actually') },
    });
    expect(r.error).toMatch(/font/);
    expect('title_font_alt' in themeOf(root, 'junk-x')).toBe(false);
  });

  describe('removal — the undo for a font on the wrong template', () => {
    it('clears the field and deletes the file, leaving the entry clean', () => {
      const root = makeScaffold();
      onboard(root, 'rm-x');
      templates.replaceAsset({
        root,
        key: 'rm-x',
        role: 'word-font-alt',
        file: { filename: 'Wrong.otf', data: FONT('WRONG') },
      });
      const abs = path.join(root, 'resources', 'canva', 'templates', 'rm-x', 'fonts', 'Wrong.otf');
      expect(fs.existsSync(abs)).toBe(true);

      const r = templates.clearAsset({ root, key: 'rm-x', role: 'word-font-alt' });
      expect(r.error).toBeUndefined();
      expect(r.removed).toBe(true);
      expect(r.fileDeleted).toBe(true);
      expect(fs.existsSync(abs)).toBe(false);
      // The key is GONE, not blanked — an empty string reads as "there is a
      // second face" to anything doing a truthiness check.
      const entry = themeOf(root, 'rm-x');
      expect('word_font_alt' in entry).toBe(false);
      // ...and the template is back to exactly the state it onboarded in.
      const st = statusOf(root, 'rm-x');
      expect(st.complete).toBe(true);
      expect(byRole(st)['word-font-alt'].present).toBe(false);
    });

    it('keeps the FILE when another role still names it', () => {
      // Clearing a field must not delete a font the template is still printing
      // with — the shipped one-file-two-roles shape makes this reachable.
      const root = makeScaffold();
      onboard(root, 'shared-x');
      templates.replaceAsset({
        root,
        key: 'shared-x',
        role: 'word-font-alt',
        file: { filename: 'Both.otf', data: FONT('BOTH') },
      });
      templates.replaceAsset({
        root,
        key: 'shared-x',
        role: 'title-font-alt',
        file: { filename: 'Both.otf', data: FONT('BOTH') },
      });
      const abs = path.join(
        root,
        'resources',
        'canva',
        'templates',
        'shared-x',
        'fonts',
        'Both.otf'
      );
      const r = templates.clearAsset({ root, key: 'shared-x', role: 'word-font-alt' });
      expect(r.removed).toBe(true);
      expect(r.fileDeleted).toBe(false);
      expect(fs.existsSync(abs)).toBe(true);
      const entry = themeOf(root, 'shared-x');
      expect('word_font_alt' in entry).toBe(false);
      expect(entry.title_font_alt).toBe('Both.otf'); // still rendering with it
    });

    it('refuses to remove a REQUIRED font, or an SVG role', () => {
      const root = makeScaffold();
      onboard(root, 'keep-x');
      for (const role of ['title-font', 'word-font', 'clean-fronts']) {
        const r = templates.clearAsset({ root, key: 'keep-x', role });
        expect(r.httpStatus).toBe(400);
        expect(r.error).toMatch(/cannot be removed/);
      }
      const entry = themeOf(root, 'keep-x');
      expect(entry.title_font).toBe('Title.ttf');
      expect(entry.word_font).toBe('Word.ttf');
    });

    it('removing a font that was never uploaded is a no-op, not an error', () => {
      const root = makeScaffold();
      onboard(root, 'noop-x');
      const r = templates.clearAsset({ root, key: 'noop-x', role: 'title-font-alt' });
      expect(r.error).toBeUndefined();
      expect(r.removed).toBe(false);
    });

    it('404s on a template that does not exist', () => {
      const root = makeScaffold();
      const r = templates.clearAsset({ root, key: 'nope', role: 'title-font-alt' });
      expect(r.httpStatus).toBe(404);
    });
  });

  describe('onboarding accepts the second faces up front', () => {
    it('records both when uploaded', () => {
      const root = makeScaffold();
      onboard(root, 'onb-x', {
        word_font_alt: { filename: 'Latin.otf', data: FONT('LATIN') },
        title_font_alt: { filename: 'TitleTwo.otf', data: FONT('TITLETWO') },
      });
      const entry = themeOf(root, 'onb-x');
      expect(entry.word_font_alt).toBe('Latin.otf');
      expect(entry.title_font_alt).toBe('TitleTwo.otf');
      const dir = path.join(root, 'resources', 'canva', 'templates', 'onb-x', 'fonts');
      expect(fs.readFileSync(path.join(dir, 'Latin.otf')).toString()).toContain('LATIN');
      expect(fs.readFileSync(path.join(dir, 'TitleTwo.otf')).toString()).toContain('TITLETWO');
    });

    it('refuses a junk second font rather than recording it', () => {
      const root = makeScaffold();
      const r = onboard(root, 'onb-bad', {
        word_font_alt: { filename: 'Latin.otf', data: Buffer.from('nope') },
      });
      expect(r.error).toMatch(/word_font_alt/);
    });

    it('an EMPTY optional file part (the untouched input) is simply ignored', () => {
      const root = makeScaffold();
      const r = onboard(root, 'onb-empty', {
        word_font_alt: { filename: '', data: Buffer.alloc(0) },
        title_font_alt: { filename: '', data: Buffer.alloc(0) },
      });
      expect(r.error).toBeUndefined();
      expect('word_font_alt' in themeOf(root, 'onb-empty')).toBe(false);
    });
  });

  describe('which scripts a font can draw', () => {
    // Read off the font's own cmap. The point is the מרקאנה failure: a title font
    // with no Hebrew glyphs and a Hebrew honoree name, where the title simply
    // did not print and nothing said why.
    const fontFile = (rel) => fs.readFileSync(path.join(repoRoot, rel));

    it('reads real shipped fonts correctly', () => {
      expect(
        templates.fontScriptCoverage(
          fontFile('resources/canva/templates/football-boys/fonts/LeagueSpartan-Bold.ttf')
        )
      ).toEqual({ hebrew: false, latin: true });
      expect(
        templates.fontScriptCoverage(
          fontFile('resources/canva/templates/football-boys/fonts/PlaypenSansHebrew-Medium.ttf')
        )
      ).toEqual({ hebrew: true, latin: true });
      // A Hebrew-only face — the mirror image, and why the English-word font
      // exists at all.
      expect(
        templates.fontScriptCoverage(
          fontFile('resources/canva/templates/anniversary/fonts/Dana Yad AlefAlefAlef Normal.ttf')
        )
      ).toEqual({ hebrew: true, latin: false });
    });

    it('says UNKNOWN (null) rather than guessing on a file it cannot parse', () => {
      expect(templates.fontScriptCoverage(Buffer.from('not a font at all'))).toBeNull();
      // Right magic, truncated body: still unknown, never "missing Hebrew".
      expect(templates.fontScriptCoverage(FONT('too short to hold a cmap'))).toBeNull();
    });

    it('warns when the title font cannot draw Hebrew, and stops once a second face can', () => {
      const root = makeScaffold();
      onboard(root, 'gap-x', {
        title_font: {
          filename: 'LeagueSpartan-Bold.ttf',
          data: fontFile('resources/canva/templates/football-boys/fonts/LeagueSpartan-Bold.ttf'),
        },
        word_font: {
          filename: 'Playpen.ttf',
          data: fontFile(
            'resources/canva/templates/football-boys/fonts/PlaypenSansHebrew-Medium.ttf'
          ),
        },
      });
      const notes = statusOf(root, 'gap-x').fontNotes;
      expect(notes.some((n) => n.role === 'title-font-alt' && /עברית/.test(n.text))).toBe(true);
      // A gap is advisory — it never makes the template incomplete.
      expect(statusOf(root, 'gap-x').complete).toBe(true);

      templates.replaceAsset({
        root,
        key: 'gap-x',
        role: 'title-font-alt',
        file: {
          filename: 'Playpen.ttf',
          data: fontFile(
            'resources/canva/templates/football-boys/fonts/PlaypenSansHebrew-Medium.ttf'
          ),
        },
      });
      expect(statusOf(root, 'gap-x').fontNotes).toEqual([]);
    });

    it('says nothing at all when the fonts cannot be measured', () => {
      // The scaffold's stub fonts are 4 magic bytes and a label — unparseable.
      // Unknown coverage must produce NO note; a wrong warning on the screen she
      // uses to decide what to fix is worse than no warning.
      const root = makeScaffold();
      onboard(root, 'quiet-x');
      expect(statusOf(root, 'quiet-x').fontNotes).toEqual([]);
      expect(byRole(statusOf(root, 'quiet-x'))['title-font'].scripts).toBeNull();
    });
  });
});
