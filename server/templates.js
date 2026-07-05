// Admin template onboarding: take the SVGs + fonts + a few text fields for a
// NEW private design and make it generatable — write the files into
// resources/canva/templates/<slug>/, auto-detect the recipe with
// generator/recipe_diff.py, and append a `visibility:"private"`,
// `calibrated:false` entry to generator/themes.json.
//
// The write + themes.json-append logic is factored into small pure-ish functions
// (no network, only fs) so it is trivially unit-testable; recipe detection shells
// out to the Python generator (needs Chrome + Pillow) and is best-effort — a new
// template is registered even if the recipe step can't run in this environment.
// A freshly onboarded template ALWAYS comes in uncalibrated: title_style/board/
// back are null and calibrated:false, so it still needs a hand-tuned style pass
// (mirroring how the shipped themes were calibrated) before it renders.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

// A filesystem-safe slug + themes.json key: lowercase ascii letters/digits in
// hyphen-separated groups, 1–64 chars. No slashes/dots/spaces, so it can never
// traverse out of the templates dir or collide with a path separator.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function isSafeSlug(slug) {
  return typeof slug === 'string' && slug.length >= 1 && slug.length <= 64 && SLUG_RE.test(slug);
}

// The name-casing rules a theme can use (matches config.py's _form_name).
const NAME_FORMS = ['hebrew', 'english', 'english-caps'];
// The three SVG roles every template ships, for both the clean + filled pages.
const SVG_ROLES = ['fronts', 'backs', 'board'];
// The two font roles the onboarding form uploads.
const FONT_ROLES = ['title', 'word'];

function templateDir(root, slug) {
  return path.join(root, 'resources', 'canva', 'templates', slug);
}
function themesPathFor(root) {
  return path.join(root, 'generator', 'themes.json');
}
function recipesDirFor(root) {
  return path.join(root, 'generator', 'recipes');
}

// A basic sanity check that an uploaded buffer looks like an SVG document.
function looksLikeSvg(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.slice(0, 400).toString('utf8').toLowerCase();
  return head.includes('<svg') || head.includes('<?xml');
}

// Read the themes mapping (key -> config) from a themes.json path. Returns {}
// only when the file is genuinely absent or empty (a first-ever onboarding). A
// file that EXISTS with content but won't parse is CORRUPT — we THROW rather than
// return {}, because swallowing the error here would let appendThemeEntry write
// back a single entry and destroy every existing theme.
function loadThemes(themesPath) {
  let raw;
  try {
    raw = fs.readFileSync(themesPath, 'utf8');
  } catch {
    return {}; // missing file -> no themes yet
  }
  if (!raw.trim()) return {}; // present but empty/whitespace -> no themes yet
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      'themes.json exists but is unparseable — refusing to touch it (would wipe ' +
        'existing themes): ' +
        ((e && e.message) || e)
    );
  }
}

// Build the themes.json entry for a newly uploaded PRIVATE template. It is always
// uncalibrated: title_style/board/back are null and calibrated:false — a later
// hand-tuning pass fills those in and flips calibrated to true.
function buildThemeEntry({
  slug,
  displayHe,
  titleText,
  titleFont,
  wordFont,
  language,
  nameForm,
  extraFields,
}) {
  const lines = String(titleText || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    slug,
    display_he: displayHe || slug,
    dir: 'resources/canva/templates/' + slug,
    recipe: slug,
    visibility: 'private',
    title_text: titleText || '',
    title_lines: lines.length ? lines : [titleText || ''],
    language: language || (nameForm === 'hebrew' ? 'hebrew' : 'english'),
    name_form: nameForm,
    extra_fields: Array.isArray(extraFields) ? extraFields : [],
    title_font: titleFont,
    word_font: wordFont,
    // Left for the calibration pass — the template is not renderable until these
    // are hand-tuned and `calibrated` is set true.
    title_style: null,
    board: null,
    back: null,
    calibrated: false,
  };
}

// Append one entry to themes.json under `key`. Throws when the key is already
// taken (never silently overwrites a shipped theme), and refuses to write when
// the loaded mapping is empty — the shipped themes.json always has entries, so an
// empty load means the file is missing/corrupt and writing a lone entry would
// destroy it. The write is ATOMIC (temp file in the same dir, then rename) so a
// crash mid-write can never leave a truncated themes.json. Preserves the file's
// 1-space indent so the diff against the hand-maintained file stays minimal.
function appendThemeEntry(themesPath, key, entry) {
  const themes = loadThemes(themesPath);
  if (themes[key]) throw new Error('theme already registered: ' + key);
  if (!themes || Object.keys(themes).length === 0) {
    throw new Error(
      'refusing to write themes.json: loaded mapping is empty (missing/corrupt file)'
    );
  }
  themes[key] = entry;
  const dir = path.dirname(themesPath);
  const tmp = path.join(dir, `.themes.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(themes, null, 1) + '\n', 'utf8');
  fs.renameSync(tmp, themesPath);
  return entry;
}

// Write the uploaded SVGs + fonts into resources/canva/templates/<slug>/.
//   clean/filled: { fronts, backs, board } -> Buffers
//   fonts: { title: {name, data}, word: {name, data} }
// Returns { dir, fonts: { title: <filename>, word: <filename> } }.
function writeTemplateFiles({ root, slug, clean, filled, fonts }) {
  const dir = templateDir(root, slug);
  for (const sub of ['clean', 'filled', 'fonts']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  for (const role of SVG_ROLES) {
    if (clean[role]) fs.writeFileSync(path.join(dir, 'clean', role + '.svg'), clean[role]);
    if (filled[role]) fs.writeFileSync(path.join(dir, 'filled', role + '.svg'), filled[role]);
  }
  const written = {};
  for (const role of FONT_ROLES) {
    const f = fonts && fonts[role];
    if (f && f.name && f.data) {
      // Keep only the basename of the uploaded filename (never a path).
      const name = path.basename(String(f.name));
      fs.writeFileSync(path.join(dir, 'fonts', name), f.data);
      written[role] = name;
    }
  }
  return { dir, fonts: written };
}

// Best-effort recipe auto-detection: run generator/recipe_diff.py on the filled
// vs clean fronts pair, which writes generator/recipes/<slug>.json. Needs Chrome
// + Pillow; on any failure we return {ok:false} and the caller flags it (the
// template is still registered). `pythonBin` + `runner` are injectable for tests.
function runRecipeDiff({ root, slug, pythonBin = 'python3', timeoutMs = 120000, runner }) {
  const script = path.join(root, 'generator', 'recipe_diff.py');
  const filled = path.join(templateDir(root, slug), 'filled', 'fronts.svg');
  const clean = path.join(templateDir(root, slug), 'clean', 'fronts.svg');
  const out = path.join(recipesDirFor(root), slug + '.json');
  const args = [script, filled, clean, slug];
  let result;
  try {
    const run = runner || spawnSync;
    result = run(pythonBin, args, { cwd: root, timeout: timeoutMs, encoding: 'utf8' });
  } catch (e) {
    return { ok: false, recipe: out, detail: String((e && e.message) || e) };
  }
  const ok = !!result && result.status === 0 && fs.existsSync(out);
  return {
    ok,
    recipe: out,
    detail: ok
      ? null
      : String((result && (result.stderr || result.stdout)) || 'recipe failed').slice(0, 800),
  };
}

// Validate + collect the parsed fields/files for onboarding. Returns
// { error } on the first problem, or a normalized descriptor on success.
function normalizeOnboarding({ root, fields, files }) {
  const slug = String((fields && fields.slug) || '').trim();
  if (!isSafeSlug(slug)) {
    return { error: 'invalid slug: use lowercase letters, digits and hyphens (a-z, 0-9, -)' };
  }
  const themesPath = themesPathFor(root);
  if (loadThemes(themesPath)[slug]) return { error: 'a template with this slug already exists' };
  if (fs.existsSync(templateDir(root, slug))) {
    return { error: 'a template directory with this slug already exists' };
  }

  const displayHe = String((fields && fields.display_he) || '').trim();
  if (!displayHe) return { error: 'display_he (Hebrew name) is required' };
  const titleText = String((fields && fields.title_text) || '').trim();
  if (!titleText) return { error: 'title_text is required' };
  const nameForm = String((fields && fields.name_form) || '').trim();
  if (!NAME_FORMS.includes(nameForm)) {
    return { error: 'name_form must be one of: ' + NAME_FORMS.join(', ') };
  }
  const language =
    String((fields && fields.language) || '').trim() ||
    (nameForm === 'hebrew' ? 'hebrew' : 'english');
  // extra_fields: comma/whitespace separated tokens (e.g. "AGE" or "YEARS,NAME1,NAME2").
  const extraFields = String((fields && fields.extra_fields) || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Required uploads: clean + filled {fronts,backs,board} SVGs and both fonts.
  const clean = {};
  const filled = {};
  for (const role of SVG_ROLES) {
    const cf = files && files['clean_' + role];
    const ff = files && files['filled_' + role];
    if (!cf || !cf.data || !cf.data.length) return { error: 'missing clean ' + role + ' SVG' };
    if (!ff || !ff.data || !ff.data.length) return { error: 'missing filled ' + role + ' SVG' };
    if (!looksLikeSvg(cf.data)) return { error: 'clean ' + role + ' does not look like an SVG' };
    if (!looksLikeSvg(ff.data)) return { error: 'filled ' + role + ' does not look like an SVG' };
    clean[role] = cf.data;
    filled[role] = ff.data;
  }
  const titleFontFile = files && files.title_font;
  const wordFontFile = files && files.word_font;
  if (!titleFontFile || !titleFontFile.data || !titleFontFile.data.length) {
    return { error: 'missing title font file' };
  }
  if (!wordFontFile || !wordFontFile.data || !wordFontFile.data.length) {
    return { error: 'missing word font file' };
  }

  return {
    slug,
    displayHe,
    titleText,
    nameForm,
    language,
    extraFields,
    clean,
    filled,
    fonts: {
      title: { name: titleFontFile.filename, data: titleFontFile.data },
      word: { name: wordFontFile.filename, data: wordFontFile.data },
    },
  };
}

// Orchestrate onboarding: validate -> write files -> append themes.json entry ->
// best-effort recipe detection. Returns { error } (with an httpStatus) on a bad
// request, or { key, calibrated:false, recipe, note, theme } on success.
// `runRecipe:false` skips the Python step (used by the pure write-logic test).
function onboardTemplate(opts) {
  const root = opts.root || REPO_ROOT;
  const norm = normalizeOnboarding({ root, fields: opts.fields, files: opts.files });
  if (norm.error) return { error: norm.error, httpStatus: 400 };

  const written = writeTemplateFiles({
    root,
    slug: norm.slug,
    clean: norm.clean,
    filled: norm.filled,
    fonts: norm.fonts,
  });

  const entry = buildThemeEntry({
    slug: norm.slug,
    displayHe: norm.displayHe,
    titleText: norm.titleText,
    titleFont: written.fonts.title,
    wordFont: written.fonts.word,
    language: norm.language,
    nameForm: norm.nameForm,
    extraFields: norm.extraFields,
  });
  appendThemeEntry(themesPathFor(root), norm.slug, entry);

  let recipe = { ok: false, skipped: true };
  if (opts.runRecipe !== false) {
    recipe = runRecipeDiff({
      root,
      slug: norm.slug,
      pythonBin: opts.pythonBin,
      timeoutMs: opts.recipeTimeoutMs,
      runner: opts.recipeRunner,
    });
  }

  const note = recipe.ok
    ? 'Template registered as PRIVATE and UNCALIBRATED. A title-style calibration pass ' +
      '(fill title_style/board/back in themes.json and set calibrated:true) is still ' +
      'needed before it can render.'
    : 'Template registered as PRIVATE and UNCALIBRATED, but recipe auto-detection did not ' +
      'run/succeed here — run `python3 generator/recipe_diff.py filled/fronts.svg clean/fronts.svg ' +
      norm.slug +
      '` on a machine with Chrome + Pillow, then calibrate the title style.';

  return {
    key: norm.slug,
    dir: 'resources/canva/templates/' + norm.slug,
    calibrated: false,
    visibility: 'private',
    recipe: recipe.ok ? 'generated' : recipe.skipped ? 'skipped' : 'failed',
    recipe_detail: recipe.ok ? null : recipe.detail || null,
    note,
    theme: entry,
  };
}

// -- Minimal multipart/form-data parser (no external dependency) --------------
// Splits a raw body Buffer on the boundary and returns { fields, files }, where
// fields[name] = string and files[name] = { filename, data:Buffer }. Kept small
// and self-contained so the server needs no multer/busboy dependency.
function parseMultipart(buf, boundary) {
  const fields = {};
  const files = {};
  if (!Buffer.isBuffer(buf) || !boundary) return { fields, files };
  const delimiter = Buffer.from('--' + boundary);
  let idx = buf.indexOf(delimiter);
  if (idx < 0) return { fields, files };
  idx += delimiter.length;
  while (idx < buf.length) {
    // "--" right after a boundary marks the end of the stream.
    if (buf[idx] === 0x2d && buf[idx + 1] === 0x2d) break;
    if (buf[idx] === 0x0d && buf[idx + 1] === 0x0a) idx += 2; // skip CRLF
    let next = buf.indexOf(delimiter, idx);
    if (next < 0) next = buf.length;
    let partEnd = next;
    if (buf[partEnd - 2] === 0x0d && buf[partEnd - 1] === 0x0a) partEnd -= 2; // trailing CRLF
    const part = buf.slice(idx, partEnd);
    const sep = part.indexOf('\r\n\r\n');
    if (sep >= 0) {
      const headerStr = part.slice(0, sep).toString('utf8');
      const body = part.slice(sep + 4);
      const nameM = /name="([^"]*)"/i.exec(headerStr);
      const fileM = /filename="([^"]*)"/i.exec(headerStr);
      if (nameM) {
        if (fileM) files[nameM[1]] = { filename: fileM[1], data: body };
        else fields[nameM[1]] = body.toString('utf8');
      }
    }
    idx = next + delimiter.length;
  }
  return { fields, files };
}

// Extract the boundary token from a multipart Content-Type header.
function boundaryFromContentType(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  return m ? (m[1] || m[2]).trim() : null;
}

module.exports = {
  isSafeSlug,
  NAME_FORMS,
  SVG_ROLES,
  buildThemeEntry,
  appendThemeEntry,
  loadThemes,
  writeTemplateFiles,
  runRecipeDiff,
  normalizeOnboarding,
  onboardTemplate,
  parseMultipart,
  boundaryFromContentType,
  templateDir,
  themesPathFor,
};
