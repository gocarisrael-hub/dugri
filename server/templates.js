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
// Only for validating a `wordlist` setting against the pools that actually
// resolve. wordlists -> validate -> template-store, so there is no cycle back
// here; templates is required by index.js alone.
const wordlists = require('./wordlists');

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
/**
 * Is this template offered in the shop at all?
 *
 * SEPARATE from `visibility`, and the distinction matters: `visibility` decides
 * whether a design that IS on sale sits in the open grid or is unlocked with an
 * access code, so using it to mean "not launched yet" quietly left the design
 * orderable by anyone holding a code.
 *
 * Absent = true, so every template written before this flag existed keeps
 * behaving exactly as it did.
 */
function inStore(entry) {
  return !(entry && entry.in_store === false);
}

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

// ---- Card structure: the two per-template asset layouts ---------------------
// 'sheet' (LEGACY) — clean|filled/{fronts,backs,board}.svg: landscape A4 sheets
//     of 8 cards, one file for every front and one for every back.
// 'cards' (NEW)    — clean|filled/1.svg .. 9.svg: PORTRAIT SINGLE cards, where
//     1 is the card BACK and 2-9 are the EIGHT fronts (which differ only by a
//     thin icon layer). The deck PDF is (back, front) x 104 = 208 pages.
//
// The BOARD is deliberately NOT part of the numbered 1-9 set in either layout:
// it stays clean/board.svg (+ the optional clean/board-chasers.svg) and is a
// SEPARATE output file, never a page of the deck.
//
// A theme entry with NO `card_structure` key is 'sheet', so every template that
// existed before this change keeps its paths, its asset checklist and its saved
// calibration untouched.
const CARD_STRUCTURES = ['sheet', 'cards'];
const DEFAULT_CARD_STRUCTURE = 'sheet';
// The numbered files of the 'cards' layout, and which of them is the back.
const CARD_BACK_NUMBER = 1;
const CARD_FRONT_NUMBERS = [2, 3, 4, 5, 6, 7, 8, 9];
const CARD_FILE_NUMBERS = [CARD_BACK_NUMBER, ...CARD_FRONT_NUMBERS];
// The single portrait card's viewBox — locked by the asset contract. Exposed to
// the admin form so the calibration preview draws the card at the true aspect.
const CARD_VIEWBOX = { w: 223.92, h: 312 };
// The four word slots a single card carries. Shared across ALL eight fronts —
// one calibration, not eight (only the TITLE moves per front).
const CARD_WORD_SLOTS = 4;
// De-duplicated shared images live in <slug>/assets/<sha16>.<ext>. The name is
// content-addressed by the exporter, so we accept exactly that shape and nothing
// else — it can never traverse or overwrite an SVG/font.
const CARD_ASSET_NAME_RE = /^[a-f0-9]{16}\.[a-z0-9]{1,5}$/;

// The layout a theme entry uses. Unknown/absent -> the legacy sheet layout.
function cardStructureOf(entry) {
  const v = entry && entry.card_structure;
  return CARD_STRUCTURES.includes(v) ? v : DEFAULT_CARD_STRUCTURE;
}

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
  cardStructure,
}) {
  const lines = String(titleText || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  // Only a 'cards' template records the key (plus its empty per-card slot blob).
  // A legacy upload writes NO card_structure at all, so its entry is byte-for-byte
  // what onboarding has always produced.
  const structure = cardStructure === 'cards' ? { card_structure: 'cards', card_slots: null } : {};
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
    ...structure,
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

// The SVG file name a clean/filled map KEY writes to. Whitelisted, so an
// attacker-supplied key can never become a path: the legacy sheet roles, a
// numbered single card (1-9), or the optional chasers board variant.
// Returns null for anything else, which the writer skips.
function svgFileNameForKey(key) {
  if (key === 'board_chasers') return CHASERS_BOARD_FILE;
  if (SVG_ROLES.includes(key)) return key + '.svg';
  if (/^[1-9]$/.test(String(key))) return String(key) + '.svg';
  return null;
}

// Write the uploaded SVGs + fonts into the template's asset dir — the OWNER store
// (DATA_DIR/templates/<slug>/) when it is active, else the image's
// resources/canva/templates/<slug>/.
//   clean/filled: role -> Buffer, where a role is a LEGACY sheet role
//                 ({fronts,backs,board}), a NUMBERED single card ('1'..'9'), or
//                 'board_chasers' (clean only). Both layouts write through the
//                 same whitelist, so nothing about the sheet path changed.
//   assets:       optional { <sha16>.<ext>: Buffer } shared images for the
//                 'cards' layout, written verbatim into <slug>/assets/.
//   fonts:        { title: {name, data}, word: {name, data} }
// Returns { dir, fonts: { title: <filename>, word: <filename> } }.
function writeTemplateFiles({ root, slug, clean, filled, fonts, assets }) {
  const dir = templateWriteDir(root, null, slug);
  for (const sub of ['clean', 'filled', 'fonts']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  for (const [layer, map] of [
    ['clean', clean || {}],
    ['filled', filled || {}],
  ]) {
    for (const key of Object.keys(map)) {
      const name = svgFileNameForKey(key);
      // board_chasers is a CLEAN-only variant — a filled one has no meaning.
      if (!name || !map[key] || (key === 'board_chasers' && layer !== 'clean')) continue;
      fs.writeFileSync(path.join(dir, layer, name), map[key]);
    }
  }
  // De-duplicated shared images (the 'cards' layout's assets/ dir). Only names
  // matching the content-addressed shape are written, so nothing here can escape
  // the dir or shadow an SVG.
  const assetNames = Object.keys(assets || {}).filter((n) => CARD_ASSET_NAME_RE.test(n));
  if (assetNames.length) {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    for (const name of assetNames) fs.writeFileSync(path.join(dir, 'assets', name), assets[name]);
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
function runRecipeDiff({
  root,
  slug,
  pythonBin = 'python3',
  timeoutMs = 120000,
  runner,
  cards = false,
}) {
  const script = path.join(root, 'generator', 'recipe_diff.py');
  const dir = resolveTemplateDirBySlug(root, slug);
  const filled = path.join(dir, 'filled', 'fronts.svg');
  const clean = path.join(dir, 'clean', 'fronts.svg');
  const out = store.ownerRecipePath(slug) || path.join(recipesDirFor(root), slug + '.json');
  // A single-card template has no fronts.svg sheet to diff: the detector takes
  // the template DIRECTORY and walks clean/filled 1..9 itself, reconciling the
  // four shared word slots across the eight fronts and keeping each front's own
  // title box.
  const args = cards ? [script, '--single', dir, slug] : [script, filled, clean, slug];
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
  // A REJECTED field must say so. This used to skip silently: calibrate emits a
  // title_style it could not fully measure (it grades the paints "low"),
  // validateTitleStyle refuses the whole object because fill/outline are not hex
  // colours, and the entry keeps title_style: null. The owner then gets a
  // template that detects fine, writes card_slots fine, and whose preview
  // refuses with "not calibrated yet — title_style is null", with nothing
  // anywhere saying a value was produced and thrown away.
  const rejected = [];
  const ts = validateTitleStyle(blob.title_style);
  if (!ts.error) entry.title_style = ts.value;
  else if (blob.title_style) rejected.push('title_style (' + ts.error + ')');
  for (const slot of ['board', 'back']) {
    if (!(slot in blob)) continue;
    const v = validateSlot(blob[slot], slot);
    if (!v.error) entry[slot] = v.value;
    else if (blob[slot]) rejected.push(slot + ' (' + v.error + ')');
  }
  if (typeof blob.word_size === 'number' && blob.word_size > 0) entry.word_size = blob.word_size;
  // The detected single-card geometry. Without this the detector measured the
  // slots correctly, wrote them into its blob, and the merge silently dropped
  // them — so the admin form kept opening on its hardcoded defaults (boxes
  // roughly twice the real width) and the preview came back with giant words and
  // a title clipped off both card edges. Validated through the same guard the
  // form's own save uses, so a bad blob can't write geometry the form would have
  // rejected.
  if ('card_slots' in blob) {
    const cs = validateCardSlots(blob.card_slots);
    if (!cs.error) entry.card_slots = cs.value;
  }
  // Advisory, for the form's "check this one" flags — not render inputs.
  if (blob.confidence && typeof blob.confidence === 'object') entry.confidence = blob.confidence;
  if (Array.isArray(blob.notes)) entry.notes = blob.notes.filter((s) => typeof s === 'string');
  if (rejected.length) {
    entry.notes = (entry.notes || []).concat(
      'measured but REJECTED as invalid, so the old value was kept: ' +
        rejected.join('; ') +
        '. Fill these in by hand — the template cannot render until title_style is set.'
    );
  }
  // persistThemeEntry, NOT writeThemesFile. Two bugs in the old line:
  //
  // 1. It wrote to the IMAGE themes.json, which on Railway is ephemeral — so a
  //    detected calibration survived until the next deploy and then silently
  //    vanished. Same root cause as recipes being written to
  //    generator/recipes/: a runtime write aimed at the container instead of
  //    the volume.
  // 2. It wrote back the MERGED shipped+owner mapping, so every owner entry got
  //    baked into the shipped file and would come back looking shipped.
  //
  // persistThemeEntry writes the single entry to the owner store when there is
  // one, and only falls back to the shipped file when there is not.
  persistThemeEntry(themesPath, key, entry);
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
  // Asset layout. Explicit only — an absent/unknown value is the legacy sheet
  // layout, so nothing that already registers templates has to change.
  const rawStructure = String((fields && fields.card_structure) || '').trim();
  if (rawStructure && !CARD_STRUCTURES.includes(rawStructure)) {
    return { error: 'card_structure must be one of: ' + CARD_STRUCTURES.join(', ') };
  }
  const cardStructure = rawStructure || DEFAULT_CARD_STRUCTURE;
  return {
    slug,
    displayHe,
    titleText,
    nameForm,
    language,
    extraFields,
    visibility,
    cardStructure,
  };
}

// Every numbered card file an upload supplied for ONE layer (clean|filled).
//
// Two ways in, because the owner has two natural ways to hand us the nine files:
//   1. ONE multi-file picker (`clean_cards` / `filled_cards`) — the owner selects
//      the whole exported folder at once, so the mapping comes from each file's
//      own NAME (1.svg .. 9.svg). This is where "misnamed" is a real failure mode
//      ("1 (1).svg", "front1.svg"), so every rejected name is collected and
//      reported back rather than silently dropped.
//   2. Explicit per-slot parts (`clean_1` .. `clean_9`), which an API client or
//      the per-asset flow can post with no ambiguity at all.
// Returns { got: { <n>: Buffer }, bad: [<filename>, ...] }.
function collectNumberedCardFiles(layer, files, fileLists) {
  const got = {};
  const bad = [];
  const list = (fileLists && fileLists[layer + '_cards']) || [];
  for (const f of list) {
    if (!f || !f.data || !f.data.length) continue;
    const base = safeBasename(f.filename) || String(f.filename || '');
    const m = /^([1-9])\.svg$/i.exec(base);
    if (!m) {
      bad.push(base || '(ללא שם)');
      continue;
    }
    got[m[1]] = f.data;
  }
  for (const n of CARD_FILE_NUMBERS) {
    const f = files && files[layer + '_' + n];
    if (f && f.data && f.data.length) got[String(n)] = f.data;
  }
  return { got, bad };
}

// Human name of a numbered card slot, for an owner-facing message.
function cardSlotLabel(n) {
  return Number(n) === CARD_BACK_NUMBER ? 'גב הקלף' : 'פנים ' + (Number(n) - 1);
}

// Validate the NEW numbered layout's uploads: 1.svg .. 9.svg in BOTH clean/ and
// filled/ — eighteen files, of which 1 is the back and 2-9 the eight fronts. The
// board is NOT one of them (it is a separate output file), so it is accepted here
// but never required; a template can be registered deck-first and get its board
// from the per-asset uploader afterwards.
//
// This is an OWNER-FACING tool, so a failure NAMES every file that is missing or
// misnamed instead of stopping at the first one — a cryptic "missing SVG" costs a
// support round-trip. Returns { error } or { clean, filled }.
function normalizeCardUploads({ files, fileLists }) {
  const clean = collectNumberedCardFiles('clean', files, fileLists);
  const filled = collectNumberedCardFiles('filled', files, fileLists);
  const missing = { clean: [], filled: [] };
  const notSvg = [];
  for (const layer of ['clean', 'filled']) {
    const got = layer === 'clean' ? clean.got : filled.got;
    for (const n of CARD_FILE_NUMBERS) {
      if (!got[String(n)]) missing[layer].push(n);
      else if (!looksLikeSvg(got[String(n)])) notSvg.push(layer + '/' + n + '.svg');
    }
  }
  const bad = [...clean.bad, ...filled.bad];
  if (missing.clean.length || missing.filled.length || notSvg.length || bad.length) {
    const lines = [
      'מבנה הקלפים החדש דורש 18 קבצים: 1.svg עד 9.svg בתיקייה clean, ואותם תשעה בתיקייה ' +
        'filled (1 = גב הקלף, 2-9 = שמונה הפנים). הלוח אינו חלק מהסט הזה.',
    ];
    for (const layer of ['clean', 'filled']) {
      if (!missing[layer].length) continue;
      lines.push(
        'חסרים ב-' +
          layer +
          ': ' +
          missing[layer].map((n) => n + '.svg (' + cardSlotLabel(n) + ')').join(', ')
      );
    }
    if (bad.length) {
      lines.push(
        'שמות קבצים שלא זוהו (ולכן לא נקלטו): ' +
          bad.join(', ') +
          ' — כל קובץ חייב להיקרא בדיוק 1.svg עד 9.svg.'
      );
    }
    if (notSvg.length) lines.push('לא נראים כמו SVG: ' + notSvg.join(', '));
    return { error: lines.join('\n') };
  }
  return { clean: clean.got, filled: filled.got };
}

// The shared images (<sha16>.<ext>) an upload supplied for the 'cards' layout's
// assets/ dir. Optional; names that don't match the content-addressed shape are
// reported so a mis-picked file is visible rather than silently dropped.
function collectCardAssets(fileLists) {
  const out = {};
  const bad = [];
  for (const f of (fileLists && fileLists.assets) || []) {
    if (!f || !f.data || !f.data.length) continue;
    const base = safeBasename(f.filename);
    if (!base || !CARD_ASSET_NAME_RE.test(base)) {
      bad.push(base || '(ללא שם)');
      continue;
    }
    out[base] = f.data;
  }
  return { assets: out, bad };
}

// Does this upload carry the NEW numbered layout? True as soon as ANY numbered
// card part is present — a `clean_cards`/`filled_cards` multi-pick or an explicit
// `clean_<n>`/`filled_<n>`. Sniffing on presence (not on completeness) is what
// lets a HALF-CORRECT new-layout upload fall into the new validator and get the
// "these files are missing/misnamed" message, instead of being mistaken for a
// legacy upload and told "missing clean fronts SVG".
function looksLikeCardUpload(files, fileLists) {
  for (const layer of ['clean', 'filled']) {
    const list = (fileLists && fileLists[layer + '_cards']) || [];
    if (list.length) return true;
    for (const n of CARD_FILE_NUMBERS) {
      const f = files && files[layer + '_' + n];
      if (f && f.data && f.data.length) return true;
    }
  }
  return false;
}

// Validate + collect the parsed fields/files for onboarding. Returns
// { error } on the first problem, or a normalized descriptor on success.
//
// Handles BOTH asset layouts. Which one an upload is, is decided by what it
// CARRIES: any numbered card part (a `clean_cards`/`filled_cards` multi-pick or
// an explicit `clean_1`..`clean_9`) means the new single-card layout; anything
// else is the legacy fronts/backs/board upload, validated and written exactly as
// it always has been. An explicit `card_structure` field wins over the sniff, so
// a caller can always be unambiguous.
function normalizeOnboarding({ root, fields, files, fileLists }) {
  const meta = normalizeMetadata({ root, fields });
  if (meta.error) return meta;
  const { slug, displayHe, titleText, nameForm, language, extraFields, visibility } = meta;
  const declared = String((fields && fields.card_structure) || '').trim();
  const cardStructure = declared || (looksLikeCardUpload(files, fileLists) ? 'cards' : 'sheet');

  const clean = {};
  const filled = {};
  let assets = null;
  if (cardStructure === 'cards') {
    const cards = normalizeCardUploads({ files, fileLists });
    if (cards.error) return { error: cards.error };
    Object.assign(clean, cards.clean);
    Object.assign(filled, cards.filled);
    // The board is a SEPARATE output file, not a page of the deck — accepted here
    // when supplied, never required. Its checklist row still shows it as missing
    // until it is uploaded, so nothing is hidden.
    for (const layer of ['clean', 'filled']) {
      const f = files && files[layer + '_board'];
      if (!f || !f.data || !f.data.length) continue;
      if (!looksLikeSvg(f.data)) return { error: layer + ' board does not look like an SVG' };
      (layer === 'clean' ? clean : filled).board = f.data;
    }
    const picked = collectCardAssets(fileLists);
    if (picked.bad.length) {
      return {
        error:
          'קבצים בתיקיית assets חייבים להיקרא <16 תווי hex>.<סיומת> (כפי שהיצוא מייצר). ' +
          'לא זוהו: ' +
          picked.bad.join(', '),
      };
    }
    if (Object.keys(picked.assets).length) assets = picked.assets;
  } else {
    // Required uploads: clean + filled {fronts,backs,board} SVGs and both fonts.
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
    cardStructure,
    clean,
    filled,
    assets,
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
  const norm = normalizeOnboarding({
    root,
    fields: opts.fields,
    files: opts.files,
    fileLists: opts.fileLists,
  });
  if (norm.error) return { error: norm.error, httpStatus: 400 };
  const isCards = norm.cardStructure === 'cards';

  // Shrink oversized embedded images BEFORE writing, so both the stored files and
  // the recipe_diff (which reads the written fronts) use the lightened SVGs.
  // Best-effort per file; unless disabled with shrinkImages:false (pure-write test).
  if (opts.shrinkImages !== false) {
    const sh = (b) =>
      shrinkSvgImages(b, { root, pythonBin: opts.pythonBin, runner: opts.shrinkRunner });
    for (const map of [norm.clean, norm.filled]) {
      for (const role of Object.keys(map)) map[role] = sh(map[role]);
    }
  }

  const written = writeTemplateFiles({
    root,
    slug: norm.slug,
    clean: norm.clean,
    filled: norm.filled,
    assets: norm.assets,
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
    cardStructure: norm.cardStructure,
  });
  appendThemeEntry(themesPathFor(root), norm.slug, entry);

  // Both Python steps run for BOTH layouts. This used to skip single-card
  // templates on the grounds that recipe_diff only understood the 8-up sheet, so
  // their slots had to be measured by hand in the admin form — that stopped being
  // true when the detector learned the single-card structure, and leaving the
  // skip in place meant every card template arrived with an empty recipe and no
  // sign that detection had simply never been attempted.
  let recipe = { ok: false, skipped: true };
  if (opts.runRecipe !== false) {
    recipe = runRecipeDiff({
      root,
      slug: norm.slug,
      single: isCards,
      pythonBin: opts.pythonBin,
      timeoutMs: opts.recipeTimeoutMs,
      runner: opts.recipeRunner,
      cards: isCards,
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
  // A missing board is expected on a deck-first single-card upload, so say what
  // is still outstanding instead of leaving the owner to read the checklist.
  const cardsNote =
    `Template registered as ${visLabel} and UNCALIBRATED, with the 18 single-card SVGs ` +
    '(1 = back, 2-9 = fronts) in place. ' +
    (recipe.ok
      ? 'The word slots, per-front title boxes and INK COLOURS were detected from the artwork ' +
        'and are in place as the starting geometry. '
      : 'Slot auto-detection did not run/succeed here, so there is no detected geometry to ' +
        'start from — run `python3 generator/recipe_diff.py --single <template_dir> ' +
        norm.slug +
        '` on a machine with Chrome + Pillow if you want one. ') +
    'Open the calibration panel: set the four shared word ' +
    "slots and each front's title position, preview, and save." +
    (norm.clean.board && norm.filled.board
      ? ''
      : ' The BOARD is a separate output file and was not uploaded — add clean/filled board from ' +
        'the template list below.');
  const note = isCards
    ? cardsNote
    : !recipe.ok
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
    card_structure: norm.cardStructure,
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
  const isCards = meta.cardStructure === 'cards';
  const dir = templateWriteDir(root, null, meta.slug);
  // assets/ only for the single-card layout, whose SVGs reference de-duplicated
  // shared images out of it.
  for (const sub of ['clean', 'filled', 'fonts', ...(isCards ? ['assets'] : [])]) {
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
    cardStructure: meta.cardStructure,
  });
  appendThemeEntry(themesPathFor(root), meta.slug, entry);
  return {
    key: meta.slug,
    dir: 'resources/canva/templates/' + meta.slug,
    calibrated: false,
    visibility: entry.visibility,
    card_structure: meta.cardStructure,
    shell: true,
    theme: entry,
    note:
      `Empty template "${meta.slug}" created (${entry.visibility.toUpperCase()}). Upload each ` +
      (isCards
        ? 'asset (clean/filled 1.svg-9.svg — 1 is the back, 2-9 the fronts — plus the separate ' +
          'board and both fonts) '
        : 'asset (clean/filled fronts, backs, board + both fonts) ') +
      'separately from the template list below, then calibrate.',
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
// The SAME table for the NEW single-card layout: the eighteen numbered files
// (clean/filled 1.svg-9.svg, 1 = back and 2-9 = the eight fronts) plus the board,
// which is NOT one of them — it is a separate output file that happens to live in
// the same dir. Board rows keep the exact role ids the sheet layout uses, so
// board upload/replace works identically in both layouts.
const CARD_SVG_ASSET_ROLES = [
  ...['clean', 'filled'].flatMap((layer) =>
    CARD_FILE_NUMBERS.map((n) => ({
      role: layer + '-' + n,
      rel: layer + '/' + n + '.svg',
      kind: 'svg',
      optional: false,
      label:
        (n === CARD_BACK_NUMBER ? 'גב קלף' : 'פנים ' + (n - 1)) +
        ' · ' +
        n +
        '.svg ' +
        (layer === 'clean' ? '(נקי)' : '(ממולא)'),
    }))
  ),
  ...SVG_ASSET_ROLES.filter((a) => a.role.endsWith('-board') || a.role.endsWith('-board-chasers')),
];

// Font roles resolve their path from the theme entry (the filename the generator
// reads out of themes.json), so their `rel` is computed per-entry, not fixed.
const FONT_ASSET_ROLES = [
  { role: 'title-font', field: 'title_font', kind: 'font', optional: false, label: 'פונט כותרת' },
  { role: 'word-font', field: 'word_font', kind: 'font', optional: false, label: 'פונט מילים' },
];
// Whitelist of replaceable role ids — the ONLY roles the replace API accepts.
// Covers BOTH layouts' ids; whether a given role belongs to the template being
// edited is a separate, per-entry check in replaceAsset (a numbered role posted
// at a sheet template is rejected with an explanation, not silently written).
const REPLACEABLE_ROLES = new Set(
  [...SVG_ASSET_ROLES, ...CARD_SVG_ASSET_ROLES, ...FONT_ASSET_ROLES].map((a) => a.role)
);

// The numbered card SVGs (clean-1..9 / filled-1..9) — the roles whose artwork the
// detected recipe is measured FROM, so replacing one invalidates it. Excludes the
// board and the fonts, which detection does not measure.
const CARD_SVG_ROLE_SET = new Set(CARD_SVG_ASSET_ROLES.map((a) => a.role));
function isCardSvgRole(role) {
  return CARD_SVG_ROLE_SET.has(String(role || ''));
}

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
//
// An ALREADY-CLAIMED dir is backfilled from the shipped one, additively. The
// claim copy above can only ever copy what the image actually contains, and the
// image spent a while shipping no filled/ at all (see .dockerignore) — so every
// template claimed in that window has a permanently half-populated owner dir,
// which is precisely the state the note above says must never exist. Restoring
// filled/ to the image does NOT heal those: resolution picks a DIR, so the
// incomplete owner copy keeps shadowing the now-complete shipped one. force:false
// makes this strictly additive — a file the owner actually uploaded is never
// overwritten by the shipped original, only genuinely missing ones are filled in.
function templateWriteDir(root, entry, key) {
  const shipped = shippedTemplateDir(root, entry, key);
  const owner = store.ownerTemplateDir(key);
  if (!owner) return shipped;
  const hasShipped = shipped && fs.existsSync(shipped);
  if (!fs.existsSync(owner)) {
    if (hasShipped) fs.cpSync(shipped, owner, { recursive: true });
    else fs.mkdirSync(owner, { recursive: true });
  } else if (hasShipped) {
    try {
      fs.cpSync(shipped, owner, { recursive: true, force: false, errorOnExist: false });
    } catch {
      /* best-effort heal: a write must still proceed on its own assets */
    }
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
// A theme's recorded font may sit in a SUBDIRECTORY of fonts/ ("Cafe
// Regular/Cafe Regular.ttf", "comixno2/comixno2clm_medium-webfont.ttf"), which
// is how most shipped themes record theirs. Reducing that to a basename — as
// this used to — pointed the replace path at fonts/<file> while the generator
// went on reading fonts/<dir>/<file>, so replacing such a font wrote a file
// nobody read and the old one rendered forever.
//
// Keeps the relative path, rejects anything that could climb out of fonts/ or
// name an absolute location.
function safeFontRel(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  if (!raw || path.isAbsolute(raw)) return null;
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..')) return null;
  return parts.join('/');
}

function safeBasename(name) {
  const b = path.basename(String(name || ''));
  if (!b || b === '.' || b === '..' || b.includes('/') || b.includes('\\')) return null;
  return b;
}

// The full asset-role list for a specific theme entry, with font `rel` resolved
// from the recorded filename (null when no font is on record yet). The SVG half
// follows the entry's asset layout — the legacy fronts/backs/board sheet, or the
// eighteen numbered single cards — so an entry with no `card_structure` yields
// exactly the list it always did.
function assetRolesFor(entry) {
  const table = cardStructureOf(entry) === 'cards' ? CARD_SVG_ASSET_ROLES : SVG_ASSET_ROLES;
  const svg = table.map((a) => ({ ...a }));
  const fonts = FONT_ASSET_ROLES.map((a) => {
    const name = entry && entry[a.field] ? safeFontRel(entry[a.field]) : null;
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

// How many shared images sit in a template's assets/ dir. 0 for a template that
// has none (every sheet template, and a single-card one whose SVGs embed their
// images inline). Never throws — a missing dir is simply zero.
function countCardAssets(dir) {
  if (!dir) return 0;
  try {
    return fs.readdirSync(path.join(dir, 'assets')).filter((n) => CARD_ASSET_NAME_RE.test(n))
      .length;
  } catch {
    return 0;
  }
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
    // Asset layout + the single-card calibration it needs. `card_structure` is
    // always reported (absent on the entry reads as the legacy 'sheet'), so the
    // admin form never has to guess; `card_slots` is the shared word slots +
    // per-front title positions, null until the owner saves them.
    card_structure: cardStructureOf(entry),
    // Always reported as a boolean (absent on the entry reads as true), so the
    // admin toggle shows the real state instead of guessing from a missing key.
    in_store: inStore(entry),
    card_slots: (entry && entry.card_slots) || null,
    card_viewbox: { ...CARD_VIEWBOX },
    // How many de-duplicated shared images the template carries (assets/), so the
    // checklist can show that the SVGs' image dependencies actually landed.
    assets_count: countCardAssets(dir),
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

// Validate ONE frac box {x0,y0,x1,y1}, each in [0,1] with x0<x1 and y0<y1 — a
// rectangle expressed relative to the surface it sits on. Returns a fresh object
// so nothing extra can ride along into themes.json. { value } | { error }.
function validateFrac(f, label) {
  if (!f || typeof f !== 'object' || Array.isArray(f))
    return { error: label + ' must be an object' };
  for (const k of ['x0', 'y0', 'x1', 'y1']) {
    if (!isFrac(f[k])) return { error: label + '.' + k + ' must be a fraction 0..1' };
  }
  if (!(f.x0 < f.x1)) return { error: label + ': x0 must be < x1' };
  if (!(f.y0 < f.y1)) return { error: label + ': y0 must be < y1' };
  return { value: { x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 } };
}

// Validate the SINGLE-CARD geometry (the 'cards' layout only):
//   { words:  [frac x4],            the four word slots — SHARED by all eight
//                                   fronts, because they never move; one
//                                   calibration, not eight.
//     titles: { "2".."9": frac } }  the title POSITION per front, because that
//                                   is the one thing that does move. Title STYLE
//                                   (font, colour, size, offset, italic,
//                                   outline) stays shared in title_style.
// Every box is a fraction of the 223.92x312 card, so the values survive any
// re-export at a different pixel size. `null` is valid (not calibrated yet).
// Returns a fresh, generator-shaped object. { value } (may be null) | { error }.
function validateCardSlots(input) {
  if (input == null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'card_slots must be an object or null' };
  }
  if (!Array.isArray(input.words) || input.words.length !== CARD_WORD_SLOTS) {
    return { error: 'card_slots.words must be an array of ' + CARD_WORD_SLOTS + ' boxes' };
  }
  const words = [];
  for (let i = 0; i < CARD_WORD_SLOTS; i += 1) {
    const v = validateFrac(input.words[i], 'card_slots.words[' + i + ']');
    if (v.error) return { error: v.error };
    words.push(v.value);
  }
  const t = input.titles;
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    return { error: 'card_slots.titles must be an object keyed by front number' };
  }
  // All eight fronts, always: a half-filled map would render some fronts with the
  // title in whatever place the last calibration happened to leave.
  const missing = CARD_FRONT_NUMBERS.filter(
    (n) => !Object.prototype.hasOwnProperty.call(t, String(n))
  );
  if (missing.length) {
    return {
      error:
        'card_slots.titles is missing a title position for front(s): ' +
        missing.map((n) => n + '.svg').join(', '),
    };
  }
  const titles = {};
  for (const n of CARD_FRONT_NUMBERS) {
    const v = validateFrac(t[String(n)], 'card_slots.titles.' + n);
    if (v.error) return { error: v.error };
    titles[String(n)] = v.value;
  }
  return { value: { words, titles } };
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
  // Single-card geometry, only sent by a 'cards' template's form. Absent for
  // every sheet template, so the blob a legacy preview posts is unchanged.
  const cards = validateCardSlots(b.card_slots);
  if (cards.error) return { error: cards.error };
  return {
    value: {
      title_style: ts.value,
      board: board.value,
      back: back.value,
      word_size,
      card_slots: cards.value,
    },
  };
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
  // IS IT FOR SALE AT ALL — a different question from `visibility`, which asks
  // "once it IS for sale, is it in the open grid or unlocked by an access code".
  // Conflating the two meant taking a design off the shop floor also handed it to
  // anyone holding a code. `in_store:false` removes it from the storefront
  // outright; the owner can still generate an order for it from the admin, which
  // is what makes it usable for testing a design before launch.
  //
  // ABSENT MEANS TRUE. Every template that predates this is for sale exactly as
  // it was, and nothing has to be backfilled.
  if ('in_store' in p) {
    changed.in_store = !(p.in_store === false || p.in_store === 'false' || p.in_store === 0);
  }
  if ('extra_fields' in p) {
    changed.extra_fields = normalizeExtraFields(p.extra_fields);
  }
  // Which seed pool tops this template's orders up to a full deck. Until now the
  // link lived only in the shipped themes.json — baked into the image, so it was
  // surfaced read-only on the wordlists screen and could not be changed without a
  // deploy. It rides the same whole-entry copy-on-write as every other setting
  // here, which is what makes it survive one: the generator reads the merged
  // entry from the owner store (generator/config.py), so an override takes effect
  // on the next order with no change on the Python side.
  //
  // Empty/null means "no pool named" — the key is dropped so the theme falls back
  // to the shared generic pool, exactly like a shipped theme that omits it.
  // Anything else must name a pool that actually RESOLVES today: a typo would not
  // fail anything at generation time (topup treats a missing pool as empty and
  // quietly ships a shorter deck), so it has to be caught at the write.
  if ('wordlist' in p) {
    if (p.wordlist === null || p.wordlist === '') {
      changed.wordlist = null;
    } else {
      const name = wordlists.safeName(p.wordlist);
      if (!name || !wordlists.resolveWordlist(name)) {
        return { error: 'unknown wordlist: ' + String(p.wordlist).slice(0, 80), httpStatus: 400 };
      }
      changed.wordlist = name;
    }
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
  if ('card_slots' in p) {
    const v = validateCardSlots(p.card_slots);
    if (v.error) return { error: v.error, httpStatus: 400 };
    changed.card_slots = v.value;
  }
  // Switching asset layout re-points every SVG path AND changes what a
  // calibration means, so a switch always drops `calibrated` back to false: the
  // owner re-checks the preview and saves again. Silently keeping the flag would
  // let an order render with slots measured against the other layout's artwork.
  if ('card_structure' in p) {
    const cs = String(p.card_structure || '').trim();
    if (!CARD_STRUCTURES.includes(cs)) {
      return {
        error: 'card_structure must be one of: ' + CARD_STRUCTURES.join(', '),
        httpStatus: 400,
      };
    }
    if (cs !== cardStructureOf(entry)) {
      changed.card_structure = cs;
      changed.calibrated = false;
    }
  }
  if ('calibrated' in p) {
    if (typeof p.calibrated !== 'boolean') {
      return { error: 'calibrated must be a boolean', httpStatus: 400 };
    }
    // A layout switch in the SAME patch wins — see above.
    if (!('card_structure' in changed)) changed.calibrated = p.calibrated;
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
    // A single-card template additionally needs its card geometry: the four
    // shared word slots and a title position for each of the eight fronts. Without
    // them there is nothing to place a word or a title against.
    const resultingStructure =
      'card_structure' in changed ? changed.card_structure : cardStructureOf(entry);
    if (resultingStructure === 'cards') {
      const resultingSlots = 'card_slots' in changed ? changed.card_slots : entry.card_slots;
      if (!resultingSlots || typeof resultingSlots !== 'object') {
        return {
          error:
            'cannot set calibrated:true on a single-card template without card_slots ' +
            '(the four shared word slots + a title position per front)',
          httpStatus: 400,
        };
      }
    }
  }
  Object.assign(entry, changed);
  // word_size:null means "auto" — same as absent; drop the key so themes.json
  // stays as clean as the shipped themes (which simply omit it).
  if ('word_size' in changed && changed.word_size === null) delete entry.word_size;
  // Same for wordlist:null — "no pool named", i.e. fall back to the generic one.
  // Dropping the key rather than storing null keeps the owner entry readable as
  // the shipped entries are, and topup's `cfg.get("wordlist") or GENERIC` treats
  // absent and null identically anyway.
  if ('wordlist' in changed && changed.wordlist === null) delete entry.wordlist;
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
      // null = names no pool, i.e. the generic fallback.
      wordlist: entry.wordlist || null,
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
// Re-run detection + auto-calibration for an EXISTING template, on demand.
//
// Until now this only ever happened at onboarding: there was no way to re-detect
// a template already in the catalog, so swapping artwork left the measured slots
// silently stale. Doing it automatically on every asset replace was the other
// extreme — 18 Chrome start-ups per uploaded file. This is the middle: the owner
// asks for it once, when the artwork is finished.
//
// Detection PROPOSES: the measured values are written, but `calibrated` is left
// exactly as it was, so this can never flip an unfinished template on sale.
function redetectTemplate({ root, key, pythonBin, recipeRunner, calibrateRunner }) {
  const themes = loadThemes(themesPathFor(root));
  const entry = ownTheme(themes, key);
  if (!entry) return { error: 'template not found', httpStatus: 404 };
  const cards = cardStructureOf(entry) === 'cards';
  const recipe = runRecipeDiff({ root, slug: key, cards, pythonBin, runner: recipeRunner });
  if (!recipe.ok) {
    return {
      error: 'detection failed: ' + (recipe.detail || 'unknown error'),
      httpStatus: 422,
    };
  }
  const calibration = runCalibrate({ root, slug: key, pythonBin, runner: calibrateRunner });
  if (calibration.ok) applyCalibration(themesPathFor(root), key, calibration.blob);
  return {
    key,
    recipe: recipe.recipe,
    calibrated: !!calibration.ok,
    // Surfaced rather than swallowed: a recipe that detected fine while
    // calibration did not is a real, actionable state.
    detail: calibration.ok ? null : calibration.detail || null,
  };
}

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

// The FILLED SVG a storefront picture slot (front|back|board) maps to, RELATIVE
// to the template dir — resolved per LAYOUT, because the same product picture
// lives in a different file in each:
//   sheet  front -> filled/fronts.svg   back -> filled/backs.svg
//   cards  front -> filled/2.svg        back -> filled/1.svg   (1 IS the back)
// The board is the same file in both. Returns null for an unknown slot. Pure —
// existence is the caller's business.
const FILLED_IMAGE_REL = {
  sheet: { front: 'filled/fronts.svg', back: 'filled/backs.svg', board: 'filled/board.svg' },
  cards: {
    front: 'filled/' + CARD_FRONT_NUMBERS[0] + '.svg',
    back: 'filled/' + CARD_BACK_NUMBER + '.svg',
    board: 'filled/board.svg',
  },
};
function filledImageRel(entry, slot) {
  return FILLED_IMAGE_REL[cardStructureOf(entry)][slot] || null;
}

// The absolute path of a storefront picture slot (front|back|board) for a slug,
// resolved through the persistent overlay and CONFINED to the template dir.
// Returns null for an unknown slot/slug or a path that would escape. A corrupt
// themes file resolves as the legacy layout rather than breaking image serving.
function templateImagePath(root, slug, slot) {
  let entry = null;
  try {
    entry = ownTheme(loadThemesCached(themesPathFor(root)), slug);
  } catch {
    entry = null;
  }
  const rel = filledImageRel(entry, slot);
  return rel ? templateAssetPath(root, slug, rel) : null;
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
  recipeRunner,
  redetectOnReplace,
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

  // The whitelist covers BOTH asset layouts, so a role can be legal in general and
  // still not belong to THIS template (e.g. clean-3 posted at a legacy sheet
  // template, or clean-fronts at a single-card one). Say so rather than crashing
  // on an undefined spec — assetRolesFor stays the single source of truth for the
  // path + kind.
  const spec = assetRolesFor(entry).find((a) => a.role === role);
  if (!spec) {
    return {
      error:
        'asset role "' +
        role +
        '" does not belong to this template (its layout is ' +
        cardStructureOf(entry) +
        ')',
      httpStatus: 400,
    };
  }
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

  // New artwork, old measurements. The 409 above stops art being swapped
  // SILENTLY under a calibrated template, but once the owner forces through it
  // the detected recipe describes the picture that is no longer there — and it
  // is not only the fallback geometry that goes stale. card_slots carries NO
  // COLOUR, so the words' ink comes from this recipe: leaving it alone paints
  // the new artwork's words in the OLD artwork's colours, on a layer that always
  // applies. So a forced card-SVG replace re-detects.
  //
  // This cannot clobber the owner's work: detection writes the RECIPE, while
  // hand-tuned card_slots live in themes.json and win in config's reader.
  //
  // Best-effort, and NEVER destructive: a detection that fails leaves the
  // existing recipe exactly where it is (recipe_diff writes only on success), so
  // the template keeps the geometry it had rather than being left with none. The
  // outcome is REPORTED either way — a forced replace that moves slot positions
  // without saying so would be the same silent-change problem the 409 exists to
  // prevent.
  //
  // Not guarded: replacing ONE HALF of a front's clean/filled pair. Detection
  // finds text by diffing the two, so a mismatched pair yields a confident,
  // wrong answer rather than an error — nothing here can tell it from a good
  // one. Re-exporting both halves together is the owner's discipline, which is
  // why the outcome is surfaced instead of trusted.
  // Re-detection is OPT-IN now, not automatic. It costs 18 Chrome start-ups —
  // every card's clean/filled pair rendered separately — which measured 38s on a
  // developer laptop and longer in the container, and it ran on EVERY file
  // replace. Re-uploading nine filled files meant nine full detection passes
  // before the owner could do anything. The admin panel has an explicit
  // "detect again" button instead, so the cost is paid once, when it is wanted.
  let redetect = null;
  if (isCardSvgRole(role) && cardStructureOf(entry) === 'cards' && redetectOnReplace === true) {
    const r = runRecipeDiff({
      root,
      slug: key,
      cards: true,
      pythonBin,
      runner: recipeRunner,
    });
    redetect = { ok: !!r.ok, detail: r.ok ? null : r.detail || null };
  }

  return { key, role, path: displayPath(root, abs), redetect };
}

// -- Minimal multipart/form-data parser (no external dependency) --------------
// Splits a raw body Buffer on the boundary and returns { fields, files,
// fileLists }, where fields[name] = string, files[name] = { filename, data } (the
// LAST part with that name, as before) and fileLists[name] = EVERY part with that
// name in order. The list is what makes a single <input type="file" multiple>
// usable — the owner picks all nine card SVGs at once and they arrive as nine
// parts sharing one name, of which `files` can only keep the last. Kept small and
// self-contained so the server needs no multer/busboy dependency.
function parseMultipart(buf, boundary) {
  const fields = {};
  const files = {};
  const fileLists = {};
  if (!Buffer.isBuffer(buf) || !boundary) return { fields, files, fileLists };
  const delimiter = Buffer.from('--' + boundary);
  let idx = buf.indexOf(delimiter);
  if (idx < 0) return { fields, files, fileLists };
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
        if (fileM) {
          const file = { filename: fileM[1], data: body };
          files[nameM[1]] = file;
          if (!fileLists[nameM[1]]) fileLists[nameM[1]] = [];
          fileLists[nameM[1]].push(file);
        } else fields[nameM[1]] = body.toString('utf8');
      }
    }
    idx = next + delimiter.length;
  }
  return { fields, files, fileLists };
}

// Extract the boundary token from a multipart Content-Type header.
function boundaryFromContentType(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  return m ? (m[1] || m[2]).trim() : null;
}

module.exports = {
  inStore,
  isSafeSlug,
  NAME_FORMS,
  SVG_ROLES,
  CARD_STRUCTURES,
  CARD_FILE_NUMBERS,
  CARD_FRONT_NUMBERS,
  CARD_BACK_NUMBER,
  CARD_VIEWBOX,
  CARD_WORD_SLOTS,
  cardStructureOf,
  validateCardSlots,
  filledImageRel,
  templateImagePath,
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
  redetectTemplate,
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
