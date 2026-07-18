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
// Optional extra CLEAN-only board variant for the chasers (drinking-game) add-on,
// saved as clean/board-chasers.svg. Additive: a template without it is unchanged
// and orders with chasers on fall back to the normal board.
const CHASERS_BOARD_FIELD = 'clean_board_chasers';
const CHASERS_BOARD_FILE = 'board-chasers.svg';
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
  writeThemesFile(themesPath, themes);
  return entry;
}

// Atomically write the whole themes mapping back (temp file in the same dir, then
// rename) so a crash mid-write can never leave a truncated themes.json. Preserves
// the file's 1-space indent so the diff against the hand-maintained file stays
// minimal. Shared by appendThemeEntry (onboarding) + renameTemplate/replaceAsset.
// After the rename it refreshes the loadThemesCached() cache to the just-written
// mapping so the hot public GET /api/design-names sees a rename immediately
// without re-reading disk.
function writeThemesFile(themesPath, themes) {
  const dir = path.dirname(themesPath);
  const tmp = path.join(dir, `.themes.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(themes, null, 1) + '\n', 'utf8');
  fs.renameSync(tmp, themesPath);
  try {
    _themesCache.set(themesPath, { mtimeMs: fs.statSync(themesPath).mtimeMs, themes });
  } catch {
    _themesCache.delete(themesPath);
  }
}

// mtime-keyed parse cache for themes.json, so a hot READ-ONLY caller (the public
// GET /api/design-names, hit on every products.html + product.html load) doesn't
// re-read + re-parse the file on every request. Keyed by path so a test root and
// the real root never collide. Invalidated implicitly by an mtime change (an
// external write, e.g. a test) and explicitly by writeThemesFile (our own writes).
// The MUTATING paths (renameTemplate/appendThemeEntry/replaceAsset) deliberately
// keep using the uncached loadThemes() so they always read fresh disk state before
// mutating — the cache is a read-side optimization only.
const _themesCache = new Map();
function loadThemesCached(themesPath) {
  let st;
  try {
    st = fs.statSync(themesPath);
  } catch {
    return loadThemes(themesPath); // missing file: fall through to the {} path
  }
  const cached = _themesCache.get(themesPath);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.themes;
  const themes = loadThemes(themesPath);
  _themesCache.set(themesPath, { mtimeMs: st.mtimeMs, themes });
  return themes;
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
  // Optional chasers board variant (clean only). Written only when supplied so a
  // template without it stays exactly as before.
  if (clean.board_chasers) {
    fs.writeFileSync(path.join(dir, 'clean', CHASERS_BOARD_FILE), clean.board_chasers);
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

// Best-effort: downsample raster images embedded in an uploaded SVG so an
// image-heavy Canva export (each photo baked in as a full-res base64 blob)
// doesn't blow past the upload limit and stays light on disk / at render time.
// Shells out to generator/shrink_svg_images.py (Python + Pillow, already in the
// image) the same way runRecipeDiff does. Skips vector-only or already-small
// SVGs, and returns the ORIGINAL buffer on ANY failure — a missing/broken Python
// must never block an upload. Deterministic, so a clean/filled pair that shares a
// background still diffs to zero there (recipe_diff stays reliable). `runner` is
// injectable for tests.
const SHRINK_MIN_BYTES = Number(process.env.TEMPLATE_IMAGE_SHRINK_MIN_BYTES || 300 * 1024);
function shrinkSvgImages(buf, { root = REPO_ROOT, pythonBin = 'python3', runner } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < SHRINK_MIN_BYTES) return buf;
  if (!buf.includes('data:image/')) return buf; // nothing to shrink
  const script = path.join(root, 'generator', 'shrink_svg_images.py');
  try {
    const run = runner || spawnSync;
    const result = run(pythonBin, [script], {
      input: buf,
      timeout: 120000,
      maxBuffer: 512 * 1024 * 1024,
    });
    const out = result && result.status === 0 ? result.stdout : null;
    const outBuf = Buffer.isBuffer(out) ? out : out != null ? Buffer.from(out) : null;
    // Accept only a smaller, still-SVG-looking result; otherwise keep the original.
    if (outBuf && outBuf.length > 0 && outBuf.length < buf.length && looksLikeSvg(outBuf)) {
      return outBuf;
    }
  } catch {
    // fall through to the original buffer
  }
  return buf;
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
  // Optional: a chasers board variant (clean SVG only). Accepted when supplied and
  // it looks like an SVG; absent is fine (feature is additive).
  const cbc = files && files[CHASERS_BOARD_FIELD];
  if (cbc && cbc.data && cbc.data.length) {
    if (!looksLikeSvg(cbc.data)) {
      return { error: 'chasers board does not look like an SVG' };
    }
    clean.board_chasers = cbc.data;
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

  // Shrink oversized embedded images BEFORE writing, so both the stored files and
  // the recipe_diff (which reads the written fronts) use the lightened SVGs.
  // Best-effort per file; unless disabled with shrinkImages:false (pure-write test).
  if (opts.shrinkImages !== false) {
    const sh = (b) =>
      shrinkSvgImages(b, { root, pythonBin: opts.pythonBin, runner: opts.shrinkRunner });
    for (const role of SVG_ROLES) {
      norm.clean[role] = sh(norm.clean[role]);
      norm.filled[role] = sh(norm.filled[role]);
    }
    if (norm.clean.board_chasers) norm.clean.board_chasers = sh(norm.clean.board_chasers);
  }

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

// -- Full template editing (status / rename / single-asset replace) ------------
// These power the admin "template status" view: list each template's asset
// checklist (present/missing, incl. the OPTIONAL chasers board), rename the
// human display label WITHOUT touching the stable slug/key/dir, and replace any
// single asset file in place (whitelisted role -> fixed path, so no traversal and
// the other onboarded assets are never disturbed).

// Longest allowed display label (display_he). A generous cap that still rejects
// pathological input.
const MAX_DISPLAY_NAME = 80;

// The per-template asset roles the admin can inspect + replace, in display order.
// Each role has a STABLE id used by the replace API (whitelisted — an unknown or
// traversing role id is rejected), a fixed on-disk path relative to the template
// dir, the file kind (svg|font) for validation, whether it is optional, and a
// Hebrew label. The chasers board is the one OPTIONAL role, called out so the UI
// can surface its present/missing state at a glance.
const SVG_ASSET_ROLES = [
  {
    role: 'clean-fronts',
    rel: 'clean/fronts.svg',
    kind: 'svg',
    optional: false,
    label: 'קלף קדמי (נקי)',
  },
  {
    role: 'clean-backs',
    rel: 'clean/backs.svg',
    kind: 'svg',
    optional: false,
    label: 'גב קלף (נקי)',
  },
  { role: 'clean-board', rel: 'clean/board.svg', kind: 'svg', optional: false, label: 'לוח (נקי)' },
  {
    role: 'clean-board-chasers',
    rel: 'clean/' + CHASERS_BOARD_FILE,
    kind: 'svg',
    optional: true,
    label: 'לוח צ׳ייסרים (נקי)',
  },
  {
    role: 'filled-fronts',
    rel: 'filled/fronts.svg',
    kind: 'svg',
    optional: false,
    label: 'קלף קדמי (ממולא)',
  },
  {
    role: 'filled-backs',
    rel: 'filled/backs.svg',
    kind: 'svg',
    optional: false,
    label: 'גב קלף (ממולא)',
  },
  {
    role: 'filled-board',
    rel: 'filled/board.svg',
    kind: 'svg',
    optional: false,
    label: 'לוח (ממולא)',
  },
];
// Font roles resolve their path from the theme entry (the filename the generator
// reads out of themes.json), so their `rel` is computed per-entry, not fixed.
const FONT_ASSET_ROLES = [
  { role: 'title-font', field: 'title_font', kind: 'font', optional: false, label: 'פונט כותרת' },
  { role: 'word-font', field: 'word_font', kind: 'font', optional: false, label: 'פונט מילים' },
];
// Whitelist of replaceable role ids — the ONLY roles the replace API accepts.
const REPLACEABLE_ROLES = new Set([...SVG_ASSET_ROLES, ...FONT_ASSET_ROLES].map((a) => a.role));

// The absolute templates base dir (resources/canva/templates), fully resolved.
function templatesBaseDir(root) {
  return path.resolve(path.join(root, 'resources', 'canva', 'templates'));
}

// Resolve a theme's on-disk dir, CONFINED to the templates base. The dir comes
// from the (trusted) themes.json entry, but we still resolve + assert it is the
// base itself or a child of it, so a doctored `dir`/key can never escape. Returns
// the absolute path, or null when it would fall outside the base.
function resolveTemplateDir(root, entry, key) {
  const base = templatesBaseDir(root);
  const rel =
    entry && entry.dir
      ? String(entry.dir)
      : path.join('resources', 'canva', 'templates', String(key || ''));
  const abs = path.resolve(root, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// A safe file basename: no path separators, no traversal. Returns null on junk.
function safeBasename(name) {
  const b = path.basename(String(name || ''));
  if (!b || b === '.' || b === '..' || b.includes('/') || b.includes('\\')) return null;
  return b;
}

// The full asset-role list for a specific theme entry, with font `rel` resolved
// from the recorded filename (null when no font is on record yet).
function assetRolesFor(entry) {
  const svg = SVG_ASSET_ROLES.map((a) => ({ ...a }));
  const fonts = FONT_ASSET_ROLES.map((a) => {
    const name = entry && entry[a.field] ? safeBasename(entry[a.field]) : null;
    return {
      role: a.role,
      field: a.field,
      kind: a.kind,
      optional: a.optional,
      label: a.label,
      rel: name ? 'fonts/' + name : null,
      fontName: name,
    };
  });
  return [...svg, ...fonts];
}

// Validate a font by CONTENT, never by the uploaded filename. A junk/corrupt file
// named Title.ttf would otherwise overwrite the real font the generator reads and
// break every PDF for that template. Accept only a recognizable sfnt magic in the
// first 4 bytes: 0x00010000 (TrueType), 'OTTO' (CFF/OpenType), 'true'/'ttcf'
// (TrueType/collection variants). The check runs BEFORE any write, so a rejected
// upload leaves the existing font untouched.
function looksLikeFont(buf) {
  if (!buf || buf.length < 4) return false;
  const sig = buf.slice(0, 4).toString('latin1');
  if (sig === 'OTTO' || sig === 'true' || sig === 'ttcf') return true;
  return buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00;
}

// Own-property theme lookup that is SAFE against prototype pollution. A raw
// `themes[key]` guard treats keys like `__proto__` / `constructor` as truthy
// (they resolve up the prototype chain), which would let a later `themes[key].x =`
// assignment mutate Object.prototype process-wide. Reject those keys outright and
// require an OWN enumerable property. Returns the entry or null.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function ownTheme(themes, key) {
  if (typeof key !== 'string' || !key || DANGEROUS_KEYS.has(key)) return null;
  if (!Object.prototype.hasOwnProperty.call(themes, key)) return null;
  return themes[key];
}

// Compute one template's asset checklist: which files are present vs missing,
// flagging the OPTIONAL chasers board separately. Returns a plain descriptor
// (safe to serialize to the admin UI).
function computeTemplateStatus(root, key, entry) {
  const dir = resolveTemplateDir(root, entry, key);
  const roles = assetRolesFor(entry);
  const assets = roles.map((a) => ({
    role: a.role,
    label: a.label,
    rel: a.rel,
    kind: a.kind,
    optional: !!a.optional,
    present: !!(dir && a.rel && fs.existsSync(path.join(dir, a.rel))),
  }));
  const missingRequired = assets.filter((a) => !a.optional && !a.present).map((a) => a.role);
  const chasers = assets.find((a) => a.role === 'clean-board-chasers');
  return {
    key,
    slug: (entry && entry.slug) || key,
    display_he: (entry && entry.display_he) || key,
    dir: (entry && entry.dir) || 'resources/canva/templates/' + key,
    visibility: (entry && entry.visibility) || 'public',
    calibrated: !!(entry && entry.calibrated),
    assets,
    chasersBoard: !!(chasers && chasers.present),
    complete: missingRequired.length === 0,
    missingRequired,
  };
}

// The status of EVERY registered template, in themes.json order.
function listTemplateStatuses(root) {
  const themes = loadThemes(themesPathFor(root));
  return Object.keys(themes).map((key) => computeTemplateStatus(root, key, themes[key]));
}

// Validate + normalize a display label: non-empty after trim, within the length
// cap. Returns { value } or { error }.
function validateDisplayName(name) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) return { error: 'display name is required' };
  if (trimmed.length > MAX_DISPLAY_NAME) {
    return { error: 'display name too long (max ' + MAX_DISPLAY_NAME + ' chars)' };
  }
  return { value: trimmed };
}

// Rename a template's HUMAN LABEL only (display_he). The slug/key/dir/recipe —
// the identity stored orders reference — are deliberately left untouched, so a
// rename never breaks an existing order that resolved to this theme. Atomic
// themes.json write. Returns { key, display_he, slug } or { error, httpStatus }.
function renameTemplate({ root, key, displayName }) {
  const themesPath = themesPathFor(root);
  const themes = loadThemes(themesPath);
  const entry = ownTheme(themes, key);
  if (!entry) return { error: 'template not found', httpStatus: 404 };
  const v = validateDisplayName(displayName);
  if (v.error) return { error: v.error, httpStatus: 400 };
  entry.display_he = v.value;
  writeThemesFile(themesPath, themes);
  return { key, display_he: v.value, slug: entry.slug || key };
}

// Build the PUBLIC { <designId>: displayName } map the storefront uses to show a
// current, owner-renamable name. Each orderable design (from site/js/designs.js,
// passed in as [{ id, theme }]) is resolved to its generator theme, and that
// theme's current themes.json `display_he` becomes the design's display name —
// so an admin "rename template" (which edits display_he) propagates to
// products.html / the product page without a rebuild. This is the slug↔product-id
// BRIDGE: designs carry `theme` (the themes.json key), so no separate mapping is
// needed. A design whose theme is unmapped, missing, or has no `display_he` is
// OMITTED (the page keeps its built-in catalog name). Pure (no fs/network) and
// exposes ONLY names — never any other theme field — so it is safe to serialize
// to any visitor and trivial to unit-test. `ownTheme` guards the theme lookup
// against prototype-pollution keys.
function designDisplayNames(themes, designs) {
  const out = {};
  if (!themes || typeof themes !== 'object') return out;
  const list = Array.isArray(designs) ? designs : [];
  for (const d of list) {
    if (!d || typeof d.id !== 'string' || typeof d.theme !== 'string') continue;
    const entry = ownTheme(themes, d.theme);
    const name = entry && typeof entry.display_he === 'string' ? entry.display_he.trim() : '';
    if (name) out[d.id] = name;
  }
  return out;
}

// Replace a SINGLE asset file of an existing template in place. The role must be
// on the whitelist (so the write target is a fixed path inside the template dir —
// no traversal, and the other onboarded assets are untouched). SVG roles are
// SVG-validated; font roles are validated by sfnt magic. Content validation runs
// BEFORE any write, so a rejected upload never overwrites the existing asset.
// On a CALIBRATED template, replacing an SVG ROLE requires an explicit `force`
// confirmation: the theme's title/word geometry was calibrated against the
// current art, so swapping the art may misalign the print — the admin must verify
// the proof and confirm. A non-calibrated template replaces freely.
// For a font role with no filename on record, the uploaded basename is used and
// recorded in themes.json so the generator can find it.
// Returns { key, role, path } or { error, httpStatus, ... }.
function replaceAsset({ root, key, role, file, force = false }) {
  const themesPath = themesPathFor(root);
  const themes = loadThemes(themesPath);
  const entry = ownTheme(themes, key);
  if (!entry) return { error: 'template not found', httpStatus: 404 };
  if (!REPLACEABLE_ROLES.has(role))
    return { error: 'unknown asset role: ' + role, httpStatus: 400 };
  if (!file || !file.data || !file.data.length)
    return { error: 'no file uploaded', httpStatus: 400 };

  const dir = resolveTemplateDir(root, entry, key);
  if (!dir) return { error: 'template directory is outside the templates root', httpStatus: 400 };

  // Role is whitelisted, so assetRolesFor always yields its spec (single source of
  // truth for the path + kind — no divergent fallback).
  const spec = assetRolesFor(entry).find((a) => a.role === role);
  const kind = spec.kind;

  // Validate the bytes against the role's kind — same posture as onboarding.
  if (kind === 'svg') {
    if (!looksLikeSvg(file.data))
      return { error: 'file does not look like an SVG', httpStatus: 400 };
  } else if (kind === 'font') {
    if (!looksLikeFont(file.data)) {
      return { error: 'file does not look like a font (.ttf/.otf)', httpStatus: 400 };
    }
  }

  // Resolve the destination path. SVG roles have a fixed rel; a font role writes
  // to the recorded filename (the exact path the generator reads) when present,
  // else to the uploaded basename which we then record.
  let rel = spec.rel;
  let recordFontField = null;
  if (kind === 'font' && !rel) {
    const name = safeBasename(file.filename);
    if (!name) return { error: 'font filename is missing or unsafe', httpStatus: 400 };
    rel = 'fonts/' + name;
    recordFontField = spec.field;
  }

  const abs = path.resolve(dir, rel);
  // Defense in depth: the resolved target must stay inside the template dir.
  if (abs !== dir && !abs.startsWith(dir + path.sep)) {
    return { error: 'refusing to write outside the template directory', httpStatus: 400 };
  }

  // Calibration guard: this template's title/word slots were hand-calibrated
  // against its current art, so REPLACING existing svg-role art may misalign the
  // print. Rather than brittly parse + compare viewBoxes (single vs double
  // quotes, rounding, bytes past a scan window — any of which silently defeats a
  // geometric check), we simply REQUIRE an explicit confirmation: block the swap
  // (409) and make the admin re-upload with `force` after verifying the proof. A
  // non-calibrated template has no geometry to protect, and a FIRST-TIME add (no
  // current file at this role, e.g. a fresh chasers board) isn't replacing
  // anything — both write freely.
  if (kind === 'svg' && entry.calibrated && !force && fs.existsSync(abs)) {
    return {
      error:
        'this template is calibrated — replacing its art may misalign the title/word slots. ' +
        'Verify the proof before sending to a customer, then re-upload with force to confirm.',
      httpStatus: 409,
      calibrationWarning: true,
    };
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, file.data);

  // A newly-named font needs its filename recorded so the generator finds it.
  if (recordFontField) {
    entry[recordFontField] = path.basename(abs);
    writeThemesFile(themesPath, themes);
  }
  return { key, role, path: path.relative(root, abs) };
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
  loadThemesCached,
  writeTemplateFiles,
  runRecipeDiff,
  shrinkSvgImages,
  normalizeOnboarding,
  onboardTemplate,
  parseMultipart,
  boundaryFromContentType,
  templateDir,
  themesPathFor,
  writeThemesFile,
  looksLikeSvg,
  looksLikeFont,
  ownTheme,
  MAX_DISPLAY_NAME,
  REPLACEABLE_ROLES,
  assetRolesFor,
  resolveTemplateDir,
  computeTemplateStatus,
  listTemplateStatuses,
  validateDisplayName,
  renameTemplate,
  replaceAsset,
  designDisplayNames,
};
