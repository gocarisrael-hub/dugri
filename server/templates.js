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
//
// PERSISTENCE (see server/template-store.js): the repo checkout is the Docker
// image in production, whose filesystem resets on every deploy. So this module
// READS THROUGH AN OVERLAY — the image's shipped config as the base, the owner
// store under DATA_DIR/templates on top — and ALWAYS WRITES to the owner store.
// Editing a SHIPPED template is copy-on-write: the edited entry (and, for an
// asset write, a copy of the whole template dir) lands in the owner store and
// shadows the pristine shipped one. With DATA_DIR unset (local dev, unit tests)
// the store is disabled and every path below is the image path, exactly as
// before.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./template-store');

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
// The two name-script languages a theme can require (themes.json `language`).
const LANGUAGES = ['hebrew', 'english'];
// The two storefront visibilities a theme can carry (themes.json `visibility`).
const VISIBILITIES = ['public', 'private'];
// The three SVG roles every template ships, for both the clean + filled pages.
const SVG_ROLES = ['fronts', 'backs', 'board'];
// Optional extra CLEAN-only board variant for the chasers (drinking-game) add-on,
// saved as clean/board-chasers.svg. Additive: a template without it is unchanged
// and orders with chasers on fall back to the normal board.
const CHASERS_BOARD_FIELD = 'clean_board_chasers';
const CHASERS_BOARD_FILE = 'board-chasers.svg';
// The two font roles the onboarding form uploads.
const FONT_ROLES = ['title', 'word'];

// ---- IMAGE (shipped) paths --------------------------------------------------
// These stay exactly what they always were: the read-only base layer. The owner
// store's counterparts live in server/template-store.js, and the resolvers
// further down pick between the two.
function templateDir(root, slug) {
  return path.join(root, 'resources', 'canva', 'templates', slug);
}
function themesPathFor(root) {
  return path.join(root, 'generator', 'themes.json');
}
function recipesDirFor(root) {
  return path.join(root, 'generator', 'recipes');
}

// Theme keys that would collide with the owner store's own layout
// (DATA_DIR/templates/themes.json and .../recipes/), so a template can never be
// registered under one.
const RESERVED_KEYS = new Set(store.RESERVED_KEYS);

// A basic sanity check that an uploaded buffer looks like an SVG document.
function looksLikeSvg(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.slice(0, 400).toString('utf8').toLowerCase();
  return head.includes('<svg') || head.includes('<?xml');
}

// Read ONE themes mapping (key -> config) from a themes.json path, with no
// overlay. Returns {} only when the file is genuinely absent or empty (a
// first-ever onboarding). A file that EXISTS with content but won't parse is
// CORRUPT — we THROW rather than return {}, because swallowing the error here
// would let a write path put back a single entry and destroy every other theme.
function loadThemesFile(themesPath) {
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

// The OWNER theme entries (DATA_DIR/templates/themes.json), or {} when the store
// is disabled / the file doesn't exist yet. Throws on a corrupt owner file for
// the same reason loadThemesFile does.
function loadOwnerThemes() {
  const p = store.ownerThemesPath();
  return p ? loadThemesFile(p) : {};
}

// The MERGED view every reader gets: the image's shipped themes with the owner's
// entries laid over them. A slug present in both means the OWNER entry wins as a
// WHOLE ENTRY (not a deep merge) — that is what makes editing a shipped template
// copy-on-write. With the store disabled this is just the shipped file, byte for
// byte the behaviour this function has always had.
function loadThemes(themesPath) {
  const shipped = loadThemesFile(themesPath);
  const owner = loadOwnerThemes();
  return Object.keys(owner).length ? { ...shipped, ...owner } : shipped;
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
  visibility,
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
    // The owner chooses visibility on upload; default PUBLIC (only an explicit
    // 'private' hides it). Note this is independent of `calibrated`: a fresh
    // template is still uncalibrated and needs a style pass before it renders.
    visibility: visibility === 'private' ? 'private' : 'public',
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

// Append one entry under `key`. Throws when the key is already taken in the
// MERGED view (never silently shadows an existing theme — onboarding is for NEW
// slugs; changing an existing one goes through updateTemplateSettings, which is
// the copy-on-write path). The entry is persisted by persistThemeEntry, i.e. into
// the OWNER store when DATA_DIR is set and into the image's themes.json
// otherwise.
function appendThemeEntry(themesPath, key, entry) {
  const themes = loadThemes(themesPath);
  if (themes[key]) throw new Error('theme already registered: ' + key);
  return persistThemeEntry(themesPath, key, entry);
}

// Persist ONE whole theme entry.
//
// With the owner store ACTIVE the entry goes into DATA_DIR/templates/themes.json
// and nothing in the image is touched — so editing a shipped theme shadows it
// while the shipped file stays pristine, and the shipped file keeps shipping
// updates for every theme the owner has NOT overridden.
//
// With the store DISABLED this is the historical behaviour: rewrite the image's
// themes.json, refusing when the loaded mapping is empty (the shipped file always
// has entries, so an empty load means missing/corrupt and writing a lone entry
// would destroy it). That guard does NOT apply to the owner store, which
// legitimately starts empty.
function persistThemeEntry(themesPath, key, entry) {
  const ownerPath = store.ownerThemesPath();
  if (ownerPath) {
    const owner = loadThemesFile(ownerPath);
    owner[key] = entry;
    writeThemesFile(ownerPath, owner);
    return entry;
  }
  const themes = loadThemesFile(themesPath);
  if (!themes || Object.keys(themes).length === 0) {
    throw new Error(
      'refusing to write themes.json: loaded mapping is empty (missing/corrupt file)'
    );
  }
  themes[key] = entry;
  writeThemesFile(themesPath, themes);
  return entry;
}

// Drop one entry from whichever layer the writes go to. Returns true when
// something was actually removed.
function dropThemeEntry(themesPath, key) {
  const ownerPath = store.ownerThemesPath();
  const target = ownerPath || themesPath;
  const themes = loadThemesFile(target);
  if (!Object.prototype.hasOwnProperty.call(themes, key)) return false;
  delete themes[key];
  writeThemesFile(target, themes);
  return true;
}

// Atomically write a whole themes mapping to `themesPath` (temp file in the same
// dir, then rename) so a crash mid-write can never leave a truncated file.
// Preserves the 1-space indent so the diff against the hand-maintained shipped
// file stays minimal. Creates the parent dir when missing — on a fresh volume the
// owner store does not exist yet. Every write drops the loadThemesCached()
// entries so the hot public GET /api/design-names picks the change up at once
// (the mapping just written is one LAYER, not the merged view, so it cannot be
// installed into the cache directly).
function writeThemesFile(themesPath, themes) {
  const dir = path.dirname(themesPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.themes.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(themes, null, 1) + '\n', 'utf8');
  fs.renameSync(tmp, themesPath);
  _themesCache.clear();
}

// mtime-keyed parse cache for the MERGED themes view, so a hot READ-ONLY caller
// (the public GET /api/design-names, hit on every products.html + product.html
// load) doesn't re-read + re-parse two files on every request. Keyed by the
// shipped path so a test root and the real root never collide, and validated
// against BOTH layers' mtimes — an owner-store write must invalidate it just as a
// shipped-file write does. Invalidated implicitly by an mtime change (an external
// write, e.g. a test) and explicitly by writeThemesFile (our own writes, which
// can land inside the same millisecond).
// The MUTATING paths deliberately keep using the uncached loadThemes()/
// loadThemesFile() so they always read fresh disk state before mutating — the
// cache is a read-side optimization only.
const _themesCache = new Map();
function mtimeOf(p) {
  if (!p) return null;
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}
function loadThemesCached(themesPath) {
  const shippedM = mtimeOf(themesPath);
  const ownerM = mtimeOf(store.ownerThemesPath());
  // Neither layer exists on disk: nothing worth caching, fall through to the {}
  // path (and keep an already-cached entry from masking a later file appearing).
  if (shippedM === null && ownerM === null) return loadThemes(themesPath);
  const cached = _themesCache.get(themesPath);
  if (cached && cached.shippedM === shippedM && cached.ownerM === ownerM) return cached.themes;
  const themes = loadThemes(themesPath);
  _themesCache.set(themesPath, { shippedM, ownerM, themes });
  return themes;
}

// Write the uploaded SVGs + fonts into the template's asset dir — the OWNER store
// (DATA_DIR/templates/<slug>/) when it is active, else the image's
// resources/canva/templates/<slug>/.
//   clean/filled: { fronts, backs, board } -> Buffers
//   fonts: { title: {name, data}, word: {name, data} }
// Returns { dir, fonts: { title: <filename>, word: <filename> } }.
function writeTemplateFiles({ root, slug, clean, filled, fonts }) {
  const dir = templateWriteDir(root, null, slug);
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
// The recipe path is resolved through the overlay too: the Python half writes to
// the OWNER recipes dir when DATA_DIR is set (it inherits the env), so the
// success check accepts a recipe that landed in EITHER layer rather than only
// the image's.
function runRecipeDiff({ root, slug, pythonBin = 'python3', timeoutMs = 120000, runner }) {
  const script = path.join(root, 'generator', 'recipe_diff.py');
  const dir = resolveTemplateDirBySlug(root, slug);
  const filled = path.join(dir, 'filled', 'fronts.svg');
  const clean = path.join(dir, 'clean', 'fronts.svg');
  const out = store.ownerRecipePath(slug) || path.join(recipesDirFor(root), slug + '.json');
  const args = [script, filled, clean, slug];
  let result;
  try {
    const run = runner || spawnSync;
    result = run(pythonBin, args, { cwd: root, timeout: timeoutMs, encoding: 'utf8' });
  } catch (e) {
    return { ok: false, recipe: out, detail: String((e && e.message) || e) };
  }
  const ok = !!result && result.status === 0 && !!resolveRecipePath(root, slug);
  return {
    ok,
    recipe: resolveRecipePath(root, slug) || out,
    detail: ok
      ? null
      : String((result && (result.stderr || result.stdout)) || 'recipe failed').slice(0, 800),
  };
}

// Best-effort CALIBRATION auto-detection: run generator/calibrate.py, which
// measures the title's slot on the board and card back and its paints, and
// returns them as the same blob the admin calibration form edits. Mirrors
// runRecipeDiff — same spawn shape, same best-effort contract: on any failure the
// template is still registered, just with nothing pre-filled.
//
// Detection PROPOSES, a human DISPOSES: the measured values are stored so the
// form opens pre-filled, but `calibrated` is deliberately left false, so nothing
// can be ordered until the owner has looked at the preview and saved. The blob
// also carries per-field `confidence` and `notes`, which the form already renders
// as "check this one" flags — several values (arch, offset, pinned sizes) are not
// measurable at all and are left for the owner by design.
function runCalibrate({ root, slug, pythonBin = 'python3', timeoutMs = 180000, runner }) {
  const script = path.join(root, 'generator', 'calibrate.py');
  const out = path.join(os.tmpdir(), 'dugri-calibrate-' + Date.now() + '.json');
  let result;
  try {
    const run = runner || spawnSync;
    result = run(pythonBin, [script, slug, '--out', out], {
      cwd: root,
      timeout: timeoutMs,
      encoding: 'utf8',
    });
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) };
  }
  if (!result || result.status !== 0 || !fs.existsSync(out)) {
    return {
      ok: false,
      detail: String((result && (result.stderr || result.stdout)) || 'calibrate failed').slice(
        0,
        800
      ),
    };
  }
  try {
    const blob = JSON.parse(fs.readFileSync(out, 'utf8'));
    return { ok: true, blob };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) };
  } finally {
    try {
      fs.unlinkSync(out);
    } catch {
      /* best-effort cleanup */
    }
  }
}

// Merge auto-detected calibration into a theme entry. Only the keys the detector
// actually measured are written — it deliberately OMITS what it cannot measure
// rather than guessing, so an absent key must stay absent instead of being
// written as null and reading like a deliberate "no board title".
// `calibrated` is never touched here.
function applyCalibration(themesPath, key, blob) {
  if (!blob || typeof blob !== 'object') return null;
  const themes = loadThemes(themesPath);
  const entry = themes[key];
  if (!entry) return null;
  const ts = validateTitleStyle(blob.title_style);
  if (!ts.error) entry.title_style = ts.value;
  for (const slot of ['board', 'back']) {
    if (!(slot in blob)) continue;
    const v = validateSlot(blob[slot], slot);
    if (!v.error) entry[slot] = v.value;
  }
  if (typeof blob.word_size === 'number' && blob.word_size > 0) entry.word_size = blob.word_size;
  // Advisory, for the form's "check this one" flags — not render inputs.
  if (blob.confidence && typeof blob.confidence === 'object') entry.confidence = blob.confidence;
  if (Array.isArray(blob.notes)) entry.notes = blob.notes.filter((s) => typeof s === 'string');
  writeThemesFile(themesPath, themes);
  return entry;
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

// Validate the METADATA fields common to onboarding + shell creation (no files).
// Returns { error } on the first problem, or the normalized metadata on success.
// Shared so a full upload and a "create empty template" register identical config.
function normalizeMetadata({ root, fields }) {
  const slug = String((fields && fields.slug) || '').trim();
  if (!isSafeSlug(slug)) {
    return { error: 'invalid slug: use lowercase letters, digits and hyphens (a-z, 0-9, -)' };
  }
  // A slug that collides with the owner store's own layout (recipes/, themes.json)
  // would corrupt it, so it is never registrable.
  if (RESERVED_KEYS.has(slug)) return { error: 'this slug is reserved: ' + slug };
  const themesPath = themesPathFor(root);
  if (loadThemes(themesPath)[slug]) return { error: 'a template with this slug already exists' };
  // A dir in EITHER layer counts — an owner template that lost its themes entry
  // must not be silently overwritten by a new upload.
  if (templateDirExists(root, slug)) {
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
  const extraFields = String((fields && fields.extra_fields) || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const visibility =
    String((fields && fields.visibility) || '').trim() === 'private' ? 'private' : 'public';
  return { slug, displayHe, titleText, nameForm, language, extraFields, visibility };
}

// Validate + collect the parsed fields/files for onboarding. Returns
// { error } on the first problem, or a normalized descriptor on success.
function normalizeOnboarding({ root, fields, files }) {
  const meta = normalizeMetadata({ root, fields });
  if (meta.error) return meta;
  const { slug, displayHe, titleText, nameForm, language, extraFields, visibility } = meta;

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
    visibility,
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
    visibility: norm.visibility,
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

  // Auto-calibration, AFTER the recipe: the card-back slot is measured relative
  // to the card cells the recipe defines, so calibrating first would have nothing
  // to measure against. Only attempted when the recipe succeeded, and never fatal
  // — a template that cannot be measured is still registered, just with an empty
  // form for the owner to fill by hand exactly as before.
  let calibration = { ok: false, skipped: true };
  if (recipe.ok && opts.runCalibrate !== false) {
    calibration = runCalibrate({
      root,
      slug: norm.slug,
      pythonBin: opts.pythonBin,
      timeoutMs: opts.calibrateTimeoutMs,
      runner: opts.calibrateRunner,
    });
    if (calibration.ok) applyCalibration(themesPathFor(root), norm.slug, calibration.blob);
  }

  const visLabel = entry.visibility.toUpperCase();
  const note = !recipe.ok
    ? `Template registered as ${visLabel} and UNCALIBRATED, but recipe auto-detection did not ` +
      'run/succeed here — run `python3 generator/recipe_diff.py filled/fronts.svg clean/fronts.svg ' +
      norm.slug +
      '` on a machine with Chrome + Pillow, then calibrate the title style.'
    : calibration.ok
      ? `Template registered as ${visLabel} and UNCALIBRATED, with the title slot and colours ` +
        'PRE-FILLED from the artwork. Open the calibration panel, check the flagged fields, ' +
        'preview, and save to mark it calibrated.'
      : `Template registered as ${visLabel} and UNCALIBRATED. Auto-calibration did not run/succeed ` +
        'here, so the calibration panel opens empty — fill the title style by hand, preview, and save.';

  return {
    key: norm.slug,
    dir: 'resources/canva/templates/' + norm.slug,
    calibrated: false,
    visibility: entry.visibility,
    recipe: recipe.ok ? 'generated' : recipe.skipped ? 'skipped' : 'failed',
    recipe_detail: recipe.ok ? null : recipe.detail || null,
    calibration: calibration.ok ? 'measured' : calibration.skipped ? 'skipped' : 'failed',
    calibration_detail: calibration.ok ? null : calibration.detail || null,
    note,
    // Re-read: applyCalibration wrote the measured values after `entry` was built.
    theme: loadThemes(themesPathFor(root))[norm.slug] || entry,
  };
}

// Create an EMPTY template shell: register the themes.json entry + the (empty)
// template dir from METADATA ONLY, with NO asset files. This lets the admin add a
// heavy template (Canva SVGs with big embedded rasters) by uploading each asset
// SEPARATELY afterwards via replaceAsset — so no single request has to carry all
// of them at once (past the body-size limit). The fonts are left unrecorded until
// their files are uploaded (replaceAsset records the filename then). Returns
// { key, shell:true, ... } or { error, httpStatus }.
function createTemplateShell({ root, fields }) {
  const meta = normalizeMetadata({ root, fields });
  if (meta.error) return { error: meta.error, httpStatus: 400 };
  const dir = templateWriteDir(root, null, meta.slug);
  for (const sub of ['clean', 'filled', 'fonts']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  const entry = buildThemeEntry({
    slug: meta.slug,
    displayHe: meta.displayHe,
    titleText: meta.titleText,
    titleFont: undefined, // recorded when the font file is uploaded
    wordFont: undefined,
    language: meta.language,
    nameForm: meta.nameForm,
    extraFields: meta.extraFields,
    visibility: meta.visibility,
  });
  appendThemeEntry(themesPathFor(root), meta.slug, entry);
  return {
    key: meta.slug,
    dir: 'resources/canva/templates/' + meta.slug,
    calibrated: false,
    visibility: entry.visibility,
    shell: true,
    theme: entry,
    note:
      `Empty template "${meta.slug}" created (${entry.visibility.toUpperCase()}). Upload each ` +
      'asset (clean/filled fronts, backs, board + both fonts) separately from the template list ' +
      'below, then calibrate.',
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

// Resolve a theme's SHIPPED (image) dir, CONFINED to the templates base. The dir
// comes from the (trusted) themes.json entry — which is how the one shipped theme
// whose folder name differs from its slug ("trip comeback") still resolves — but
// we still assert the result is the base itself or a child of it, so a doctored
// `dir`/key can never escape. Returns the absolute path, or null when it would
// fall outside the base.
function shippedTemplateDir(root, entry, key) {
  const base = templatesBaseDir(root);
  const rel =
    entry && entry.dir
      ? String(entry.dir)
      : path.join('resources', 'canva', 'templates', String(key || ''));
  const abs = path.resolve(root, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// Resolve a theme's asset dir THROUGH THE OVERLAY: the owner store's
// DATA_DIR/templates/<key>/ when that dir exists, else the image's copy.
//
// The owner side is keyed BY THEME KEY, never by the entry's `dir` field — an
// owner-uploaded template's `dir` still reads "resources/canva/templates/<slug>",
// a path that does not exist in the image at all. The generator's Python half
// resolves the same way, from the same key it looks the theme up by.
//
// Whole-dir, not per-file: that is why every asset write copies the shipped dir
// into the store first (see templateWriteDir) — a half-populated owner dir would
// hide the assets it didn't copy.
function resolveTemplateDir(root, entry, key) {
  const owner = store.ownerTemplateDir(key);
  if (owner && fs.existsSync(owner)) return owner;
  return shippedTemplateDir(root, entry, key);
}

// Same resolution from a bare slug (no themes lookup) — for callers that only
// have the key, e.g. the storefront's template-image route.
function resolveTemplateDirBySlug(root, slug) {
  return resolveTemplateDir(root, null, slug);
}

// Does a template dir for this slug exist in EITHER layer?
function templateDirExists(root, slug) {
  const dir = resolveTemplateDirBySlug(root, slug);
  return !!dir && fs.existsSync(dir);
}

// The dir an asset WRITE must land in.
//   store disabled -> the image dir, exactly as before.
//   store active   -> DATA_DIR/templates/<key>/, COPY-ON-WRITE: when the owner dir
//                     doesn't exist yet but a shipped one does, the whole shipped
//                     dir is copied in first. Without that copy the overlay (which
//                     picks a dir, not a file) would make every asset the write
//                     didn't touch disappear.
// Falls back to the image dir when the key is unsafe for the store (so a write
// never silently goes nowhere).
function templateWriteDir(root, entry, key) {
  const shipped = shippedTemplateDir(root, entry, key);
  const owner = store.ownerTemplateDir(key);
  if (!owner) return shipped;
  if (!fs.existsSync(owner)) {
    if (shipped && fs.existsSync(shipped)) fs.cpSync(shipped, owner, { recursive: true });
    else fs.mkdirSync(owner, { recursive: true });
  }
  return owner;
}

// Resolve a template asset (a path RELATIVE to the template dir, e.g.
// "filled/fronts.svg") through the overlay. Returns the absolute path, or null
// when the template dir can't be resolved or the target would escape it.
// Existence is the caller's business.
function templateAssetPath(root, key, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  let entry = null;
  try {
    entry = ownTheme(loadThemesCached(themesPathFor(root)), key);
  } catch {
    entry = null; // a corrupt themes file must not break asset serving
  }
  const dir = resolveTemplateDir(root, entry, key);
  if (!dir) return null;
  const abs = path.resolve(dir, rel);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  return abs;
}

// ---- Recipes ----------------------------------------------------------------
// generator/recipes/<slug>.json, overlaid the same way: the owner copy wins when
// it exists. Returns the absolute path of the recipe that WOULD be read, or null
// when neither layer has one.
function resolveRecipePath(root, slug) {
  const owner = store.ownerRecipePath(slug);
  if (owner && fs.existsSync(owner)) return owner;
  const shipped = path.join(recipesDirFor(root), String(slug) + '.json');
  return fs.existsSync(shipped) ? shipped : null;
}

// A human-readable path for an absolute file we just wrote — relative to the repo
// root for an image write, relative to DATA_DIR for an owner-store write.
function displayPath(root, abs) {
  if (store.isInStore(abs) && process.env.DATA_DIR) {
    return path.relative(path.resolve(process.env.DATA_DIR), abs);
  }
  return path.relative(root, abs);
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
    // Editable settings surfaced so the admin UI can show + edit them in place.
    language: (entry && entry.language) || null,
    name_form: (entry && entry.name_form) || null,
    extra_fields: Array.isArray(entry && entry.extra_fields) ? entry.extra_fields : [],
    calibrated: !!(entry && entry.calibrated),
    // Current calibration look-pass values, so the admin form pre-fills on
    // re-edit (null on a fresh, not-yet-calibrated template).
    title_style: (entry && entry.title_style) || null,
    board: (entry && entry.board) || null,
    back: (entry && entry.back) || null,
    word_size: entry && entry.word_size != null ? entry.word_size : null,
    // Auto-calibration hints (populated when the upload measured the artwork):
    // `confidence` maps a dotted field path → 'high'|'low'|'none', `notes` is a
    // list of strings. Pass-through only (never validated/persisted by the save
    // path) so the form can flag low-confidence pre-fills as "check this one".
    confidence:
      entry && entry.confidence && typeof entry.confidence === 'object' ? entry.confidence : null,
    notes: Array.isArray(entry && entry.notes) ? entry.notes : null,
    assets,
    chasersBoard: !!(chasers && chasers.present),
    complete: missingRequired.length === 0,
    missingRequired,
    // Overlay provenance, so the admin UI can tell a persisted owner template (or
    // an owner override of a shipped one) from a pristine shipped template — and
    // so it can offer "revert" only where there is something to revert TO.
    owner: isOwnerTheme(key),
    shipped: isShippedTheme(root, key),
  };
}

// Is this key overridden/owned in the persistent owner store?
function isOwnerTheme(key) {
  try {
    return Object.prototype.hasOwnProperty.call(loadOwnerThemes(), key);
  } catch {
    return false;
  }
}

// Is this key present in the IMAGE's themes.json (i.e. it comes back on redeploy)?
function isShippedTheme(root, key) {
  try {
    return Object.prototype.hasOwnProperty.call(loadThemesFile(themesPathFor(root)), key);
  } catch {
    return false;
  }
}

// The status of EVERY registered template, in merged-themes order.
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
  // Copy-on-write: the WHOLE (merged) entry is persisted to the owner store, so a
  // renamed shipped theme is shadowed rather than edited in the image.
  persistThemeEntry(themesPath, key, entry);
  return { key, display_he: v.value, slug: entry.slug || key };
}

// Normalize an extra_fields input (an array, or a comma/whitespace string) into a
// clean array of non-empty tokens. Used by the settings editor.
function normalizeExtraFields(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input == null ? '' : input);
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- Calibration knobs ----------------------------------------------------
// The "look" pass that turns an uncalibrated (calibrated:false, title_style/board/
// back=null) template into a renderable one. The owner supplies every value via
// the admin form; these validators mirror the generator's schema EXACTLY so a
// saved blob can never crash the renderer:
//   title_style  render_page.title_block + build.py board/back (ts.get(...))
//   board / back build.py — {frac:{x0,y0,x1,y1}, fill, outline} or null
//   word_size    render_page — theme-level positive px, or null (auto-fit)

// A hex color (#rgb / #rrggbb) — the only color form the shipped themes use; kept
// strict so a bad value can never reach the generator's SVG paint attributes.
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
function isHexColor(v) {
  return typeof v === 'string' && HEX_COLOR_RE.test(v.trim());
}
function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
// A fraction in [0,1] (a position/size expressed relative to the card/board box).
function isFrac(v) {
  return isFiniteNum(v) && v >= 0 && v <= 1;
}
const TITLE_ALIGNS = ['center', 'left', 'right'];

// Validate a title_style blob. Required: fill, outline (hex), outline_w + arch
// (0..1 fractions), shadow (bool). Optional: size / board_size / back_size
// (positive px, absent = auto-fit), align (center/left/right), offset ([dx,dy]
// fractions -1..1), italic (bool). Returns a FRESH, key-whitelisted object so no
// stray field reaches themes.json. { value } | { error }.
function validateTitleStyle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'title_style must be an object' };
  }
  const out = {};
  if (!isHexColor(input.fill)) return { error: 'title_style.fill must be a hex color' };
  if (!isHexColor(input.outline)) return { error: 'title_style.outline must be a hex color' };
  out.fill = input.fill.trim();
  out.outline = input.outline.trim();
  if (!isFrac(input.outline_w)) return { error: 'title_style.outline_w must be a fraction 0..1' };
  out.outline_w = input.outline_w;
  if (!isFrac(input.arch)) return { error: 'title_style.arch must be a fraction 0..1' };
  out.arch = input.arch;
  if (typeof input.shadow !== 'boolean') return { error: 'title_style.shadow must be a boolean' };
  out.shadow = input.shadow;
  for (const k of ['size', 'board_size', 'back_size']) {
    if (input[k] == null) continue;
    if (!isFiniteNum(input[k]) || input[k] <= 0 || input[k] > 400) {
      return { error: 'title_style.' + k + ' must be a positive size' };
    }
    out[k] = input[k];
  }
  if (input.align != null) {
    if (!TITLE_ALIGNS.includes(input.align)) {
      return { error: 'title_style.align must be one of: ' + TITLE_ALIGNS.join(', ') };
    }
    out.align = input.align;
  }
  if (input.offset != null) {
    const o = input.offset;
    if (
      !Array.isArray(o) ||
      o.length !== 2 ||
      !isFiniteNum(o[0]) ||
      !isFiniteNum(o[1]) ||
      Math.abs(o[0]) > 1 ||
      Math.abs(o[1]) > 1
    ) {
      return { error: 'title_style.offset must be [dx,dy] fractions -1..1' };
    }
    out.offset = [o[0], o[1]];
  }
  if (input.italic != null) {
    if (typeof input.italic !== 'boolean') return { error: 'title_style.italic must be a boolean' };
    out.italic = input.italic;
  }
  return { value: out };
}

// Validate a board/back name slot: { frac:{x0,y0,x1,y1} in [0,1] with x0<x1,
// y0<y1, fill, outline hex }. `null` is a valid value (no honoree name drawn on
// that surface). { value } (may be null) | { error }.
function validateSlot(input, label) {
  if (input == null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: label + ' must be an object or null' };
  }
  const f = input.frac;
  if (!f || typeof f !== 'object' || Array.isArray(f))
    return { error: label + '.frac is required' };
  for (const k of ['x0', 'y0', 'x1', 'y1']) {
    if (!isFrac(f[k])) return { error: label + '.frac.' + k + ' must be a fraction 0..1' };
  }
  if (!(f.x0 < f.x1)) return { error: label + '.frac x0 must be < x1' };
  if (!(f.y0 < f.y1)) return { error: label + '.frac y0 must be < y1' };
  if (!isHexColor(input.fill)) return { error: label + '.fill must be a hex color' };
  if (!isHexColor(input.outline)) return { error: label + '.outline must be a hex color' };
  return {
    value: {
      frac: { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 },
      fill: input.fill.trim(),
      outline: input.outline.trim(),
    },
  };
}

// Validate a full calibration blob { title_style, board, back, word_size } for
// the LIVE PREVIEW path (title_style is REQUIRED — you can't render a title
// without it; board/back/word_size may be null/absent). Returns a fresh,
// generator-shaped object or { error }. Shared by /api/preview so the previewed
// look uses the exact same validation the save path enforces.
function validateCalibration(input) {
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const ts = validateTitleStyle(b.title_style);
  if (ts.error) return { error: ts.error };
  const board = validateSlot(b.board, 'board');
  if (board.error) return { error: board.error };
  const back = validateSlot(b.back, 'back');
  if (back.error) return { error: back.error };
  let word_size = null;
  if (b.word_size != null && b.word_size !== '') {
    if (!isFiniteNum(b.word_size) || b.word_size <= 0 || b.word_size > 400) {
      return { error: 'word_size must be a positive number or null' };
    }
    word_size = b.word_size;
  }
  return { value: { title_style: ts.value, board: board.value, back: back.value, word_size } };
}

// Editable theme SETTINGS the owner can change on an existing template AFTER
// onboarding — the storefront/config knobs + the CALIBRATION look-pass
// (title_style/board/back/word_size and the calibrated flip), never the identity
// (slug/dir/recipe) or asset files. Each provided key is validated; an invalid
// value rejects the whole patch (no partial write). A template can only be flipped
// to calibrated:true once it has a valid title_style (else the generator would
// crash on the first order). Atomic themes.json write. Returns the changed
// settings, or { error, httpStatus }.
function updateTemplateSettings({ root, key, patch }) {
  const themesPath = themesPathFor(root);
  const themes = loadThemes(themesPath);
  const entry = ownTheme(themes, key);
  if (!entry) return { error: 'template not found', httpStatus: 404 };
  const p = patch && typeof patch === 'object' ? patch : {};
  const changed = {};
  if ('display_he' in p) {
    const v = validateDisplayName(p.display_he);
    if (v.error) return { error: v.error, httpStatus: 400 };
    changed.display_he = v.value;
  }
  if ('language' in p) {
    const lang = String(p.language || '').trim();
    if (!LANGUAGES.includes(lang)) {
      return { error: 'language must be one of: ' + LANGUAGES.join(', '), httpStatus: 400 };
    }
    changed.language = lang;
  }
  if ('name_form' in p) {
    const nf = String(p.name_form || '').trim();
    if (!NAME_FORMS.includes(nf)) {
      return { error: 'name_form must be one of: ' + NAME_FORMS.join(', '), httpStatus: 400 };
    }
    changed.name_form = nf;
  }
  if ('visibility' in p) {
    const vis = String(p.visibility || '').trim();
    if (!VISIBILITIES.includes(vis)) {
      return { error: 'visibility must be one of: ' + VISIBILITIES.join(', '), httpStatus: 400 };
    }
    changed.visibility = vis;
  }
  if ('extra_fields' in p) {
    changed.extra_fields = normalizeExtraFields(p.extra_fields);
  }
  // Calibration look-pass: title_style / board / back / word_size, and the
  // calibrated flip. Each may arrive alone (tweak one knob) or together (the
  // form's "save + calibrate" action).
  if ('title_style' in p) {
    if (p.title_style === null) {
      changed.title_style = null;
    } else {
      const v = validateTitleStyle(p.title_style);
      if (v.error) return { error: v.error, httpStatus: 400 };
      changed.title_style = v.value;
    }
  }
  if ('board' in p) {
    const v = validateSlot(p.board, 'board');
    if (v.error) return { error: v.error, httpStatus: 400 };
    changed.board = v.value;
  }
  if ('back' in p) {
    const v = validateSlot(p.back, 'back');
    if (v.error) return { error: v.error, httpStatus: 400 };
    changed.back = v.value;
  }
  if ('word_size' in p) {
    if (p.word_size === null || p.word_size === '') {
      changed.word_size = null;
    } else if (isFiniteNum(p.word_size) && p.word_size > 0 && p.word_size <= 400) {
      changed.word_size = p.word_size;
    } else {
      return { error: 'word_size must be a positive number or null', httpStatus: 400 };
    }
  }
  if ('calibrated' in p) {
    if (typeof p.calibrated !== 'boolean') {
      return { error: 'calibrated must be a boolean', httpStatus: 400 };
    }
    changed.calibrated = p.calibrated;
  }
  if (Object.keys(changed).length === 0) {
    return { error: 'no valid settings to update', httpStatus: 400 };
  }
  // A template may only be flipped calibrated:true when it actually HAS a
  // title_style to render with (from this patch or already on the entry) —
  // otherwise the first order would crash the generator.
  const resultingCalibrated = 'calibrated' in changed ? changed.calibrated : !!entry.calibrated;
  if (resultingCalibrated) {
    const resultingStyle = 'title_style' in changed ? changed.title_style : entry.title_style;
    if (!resultingStyle || typeof resultingStyle !== 'object') {
      return { error: 'cannot set calibrated:true without a title_style', httpStatus: 400 };
    }
  }
  Object.assign(entry, changed);
  // word_size:null means "auto" — same as absent; drop the key so themes.json
  // stays as clean as the shipped themes (which simply omit it).
  if ('word_size' in changed && changed.word_size === null) delete entry.word_size;
  // Copy-on-write: a calibration saved on a SHIPPED template lands in the owner
  // store as a whole-entry override; the image's themes.json is never touched.
  persistThemeEntry(themesPath, key, entry);
  return {
    key,
    slug: entry.slug || key,
    settings: {
      display_he: entry.display_he,
      language: entry.language,
      name_form: entry.name_form,
      visibility: entry.visibility,
      extra_fields: Array.isArray(entry.extra_fields) ? entry.extra_fields : [],
      title_style: entry.title_style || null,
      board: entry.board || null,
      back: entry.back || null,
      word_size: entry.word_size == null ? null : entry.word_size,
      calibrated: !!entry.calibrated,
    },
  };
}

// Delete a template: remove its entry, then best-effort remove its on-disk dir
// and recipe file.
//
// GUARDED three ways:
//  - a theme a LIVE orderable design maps to (its key ∈ `inUseThemes`) is refused
//    (409) — deleting it would break the storefront / an in-flight order.
//  - a SHIPPED template (one that exists in the image's themes.json) is refused
//    (409) whenever the owner store is active: "deleting" it could only mean
//    writing an override, and it would simply come back on the next deploy.
//    Reverting an override is the honest operation there — see revertTemplate.
//  - it refuses to empty the mapping it writes to entirely.
// Returns { ok, key } or { error, httpStatus }.
function deleteTemplate({ root, key, inUseThemes }) {
  const themesPath = themesPathFor(root);
  const themes = loadThemes(themesPath);
  const entry = ownTheme(themes, key);
  if (!entry) return { error: 'template not found', httpStatus: 404 };
  const inUse =
    inUseThemes instanceof Set
      ? inUseThemes
      : new Set(Array.isArray(inUseThemes) ? inUseThemes : []);
  if (inUse.has(key)) {
    return {
      error: 'template is in use by a live design and cannot be deleted',
      httpStatus: 409,
      inUse: true,
    };
  }
  if (store.enabled() && isShippedTheme(root, key)) {
    return {
      error:
        'זו תבנית מובנית שמגיעה עם הגרסה — אי אפשר למחוק אותה, היא תחזור בפריסה הבאה. ' +
        'אפשר להסתיר אותה (visibility: private), או לבטל שינויים ששמרת עליה (שחזור למקור).',
      httpStatus: 409,
      shipped: true,
    };
  }
  const remaining = { ...themes };
  delete remaining[key];
  if (Object.keys(remaining).length === 0) {
    return { error: 'refusing to empty themes.json (last template)', httpStatus: 409 };
  }
  dropThemeEntry(themesPath, key);
  // Best-effort file cleanup — a failure just leaves files, never throws. Only the
  // layer we write to is touched; the image is never modified once the store is on.
  const dir = store.enabled() ? store.ownerTemplateDir(key) : shippedTemplateDir(root, entry, key);
  if (dir && dir !== templatesBaseDir(root) && dir !== store.storeRoot()) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leave the files */
    }
  }
  try {
    const recipe = store.enabled()
      ? store.ownerRecipePath(entry.slug || key)
      : path.join(recipesDirFor(root), (entry.slug || key) + '.json');
    if (recipe && fs.existsSync(recipe)) fs.rmSync(recipe, { force: true });
  } catch {
    /* best-effort */
  }
  return { ok: true, key, deleted: true };
}

// Drop the OWNER override of a shipped template, so the pristine shipped entry +
// assets take over again. The cheap counterpart to copy-on-write: the shipped
// layer was never modified, so "revert" is just deleting what we added.
// Refuses when there is no override, or when the key isn't shipped (that one is
// a real delete, not a revert). Returns { ok, key, reverted } or { error, httpStatus }.
function revertTemplate({ root, key }) {
  if (!store.enabled()) {
    return { error: 'no persistent template store configured (DATA_DIR unset)', httpStatus: 409 };
  }
  if (typeof key !== 'string' || !key || DANGEROUS_KEYS.has(key)) {
    return { error: 'template not found', httpStatus: 404 };
  }
  if (!isShippedTheme(root, key)) {
    return {
      error: 'זו לא תבנית מובנית — אין למה לשחזר אותה. אפשר פשוט למחוק אותה.',
      httpStatus: 409,
    };
  }
  const hadEntry = dropThemeEntry(themesPathFor(root), key);
  const dir = store.ownerTemplateDir(key);
  let hadAssets = false;
  if (dir && fs.existsSync(dir)) {
    hadAssets = true;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  const recipe = store.ownerRecipePath(key);
  if (recipe && fs.existsSync(recipe)) {
    try {
      fs.rmSync(recipe, { force: true });
    } catch {
      /* best-effort */
    }
  }
  if (!hadEntry && !hadAssets) {
    return { error: 'לא נשמרו שינויים על התבנית הזו — אין מה לשחזר.', httpStatus: 409 };
  }
  return { ok: true, key, reverted: true };
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
function replaceAsset({
  root,
  key,
  role,
  file,
  force = false,
  pythonBin,
  shrinkRunner,
  shrinkImages,
}) {
  const themesPath = themesPathFor(root);
  const themes = loadThemes(themesPath);
  const entry = ownTheme(themes, key);
  if (!entry) return { error: 'template not found', httpStatus: 404 };
  if (!REPLACEABLE_ROLES.has(role))
    return { error: 'unknown asset role: ' + role, httpStatus: 400 };
  if (!file || !file.data || !file.data.length)
    return { error: 'no file uploaded', httpStatus: 400 };

  // Resolve the CURRENT (read) dir first — every validation + the calibration
  // guard runs against what is live today. Only once the upload is accepted do we
  // resolve the WRITE dir, which may copy the shipped template into the owner
  // store; doing that up front would turn a rejected upload into a permanent
  // (if harmless) override.
  const readDir = resolveTemplateDir(root, entry, key);
  if (!readDir)
    return { error: 'template directory is outside the templates root', httpStatus: 400 };

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

  const current = path.resolve(readDir, rel);
  // Defense in depth: the resolved target must stay inside the template dir.
  if (current !== readDir && !current.startsWith(readDir + path.sep)) {
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
  if (kind === 'svg' && entry.calibrated && !force && fs.existsSync(current)) {
    return {
      error:
        'this template is calibrated — replacing its art may misalign the title/word slots. ' +
        'Verify the proof before sending to a customer, then re-upload with force to confirm.',
      httpStatus: 409,
      calibrationWarning: true,
    };
  }

  // Shrink oversized embedded rasters in an uploaded SVG before writing, the same
  // best-effort pass onboarding uses — so a per-file upload of a heavy Canva export
  // lands light on disk too. Skipped for fonts / small SVGs / when disabled.
  let data = file.data;
  if (kind === 'svg' && shrinkImages !== false) {
    data = shrinkSvgImages(file.data, { root, pythonBin, runner: shrinkRunner });
  }

  // Only now resolve WHERE the write lands: the owner store (copy-on-write over
  // the shipped dir) when it is active, else the image dir exactly as before.
  const writeDir = templateWriteDir(root, entry, key);
  if (!writeDir)
    return { error: 'template directory is outside the templates root', httpStatus: 400 };
  const abs = path.resolve(writeDir, rel);
  if (abs !== writeDir && !abs.startsWith(writeDir + path.sep)) {
    return { error: 'refusing to write outside the template directory', httpStatus: 400 };
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);

  // A newly-named font needs its filename recorded so the generator finds it.
  if (recordFontField) {
    entry[recordFontField] = path.basename(abs);
    persistThemeEntry(themesPath, key, entry);
  }
  return { key, role, path: displayPath(root, abs) };
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
  persistThemeEntry,
  loadThemes,
  loadThemesFile,
  loadOwnerThemes,
  loadThemesCached,
  writeTemplateFiles,
  runRecipeDiff,
  runCalibrate,
  applyCalibration,
  shrinkSvgImages,
  normalizeMetadata,
  normalizeOnboarding,
  onboardTemplate,
  createTemplateShell,
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
  resolveTemplateDirBySlug,
  shippedTemplateDir,
  templateWriteDir,
  templateDirExists,
  templateAssetPath,
  resolveRecipePath,
  isOwnerTheme,
  isShippedTheme,
  revertTemplate,
  computeTemplateStatus,
  listTemplateStatuses,
  validateDisplayName,
  renameTemplate,
  updateTemplateSettings,
  validateCalibration,
  deleteTemplate,
  normalizeExtraFields,
  replaceAsset,
  designDisplayNames,
  LANGUAGES,
  VISIBILITIES,
};
