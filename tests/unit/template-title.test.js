// @vitest-environment node
//
// THE HONOREE TITLE: editing it after a template exists, and refusing to create a
// broken one in the first place.
//
// The bug this covers: a template was onboarded whose title carried no usable
// {NAME}, so every card printed "'s Birthday" — the honoree's name simply absent.
// config.py's substitution is not at fault; it fills {NAME} correctly and then
// STRIPS any placeholder it could not fill (`re.sub(r"\{[^{}]*\}", "", line)`),
// which is exactly why a missing/mis-cased placeholder produces a silent gap
// rather than a visible error. Two things were missing:
//   1. `updateTemplateSettings` accepted no title field at all, so a bad title was
//      permanent short of hand-editing themes.json on the volume;
//   2. onboarding accepted ANY non-empty string, so the bad title could be created
//      without a word of warning.
//
// `title_lines` is AUTHORITATIVE — config.title_lines() iterates exactly that list
// and nothing reads `title_text` — so every write here derives title_text from the
// saved lines and the two can never drift.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-title-key';
const SVG = (label) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${label}</svg>`);

function makeScaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-title-root-'));
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
    title_font: { filename: 'Title.ttf', data: Buffer.from('TITLEFONT') },
    word_font: { filename: 'Word.ttf', data: Buffer.from('WORDFONT') },
  };
}

describe('validateTitle (the placeholder contract)', () => {
  let templates;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
  });

  it('normalizes a multi-line title into lines + a derived title_text', () => {
    const v = templates.validateTitle({
      titleText: "  {NAME}'S \n\n  BIRTHDAY  \n",
      extraFields: [],
    });
    expect(v.error).toBeUndefined();
    // One entry per RENDERED line — the shape config.title_lines() iterates.
    expect(v.title_lines).toEqual(["{NAME}'S", 'BIRTHDAY']);
    // …and title_text is derived FROM the lines, so the pair cannot drift.
    expect(v.title_text).toBe("{NAME}'S\nBIRTHDAY");
    expect(v.placeholders).toEqual(['NAME']);
  });

  it('accepts a list directly and drops blank lines', () => {
    const v = templates.validateTitle({
      titleLines: ['{NAME}', '   ', 'B-DAY'],
      extraFields: [],
    });
    expect(v.title_lines).toEqual(['{NAME}', 'B-DAY']);
    expect(v.title_text).toBe('{NAME}\nB-DAY');
  });

  it('REFUSES a title with no {NAME} unless the caller confirms', () => {
    const bad = templates.validateTitle({ titleText: "'s Birthday", extraFields: [] });
    expect(bad.error).toMatch(/no \{NAME\}/);
    // Flagged so the caller can offer a confirmation instead of a dead end.
    expect(bad.titleless).toBe(true);
    // Confirmed, it saves: a fixed title is legitimate (the 'daniel amit' deck's
    // artwork reads "Bride in One Pot" and carries no name at all).
    const ok = templates.validateTitle({
      titleText: "'s Birthday",
      extraFields: [],
      allowNoName: true,
    });
    expect(ok.error).toBeUndefined();
    expect(ok.title_lines).toEqual(["'s Birthday"]);
  });

  it('REFUSES a placeholder the template does not collect, and names the fix', () => {
    const v = templates.validateTitle({ titleText: '{NAME} בן {AGE}', extraFields: [] });
    // {AGE} is never asked for by the wizard, so the generator would strip it and
    // the card would print "DANIEL בן " — the exact class of bug being reported.
    expect(v.error).toMatch(/\{AGE\}/);
    expect(v.error).toMatch(/extra_fields/);
    // Declaring the field makes the same title legal.
    const ok = templates.validateTitle({ titleText: '{NAME} בן {AGE}', extraFields: ['AGE'] });
    expect(ok.error).toBeUndefined();
    expect(ok.placeholders).toEqual(['NAME', 'AGE']);
  });

  it('REFUSES a mis-cased placeholder rather than silently stripping it', () => {
    // {Name} matches no key in config.py's substitution map, so it would be erased
    // at render time and print nothing — indistinguishable from a missing name.
    const v = templates.validateTitle({ titleText: "{Name}'s Birthday", extraFields: [] });
    expect(v.error).toMatch(/\{Name\}/);
  });

  it('REFUSES an unclosed brace (it would print raw on the card)', () => {
    const v = templates.validateTitle({ titleText: "{NAME's Birthday", extraFields: [] });
    expect(v.error).toMatch(/unclosed/);
  });

  it('REFUSES an empty title and one with too many lines', () => {
    expect(templates.validateTitle({ titleText: '   ', extraFields: [] }).error).toMatch(
      /required/
    );
    expect(
      templates.validateTitle({ titleLines: Array(9).fill('{NAME}'), extraFields: [] }).error
    ).toMatch(/too many lines/);
  });

  it('reports an extra field the title never uses (advisory, not an error)', () => {
    const v = templates.validateTitle({ titleText: '{NAME}', extraFields: ['AGE'] });
    expect(v.error).toBeUndefined();
    // The wizard would ask the buyer for an age that nothing prints.
    expect(v.unusedFields).toEqual(['AGE']);
  });

  it('titlePlaceholders lists every token used, once, in order', () => {
    expect(templates.titlePlaceholders(['{YEARS} שנה', '{NAME1} ו{NAME2}', '{NAME1}'])).toEqual([
      'YEARS',
      'NAME1',
      'NAME2',
    ]);
  });

  // ---- Gender alternation markers ----------------------------------------
  // Hebrew is gendered, so a birthday title has to say בן for a boy and בת for a
  // girl from ONE template. "{m:בן|f:בת}" is a MARKER, not a placeholder: it
  // needs no extra field and resolves from the order's gender in config.py. The
  // buyer's selection picks the labelled form; an order with no recorded gender
  // takes whichever form is written FIRST — the template's own default. The
  // whole mechanism is useless unless it survives the admin title box.

  it('ACCEPTS a gender marker — it names no field, so it needs none', () => {
    const v = templates.validateTitle({
      titleText: '{NAME} {m:בן|f:בת} {AGE}',
      extraFields: ['AGE'],
    });
    expect(v.error).toBeUndefined();
    // The marker is NOT reported as a placeholder — there is no "m:בן|f:בת" field.
    expect(v.placeholders).toEqual(['NAME', 'AGE']);
    expect(v.title_lines).toEqual(['{NAME} {m:בן|f:בת} {AGE}']);
  });

  it('accepts either order — the first form is just the template default', () => {
    // A boys' design writes masculine first, a girls' design feminine first, and
    // both are legal: the ORDER only decides the no-recorded-gender fallback.
    for (const t of ['{NAME} {m:בן|f:בת}', '{NAME} {f:בת|m:בן}']) {
      expect(templates.validateTitle({ titleText: t, extraFields: [] }).error).toBeUndefined();
    }
  });

  it('does not mistake a marker for a missing extra field', () => {
    // Before the marker was understood, this rejected with "the template does
    // not collect m:בן|f:בת" — so the owner could not save the very fix she needed.
    expect(templates.titlePlaceholders(['{NAME} {m:בן|f:בת} {AGE}'])).toEqual(['NAME', 'AGE']);
  });

  it('REFUSES an UNLABELLED marker rather than guessing which word is which', () => {
    // "{בן|בת}" is two Hebrew words to a program. Accepting it would print the
    // first form to everyone — a girl's deck carrying the boy's word, which is
    // the exact defect the marker exists to remove.
    const v = templates.validateTitle({ titleText: '{NAME} {בן|בת}', extraFields: [] });
    expect(v.error).toMatch(/which form is which/);
    expect(v.error).toMatch(/m:בן\|f:בת/);
    // Half-labelled is no better.
    expect(
      templates.validateTitle({ titleText: '{NAME} {m:בן|בת}', extraFields: [] }).error
    ).toMatch(/which form is which/);
  });

  it('REFUSES a marker that labels both forms the same gender', () => {
    const v = templates.validateTitle({ titleText: '{NAME} {m:בן|male:בת}', extraFields: [] });
    expect(v.error).toMatch(/both forms/);
  });

  it('still REFUSES an unclosed marker (it would print a raw brace)', () => {
    expect(
      templates.validateTitle({ titleText: '{NAME} {m:בן|f:בת', extraFields: [] }).error
    ).toMatch(/unclosed/);
  });

  it('REFUSES a marker with more than two forms — the extras would vanish', () => {
    const v = templates.validateTitle({ titleText: '{NAME} {m:בן|f:בת|זה}', extraFields: [] });
    expect(v.error).toMatch(/3 forms/);
    expect(v.error).toMatch(/m:בן\|f:בת/);
  });

  it('accepts ONE empty side — a gendered suffix (חוגג / חוגגת)', () => {
    expect(
      templates.validateTitle({ titleText: '{NAME} חוגג{m:|f:ת}', extraFields: [] }).error
    ).toBeUndefined();
  });
});

describe('updateTemplateSettings — editing the title after creation', () => {
  let templates;
  let root;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
    root = makeScaffold();
  });

  // Onboard a template whose title is broken exactly the way the reported one is:
  // no {NAME} anywhere, confirmed at creation.
  function onboardBroken(slug) {
    return templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: {
        slug,
        display_he: 'יום הולדת',
        title_text: "'s\nBirthday",
        allow_titleless: 'true',
        name_form: 'english',
      },
      files: validFiles(),
    });
  }

  it('repairs a nameless title — the fix the owner had no way to make', () => {
    onboardBroken('fix-me');
    const themesPath = templates.themesPathFor(root);
    // Before: exactly the reported symptom — no {NAME} in the lines the renderer
    // iterates, so every card prints "'s Birthday".
    expect(templates.loadThemes(themesPath)['fix-me'].title_lines).toEqual(["'s", 'Birthday']);

    const r = templates.updateTemplateSettings({
      root,
      key: 'fix-me',
      patch: { title_lines: ["{NAME}'s", 'Birthday'] },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings.title_lines).toEqual(["{NAME}'s", 'Birthday']);
    expect(r.settings.title_text).toBe("{NAME}'s\nBirthday");

    // PERSISTED in the shape the generator reads: config.title_lines() iterates
    // `title_lines`, one rendered line per entry.
    const saved = templates.loadThemes(themesPath)['fix-me'];
    expect(saved.title_lines).toEqual(["{NAME}'s", 'Birthday']);
    expect(saved.title_text).toBe("{NAME}'s\nBirthday");
    // Identity untouched — a title edit must never move a template's files or
    // break an order that already resolved to it.
    expect(saved.slug).toBe('fix-me');
    expect(saved.dir).toBe('resources/canva/templates/fix-me');
  });

  it('ROUND-TRIPS a gender marker through the admin title editor', () => {
    // The owner's actual fix for "ברוקלין": swap the hardcoded בן for a marker.
    // It has to save, persist verbatim, and read back byte-for-byte — a mangled
    // or rejected marker means the generator never sees it.
    onboardBroken('gendered');
    const themesPath = templates.themesPathFor(root);
    const r = templates.updateTemplateSettings({
      root,
      key: 'gendered',
      patch: { title_lines: ['{NAME} {m:בן|f:בת} {AGE}'], extra_fields: ['AGE'] },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings.title_lines).toEqual(['{NAME} {m:בן|f:בת} {AGE}']);
    expect(r.settings.title_text).toBe('{NAME} {m:בן|f:בת} {AGE}');
    const saved = templates.loadThemes(themesPath)['gendered'];
    expect(saved.title_lines).toEqual(['{NAME} {m:בן|f:בת} {AGE}']);
    expect(saved.title_text).toBe('{NAME} {m:בן|f:בת} {AGE}');
  });

  it('accepts title_text and derives the lines from it', () => {
    onboardBroken('via-text');
    const r = templates.updateTemplateSettings({
      root,
      key: 'via-text',
      patch: { title_text: "XOXO\n{NAME}'S BIRTHDAY" },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings.title_lines).toEqual(['XOXO', "{NAME}'S BIRTHDAY"]);
  });

  it('title_lines WINS when both arrive (it is the one the renderer reads)', () => {
    onboardBroken('both');
    const r = templates.updateTemplateSettings({
      root,
      key: 'both',
      patch: { title_text: 'IGNORED', title_lines: ['{NAME}', 'PARTY'] },
    });
    expect(r.settings.title_lines).toEqual(['{NAME}', 'PARTY']);
    // The stored title_text is re-derived from the lines, never the stale input.
    expect(r.settings.title_text).toBe('{NAME}\nPARTY');
  });

  it('refuses a nameless title without confirmation, and saves it with one', () => {
    onboardBroken('confirm-me');
    const blocked = templates.updateTemplateSettings({
      root,
      key: 'confirm-me',
      patch: { title_lines: ['Bride in One Pot'] },
    });
    expect(blocked.httpStatus).toBe(400);
    expect(blocked.titleless).toBe(true);
    // Nothing was written.
    expect(templates.loadThemes(templates.themesPathFor(root))['confirm-me'].title_lines).toEqual([
      "'s",
      'Birthday',
    ]);

    const ok = templates.updateTemplateSettings({
      root,
      key: 'confirm-me',
      patch: { title_lines: ['Bride in One Pot'], allow_titleless: true },
    });
    expect(ok.error).toBeUndefined();
    expect(ok.settings.title_lines).toEqual(['Bride in One Pot']);
  });

  it('refuses a title whose placeholder the template does not collect (no partial write)', () => {
    onboardBroken('mismatch');
    const r = templates.updateTemplateSettings({
      root,
      key: 'mismatch',
      patch: { title_lines: ['{NAME} בן {AGE}'], visibility: 'private' },
    });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toMatch(/\{AGE\}/);
    // The whole patch is rejected — `visibility` did not sneak through.
    const saved = templates.loadThemes(templates.themesPathFor(root))['mismatch'];
    expect(saved.visibility).toBe('public');
    expect(saved.title_lines).toEqual(["'s", 'Birthday']);
  });

  it('accepts a title + the extra field it needs in ONE save', () => {
    onboardBroken('one-save');
    const r = templates.updateTemplateSettings({
      root,
      key: 'one-save',
      // Neither half is valid alone: the title needs AGE declared, and declaring
      // AGE alone would leave it unused. Validated against the RESULT, so the
      // owner is not stuck in a chicken-and-egg pair of rejected saves.
      patch: { title_lines: ['{NAME} בן {AGE}'], extra_fields: 'AGE' },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings.title_lines).toEqual(['{NAME} בן {AGE}']);
    expect(r.settings.extra_fields).toEqual(['AGE']);
  });

  it('refuses REMOVING an extra field the current title still uses', () => {
    onboardBroken('narrow');
    templates.updateTemplateSettings({
      root,
      key: 'narrow',
      patch: { title_lines: ['{NAME} בן {AGE}'], extra_fields: 'AGE' },
    });
    const r = templates.updateTemplateSettings({
      root,
      key: 'narrow',
      patch: { extra_fields: '' },
    });
    expect(r.httpStatus).toBe(400);
    expect(r.error).toMatch(/\{AGE\}/);
    expect(templates.loadThemes(templates.themesPathFor(root))['narrow'].extra_fields).toEqual([
      'AGE',
    ]);
  });

  it('a settings save that touches NEITHER title nor fields never re-judges the title', () => {
    onboardBroken('untouched');
    // This template's title has no {NAME} (confirmed at creation). Flipping an
    // unrelated switch must not demand the confirmation all over again — the
    // gate guards the title EDIT, not every save on the template.
    const r = templates.updateTemplateSettings({
      root,
      key: 'untouched',
      patch: { visibility: 'private', extra_fields: '' },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings.visibility).toBe('private');
  });

  it('computeTemplateStatus reports the title so the form can show and edit it', () => {
    onboardBroken('shown');
    const themes = templates.loadThemes(templates.themesPathFor(root));
    const st = templates.computeTemplateStatus(root, 'shown', themes['shown']);
    expect(st.title_lines).toEqual(["'s", 'Birthday']);
    expect(st.title_text).toBe("'s\nBirthday");
  });
});

describe('onboarding refuses to CREATE the broken title in the first place', () => {
  let templates;
  let root;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    delete require.cache[require.resolve(path.join(serverDir, 'templates.js'))];
    templates = require(path.join(serverDir, 'templates.js'));
    root = makeScaffold();
  });

  const fields = (extra) => ({
    slug: 'onb',
    display_he: 'יום הולדת',
    name_form: 'english',
    ...extra,
  });

  it('rejects a nameless title, and nothing is registered or written', () => {
    const r = templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: fields({ title_text: "'s Birthday" }),
      files: validFiles(),
    });
    expect(r.error).toMatch(/no \{NAME\}/);
    expect(r.titleless).toBe(true);
    expect(templates.loadThemes(templates.themesPathFor(root))['onb']).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'resources', 'canva', 'templates', 'onb'))).toBe(false);
  });

  it('rejects a title referencing a field the form does not declare', () => {
    const r = templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: fields({ title_text: "{NAME}'S {AGE}S", extra_fields: '' }),
      files: validFiles(),
    });
    expect(r.error).toMatch(/\{AGE\}/);
    // Same form, with the field declared: fine.
    const ok = templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: fields({ slug: 'onb-ok', title_text: "{NAME}'S {AGE}S", extra_fields: 'AGE' }),
      files: validFiles(),
    });
    expect(ok.error).toBeUndefined();
    expect(templates.loadThemes(templates.themesPathFor(root))['onb-ok'].title_lines).toEqual([
      "{NAME}'S {AGE}S",
    ]);
  });

  it('allows a deliberately nameless title when the owner confirms', () => {
    const r = templates.createTemplateShell({
      root,
      fields: fields({
        slug: 'onb-fixed',
        title_text: 'Bride in One Pot',
        allow_titleless: 'true',
      }),
    });
    expect(r.error).toBeUndefined();
    expect(templates.loadThemes(templates.themesPathFor(root))['onb-fixed'].title_lines).toEqual([
      'Bride in One Pot',
    ]);
  });
});

describe('POST /api/admin/templates/:key/settings — title over HTTP', () => {
  let templates;
  let server;
  let base;
  let root;

  const ownerThemes = () =>
    JSON.parse(
      fs.readFileSync(path.join(process.env.DATA_DIR, 'templates', 'themes.json'), 'utf8')
    );

  beforeAll(async () => {
    root = makeScaffold();
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-title-data-'));
    process.env.GENERATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-title-gen-'));
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.TEMPLATE_ROOT = root;
    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'templates.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    templates = require(path.join(serverDir, 'templates.js'));
    const app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
    // A template broken exactly like the reported one.
    templates.createTemplateShell({
      root,
      fields: {
        slug: 'http-fix',
        display_he: 'יום הולדת',
        title_text: "'s Birthday",
        allow_titleless: 'true',
        name_form: 'english',
      },
    });
  });

  afterAll(() => {
    if (server) server.close();
  });

  const patch = (body) =>
    fetch(base + '/api/admin/templates/http-fix/settings?key=' + ADMIN_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('403 without the admin key', async () => {
    const res = await fetch(base + '/api/admin/templates/http-fix/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title_lines: ['{NAME}'] }),
    });
    expect(res.status).toBe(403);
  });

  it('the status list reports the current title', async () => {
    const res = await fetch(base + '/api/admin/templates?key=' + ADMIN_KEY);
    const body = await res.json();
    const t = body.templates.find((x) => x.key === 'http-fix');
    expect(t.title_lines).toEqual(["'s Birthday"]);
  });

  it('saves a repaired title and it lands in the OWNER store the generator reads', async () => {
    const res = await patch({ title_lines: ["{NAME}'S", 'BIRTHDAY'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.settings.title_lines).toEqual(["{NAME}'S", 'BIRTHDAY']);
    // The overlay entry config.load_themes() merges on top of the shipped file.
    expect(ownerThemes()['http-fix'].title_lines).toEqual(["{NAME}'S", 'BIRTHDAY']);
    expect(ownerThemes()['http-fix'].title_text).toBe("{NAME}'S\nBIRTHDAY");
  });

  it('400 + titleless:true when {NAME} is dropped, 200 once confirmed', async () => {
    const blocked = await patch({ title_lines: ['NO NAME HERE'] });
    expect(blocked.status).toBe(400);
    const body = await blocked.json();
    // The client uses this flag to offer a confirmation instead of a dead end.
    expect(body.titleless).toBe(true);
    expect(ownerThemes()['http-fix'].title_lines).toEqual(["{NAME}'S", 'BIRTHDAY']);

    const ok = await patch({ title_lines: ['NO NAME HERE'], allow_titleless: true });
    expect(ok.status).toBe(200);
    expect(ownerThemes()['http-fix'].title_lines).toEqual(['NO NAME HERE']);
  });

  it('400 (and NOT titleless) on a placeholder/extra_fields mismatch', async () => {
    const res = await patch({ title_lines: ['{NAME} {YEARS}'], allow_titleless: true });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/\{YEARS\}/);
    // Not something a confirmation can wave through — the field must be declared.
    expect(body.titleless).toBeUndefined();
  });
});
