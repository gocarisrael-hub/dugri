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

// Whether a string is safe to LOOK UP as an existing themes.json key.
//
// isSafeSlug is the rule for a key we are about to CREATE, and it is right to
// stay strict there. It is the wrong rule for reading one that already exists:
// the shipped "trip comeback" is keyed with a space, so a route that gated on
// isSafeSlug refused it — which is why that one template's asset thumbnails all
// came back 404 and its checklist showed no pictures.
//
// The safety a lookup actually needs is that the string cannot escape a
// directory. Callers still resolve through an exact themes lookup and check the
// resolved file stays inside the template dir, so this only has to rule out the
// path-shaped inputs.
function isSafeThemeKey(key) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 64) return false;
  if (key !== key.trim()) return false;
  if (key === '.' || key === '..') return false;
  return !/[/\\]/.test(key) && !key.includes('\0');
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
// The font roles the onboarding form uploads. The two `_alt` ones are OPTIONAL
// second faces (a Latin face for English words, a second title face for a title
// in the other language); a template that ships neither is byte-for-byte what
// onboarding has always produced.
const FONT_ROLES = ['title', 'word', 'title_alt', 'word_alt'];

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

// ---- PER-FRONT BACKS: eight styles, each with its OWN back ------------------
// The layout above gives a deck ONE back (file 1) shared by all 104 cards. Some
// templates are authored as eight complete card STYLES — a front and a matching
// back each — and there was no way to express that at all, so they could not be
// uploaded.
//
// The numbering is ADDITIVE, never a reinterpretation: 1 stays the shared back
// and 2–9 stay the fronts on every template that exists, and a paired template
// adds its backs as 10–17. So a file number means exactly one thing everywhere,
// and reading a template dir never depends on knowing which mode it is in.
//
// The pairing is POSITIONAL and fixed: backs[i] prints on the reverse of
// fronts[i] — 10 with 2, 11 with 3, … 17 with 9 — so a card can never come out
// carrying another style's back. generator/config.py back_indices() is the
// other half of this contract; build.py zips the two lists.
const CARD_PAIRED_BACK_NUMBERS = [10, 11, 12, 13, 14, 15, 16, 17];
// How a template's backs are organised. 'shared' is every template today, and is
// simply the absence of a `cards.backs` list rather than a stored default.
const CARD_BACK_MODES = ['shared', 'per-front'];
// The back paired with a given front, by position in the two ranges.
function pairedBackFor(front) {
  const i = CARD_FRONT_NUMBERS.indexOf(Number(front));
  return i < 0 ? null : CARD_PAIRED_BACK_NUMBERS[i];
}

// ---- ONE-FRONT mode: the whole deck on a single front design ----------------
// Most decks want eight fronts that differ by a thin icon layer. Some want ONE
// design on every card — and the owner should not have to upload eight
// near-identical exports (plus their eight filled twins) to say so.
//
// The deck does NOT need nine copies of the same file. build.py picks a card's
// front with `fronts[card["front"] % len(fronts)]`, so a template whose `fronts`
// list holds ONE index lands every one of the 103 word cards on that index by
// arithmetic. Duplicating one export to eight names would bloat the image, the
// volume and every render, and the eight copies would drift apart the first time
// anyone edited one.
//
// So one-front mode is a NARROWER FRONT LIST, not a copy: the upload takes
// 2.svg (the front) + 1.svg (the back) in clean and filled — four files — and
// the theme entry records `cards: {back: 1, fronts: [2]}`. Everything downstream
// (asset checklist, calibration, detection, the render) reads the entry's front
// list, so an eight-front template is byte-for-byte what it always was: it
// writes NO `cards` block at all and keeps the [2..9] default.
const CARD_FRONT_MODES = ['all', 'one'];
const DEFAULT_CARD_FRONT_MODE = 'all';
// Which numbered file one-front mode uses as THE front. 2 by contract — the
// first front of the normal set, which is also the file the storefront's product
// picture and the calibration preview already read.
const SINGLE_FRONT_NUMBERS = [CARD_FRONT_NUMBERS[0]];
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

// The front indices a 'cards' theme entry actually renders, in order. Mirrors
// the generator's `config.fronts` EXACTLY (`cards.fronts` first, then the legacy
// flat `fronts`, then the [2..9] default), so the admin's checklist, calibration
// form and validators can never disagree with what the deck will print.
// Anything unparseable, out of range or naming the BACK is dropped rather than
// trusted — a bad value would otherwise become a filename.
function entryFrontNumbers(entry) {
  const cards = entry && entry.cards && typeof entry.cards === 'object' ? entry.cards : {};
  const raw = Array.isArray(cards.fronts)
    ? cards.fronts
    : Array.isArray(entry && entry.fronts)
      ? entry.fronts
      : null;
  if (!raw) return [...CARD_FRONT_NUMBERS];
  const out = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || !CARD_FRONT_NUMBERS.includes(n)) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.length ? out : [...CARD_FRONT_NUMBERS];
}

// The numbered files a template with these fronts must ship: the back + each
// front. One-front mode therefore needs four files (1 + 2, clean + filled)
// where the normal set needs eighteen.
//
// With PER-FRONT backs the shared back (file 1) is not part of the deck at all —
// every card takes its own style's back — so it is replaced by one back per
// front rather than added to. Asking for a shared back that nothing prints would
// show the owner a required slot they can never meaningfully fill.
function cardFileNumbersFor(fronts, backs) {
  const list = Array.isArray(backs) && backs.length ? backs : null;
  return list ? [...fronts, ...list] : [CARD_BACK_NUMBER, ...fronts];
}

// The per-front back list an entry declares, positionally paired with its
// fronts. Empty when the template shares one back — which is every template that
// existed before this, so nothing changes for them.
function entryBackNumbers(entry) {
  const cards = entry && entry.cards && typeof entry.cards === 'object' ? entry.cards : {};
  const raw = Array.isArray(cards.backs) ? cards.backs : null;
  if (!raw) return [];
  const allowed = new Set(CARD_PAIRED_BACK_NUMBERS);
  const out = [];
  for (const v of raw) {
    const n = Number(v);
    if (!Number.isInteger(n) || !allowed.has(n)) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// Does this entry give each front its own back?
function entryHasPerFrontBacks(entry) {
  return entryBackNumbers(entry).length > 0;
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
  titleFontAlt,
  wordFontAlt,
  language,
  nameForm,
  extraFields,
  visibility,
  cardStructure,
  cardFrontMode,
}) {
  const lines = String(titleText || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  // Only a 'cards' template records the key (plus its empty per-card slot blob).
  // A legacy upload writes NO card_structure at all, so its entry is byte-for-byte
  // what onboarding has always produced.
  //
  // ONE-FRONT mode additionally pins the deck's front list to a single index —
  // the generator's own `cards` block, which is what makes every card land on
  // that one design. An eight-front template writes no `cards` block at all, so
  // it keeps reading the [2..9] default exactly as before.
  const structure =
    cardStructure === 'cards'
      ? {
          card_structure: 'cards',
          ...(cardFrontMode === 'one'
            ? { cards: { back: CARD_BACK_NUMBER, fronts: [...SINGLE_FRONT_NUMBERS] } }
            : {}),
          card_slots: null,
        }
      : {};
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
    // The optional second faces are written ONLY when one was actually uploaded:
    // an entry carrying `title_font_alt: ""` reads as "there is a second face"
    // to every consumer that does a truthiness check, and an absent key is what
    // the generator's resolvers expect to see for "this template has none".
    ...(titleFontAlt ? { title_font_alt: titleFontAlt } : {}),
    ...(wordFontAlt ? { word_font_alt: wordFontAlt } : {}),
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
// The argv + output path for one detection run, WITHOUT running it. Split out so
// the synchronous caller below and the asynchronous job runner
// (server/redetect-job.js) build exactly the same command — a second hand-rolled
// argv is how the recipe-name-vs-key bug below would come back on one path only.
function recipeDiffPlan({ root, slug, recipeName, cards = false }) {
  const script = path.join(root, 'generator', 'recipe_diff.py');
  const dir = resolveTemplateDirBySlug(root, slug);
  const filled = path.join(dir, 'filled', 'fronts.svg');
  const clean = path.join(dir, 'clean', 'fronts.svg');
  // Detection must write the file the GENERATOR reads, which is named by the
  // theme's `recipe` field — NOT by its key. The two are the same for every
  // template onboarded through the panel, and differ for a shipped one:
  // "trip comeback" is keyed with a space and its recipe is "trip". Writing by
  // key put a fresh single-card recipe in "trip comeback.json" while the
  // renderer went on reading the old 8-up "trip.json", so pressing "detect
  // again" appeared to succeed and changed nothing — the card then previewed
  // with no title and no words, because the recipe actually in use had no
  // single-card geometry at all.
  const name = recipeName || slug;
  const out = store.ownerRecipePath(name) || path.join(recipesDirFor(root), name + '.json');
  // A single-card template has no fronts.svg sheet to diff: the detector takes
  // the template DIRECTORY and walks clean/filled 1..9 itself, reconciling the
  // four shared word slots across the eight fronts and keeping each front's own
  // title box.
  const args = cards ? [script, '--single', dir, name] : [script, filled, clean, name];
  return { script, args, out };
}

// What a finished detection run MEANS, given the spawn result. `result` is the
// spawnSync-shaped { status, stdout, stderr } — the async runner normalises to
// the same shape, so success/failure is decided in one place for both.
function recipeDiffOutcome({ root, slug, out, result }) {
  const ok = !!result && result.status === 0 && !!resolveRecipePath(root, slug);
  return {
    ok,
    recipe: resolveRecipePath(root, slug) || out,
    timedOut: !ok && !!(result && result.timedOut),
    detail: ok ? null : failureDetail(result, 'recipe failed'),
  };
}

// The one sentence that explains a failed run, with the ONE thing that must never
// be lost said first.
//
// `detail` is sliced to 800 characters so a runaway traceback cannot fill a
// response — and the runner used to report a kill by APPENDING "(timed out …)"
// to stderr, i.e. at the very end, which is exactly what that slice throws away.
// A run reclaimed by its own ceiling then read as an ordinary detector crash, and
// "the ceiling is too low for this deck" — the actionable half — never reached
// anybody. Timeouts lead now, and the child's own output follows for context.
function failureDetail(result, fallback) {
  const raw = String((result && (result.stderr || result.stdout)) || fallback);
  if (result && result.timedOut) {
    const secs = result.timeoutMs ? Math.round(result.timeoutMs / 1000) : null;
    return (
      'TIMED OUT' +
      (secs ? ' after ' + secs + 's' : '') +
      ' and was killed — nothing was written. ' +
      raw
    ).slice(0, 800);
  }
  return raw.slice(0, 800);
}

function runRecipeDiff({
  root,
  slug,
  recipeName,
  pythonBin = 'python3',
  timeoutMs = 120000,
  runner,
  cards = false,
}) {
  const { args, out } = recipeDiffPlan({ root, slug, recipeName, cards });
  let result;
  try {
    const run = runner || spawnSync;
    result = run(pythonBin, args, { cwd: root, timeout: timeoutMs, encoding: 'utf8' });
  } catch (e) {
    return { ok: false, recipe: out, detail: String((e && e.message) || e) };
  }
  return recipeDiffOutcome({ root, slug, out, result });
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
// Argv + scratch path for one calibration run — the counterpart to
// `recipeDiffPlan`, shared by the synchronous and asynchronous callers.
function calibratePlan({ root, slug }) {
  const script = path.join(root, 'generator', 'calibrate.py');
  const out = path.join(os.tmpdir(), 'dugri-calibrate-' + Date.now() + '.json');
  return { script, args: [script, slug, '--out', out], out };
}

// What a finished calibration run means, and the cleanup of its scratch file.
function calibrateOutcome({ out, result }) {
  if (!result || result.status !== 0 || !fs.existsSync(out)) {
    return {
      ok: false,
      timedOut: !!(result && result.timedOut),
      detail: failureDetail(result, 'calibrate failed'),
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

function runCalibrate({ root, slug, pythonBin = 'python3', timeoutMs = 180000, runner }) {
  const { args, out } = calibratePlan({ root, slug });
  let result;
  try {
    const run = runner || spawnSync;
    result = run(pythonBin, args, {
      cwd: root,
      timeout: timeoutMs,
      encoding: 'utf8',
    });
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) };
  }
  return calibrateOutcome({ out, result });
}

// Is this knob an ANSWER the owner gave, or the value every untouched template
// carries? Used only to decide what is worth naming on screen: a warning printed
// after every run is one nobody reads by the third.
function isSetKnob(v) {
  if (v == null || v === false || v === 0) return false;
  if (Array.isArray(v)) return v.some((n) => n !== 0);
  return true;
}

// Merge auto-detected calibration into a theme entry. Only the keys the detector
// actually measured are written — it deliberately OMITS what it cannot measure
// rather than guessing, so an absent key must stay absent instead of being
// written as null and reading like a deliberate "no board title".
// `calibrated` is never touched here.
//
// Returns { entry, rejected, kept } — the merge's own outcome, not just the
// entry. A calibration that RAN fine and then had half its measurements refused
// or skipped is the failure the owner actually experiences ("I pressed the
// button and nothing changed"), and it has to be able to reach her screen.
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
  // Surfaces this run could NOT read, whose previously calibrated value was
  // therefore left alone. Reported for the same reason `rejected` is: "I did not
  // measure the board this time" and "the board has no title" are different
  // facts, and only one of them is a reason for the owner to go and look.
  const kept = [];
  // title_style is validated as a WHOLE and written as a whole, so every knob the
  // measurement does not carry disappeared from the entry on each run. Two of
  // them — `italic` and `offset` — calibrate.py never emits at all (it says so:
  // arch, offset and pinned sizes "are not measurable and are left for the owner
  // by design"), so a knob the owner had set BY HAND was erased every time she
  // pressed the button, silently, on top of nothing visibly changing. Absent is
  // "unknown", never "clear it" — here as for board/back below. The old keys are
  // re-validated with the new ones rather than pasted on afterwards, so the pair
  // can only land if it is a legal style; if the carried-forward value makes the
  // whole thing invalid, the measurement alone still wins.
  const oldStyle =
    entry.title_style && typeof entry.title_style === 'object' && !Array.isArray(entry.title_style)
      ? entry.title_style
      : null;
  const ts = validateTitleStyle(blob.title_style);
  if (!ts.error) {
    const carried = oldStyle ? Object.keys(oldStyle).filter((k) => !(k in ts.value)) : [];
    if (carried.length) {
      const merged = validateTitleStyle({ ...oldStyle, ...blob.title_style });
      entry.title_style = merged.error ? ts.value : merged.value;
      // Named on screen only when carrying it forward actually preserved a
      // CHOICE. Every uncalibrated template carries `italic:false`, and a
      // warning printed after every single run is one nobody reads by the third.
      if (!merged.error) {
        kept.push(...carried.filter((k) => isSetKnob(oldStyle[k])).map((k) => 'title_style.' + k));
      }
    } else {
      entry.title_style = ts.value;
    }
  } else if (blob.title_style) rejected.push('title_style (' + ts.error + ')');
  for (const slot of ['board', 'back']) {
    if (!(slot in blob)) continue;
    // A null here is "unknown", never "clear it". calibrate.py emits
    // `board: null` with confidence "none" when it cannot isolate a title —
    // see its own note, "either this design carries no board title, or the
    // filled and clean boards differ across the whole sheet" — i.e. it does not
    // know which. Writing that through DELETED a working slot: press
    // "זהה מחדש" on a template whose board title the detector happens not to
    // find, and the honoree's name stops printing on the board, from a button
    // pressed to improve it. Keep what is there, and say the surface went
    // unmeasured. The owner can still clear it by hand in the form — detection
    // proposes, she disposes.
    if (blob[slot] === null) {
      if (entry[slot]) kept.push(slot);
      continue;
    }
    const v = validateSlot(blob[slot], slot);
    if (!v.error) entry[slot] = v.value;
    else rejected.push(slot + ' (' + v.error + ')');
  }
  // PER-BACK slots. A deck whose eight card styles each have their OWN back
  // carries its back title geometry in `backs`, keyed by card file number, and
  // the generator reads it (generator/config.py `_OVERRIDABLE`). calibrate.py
  // measures every one of them separately — and this merge did not know the key
  // existed, so all eight measurements were dropped on the floor while the run
  // reported success. That is most of "I pressed זהה מחדש again and again and
  // the title never changed": on מרקאנה the card BACK is where the name is
  // printed large, its box and size live here, and re-detection never wrote them.
  //
  // Merged per back rather than replaced wholesale, so one unreadable back
  // cannot cost the other seven their calibration.
  if (blob.backs && typeof blob.backs === 'object' && !Array.isArray(blob.backs)) {
    const measured = {};
    for (const [n, slot] of Object.entries(blob.backs)) {
      // Same rule as board/back above: null means "could not read this one".
      if (slot === null) {
        if (entry.backs && entry.backs[n]) kept.push('backs.' + n);
        continue;
      }
      measured[n] = slot;
    }
    const v = validateBacks(measured, 'backs');
    if (v.error) rejected.push('backs (' + v.error + ')');
    else if (Object.keys(v.value).length) {
      entry.backs = {
        ...(entry.backs && typeof entry.backs === 'object' ? entry.backs : {}),
        ...v.value,
      };
    }
  }
  if (typeof blob.word_size === 'number' && blob.word_size > 0) entry.word_size = blob.word_size;
  // The detected single-card geometry. Without this the detector measured the
  // slots correctly, wrote them into its blob, and the merge silently dropped
  // them — so the admin form kept opening on its hardcoded defaults (boxes
  // roughly twice the real width) and the preview came back with giant words and
  // a title clipped off both card edges. Validated through the same guard the
  // form's own save uses, so a bad blob can't write geometry the form would have
  // rejected.
  //
  // A refusal here must SAY SO, exactly like title_style and the slots above.
  // It used to be the one branch with no `else`, and the gap was not academic:
  // validateCardSlots refuses a titles map missing any front, so a deck with one
  // unmeasurable card (מרקאנה's front 9, whose clean plate is exported at a
  // different scale from its filled twin) had its ENTIRE card_slots block
  // dropped — words included — while the run still reported calibrated: true.
  // The owner pressed "זהה מחדש", was told it worked, and the geometry never
  // moved, with nothing anywhere naming the front that caused it.
  if ('card_slots' in blob) {
    const cs = validateCardSlots(blob.card_slots, entryFrontNumbers(entry));
    if (!cs.error) entry.card_slots = cs.value;
    else if (blob.card_slots) rejected.push('card_slots (' + cs.error + ')');
  }
  // Advisory, for the form's "check this one" flags — not render inputs.
  if (blob.confidence && typeof blob.confidence === 'object') entry.confidence = blob.confidence;
  if (Array.isArray(blob.notes)) entry.notes = blob.notes.filter((s) => typeof s === 'string');
  if (rejected.length) {
    // The "cannot render" tail is about title_style specifically, so it is only
    // said when title_style is what was refused. A rejected card_slots leaves a
    // template that renders perfectly well on its previous geometry, and telling
    // the owner it cannot render would send her hunting for a fault that is not
    // there.
    entry.notes = (entry.notes || []).concat(
      'measured but REJECTED as invalid, so the old value was kept: ' +
        rejected.join('; ') +
        '. Fill these in by hand' +
        (rejected.some((r) => r.startsWith('title_style'))
          ? ' — the template cannot render until title_style is set.'
          : '.')
    );
  }
  if (kept.length) {
    entry.notes = (entry.notes || []).concat(
      'NOT MEASURED this run, so the value already calibrated was kept: ' +
        kept.join('; ') +
        '. If the artwork changed here, set it by hand.'
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
  // The MERGE'S OWN OUTCOME, handed back so a caller can say it out loud.
  // `entry` is kept on the report because two callers already read it; what is
  // new is that "the run succeeded and threw four of its measurements away" can
  // now reach the screen instead of living only in a note inside themes.json.
  return { entry, rejected, kept };
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
  // A TITLE TEMPLATE IS OPTIONAL NOW. It existed to compose a title out of the
  // honoree's name, their gender and a per-theme extra field; the buyer types the
  // title and nothing else, so a template registered today has nothing to
  // compose and declares none. Themes that predate the change keep theirs and
  // keep rendering it — that is what makes the orders placed before it print
  // exactly as they did.
  const titleText = String((fields && fields.title_text) || '').trim();
  // name_form casts {NAME} into the design's script. With no {NAME} to cast it
  // is meaningless, so it is required only alongside a title template.
  const nameForm = String((fields && fields.name_form) || '').trim();
  if (titleText && !NAME_FORMS.includes(nameForm)) {
    return { error: 'name_form must be one of: ' + NAME_FORMS.join(', ') };
  }
  if (nameForm && !NAME_FORMS.includes(nameForm)) {
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
  // The TITLE, checked against the extra fields this same form declares — the
  // origin of the "'s Birthday" bug. Onboarding used to accept ANY non-empty
  // string, so a title with no {NAME} (or with a placeholder the wizard never
  // collects) registered silently and printed a gap on every card. Refusing it
  // here is what stops the broken template from being created in the first place;
  // `allow_titleless` is the explicit confirmation for the legitimate case of a
  // deck whose artwork carries no name at all.
  const titleCheck = titleText
    ? validateTitle({
        titleText,
        extraFields,
        allowNoName: isTruthyFlag(fields && fields.allow_titleless),
      })
    : { title_text: '', title_lines: [] };
  if (titleCheck.error) {
    return { error: titleCheck.error, ...(titleCheck.titleless ? { titleless: true } : {}) };
  }
  // Asset layout. Explicit only — an absent/unknown value is the legacy sheet
  // layout, so nothing that already registers templates has to change.
  const rawStructure = String((fields && fields.card_structure) || '').trim();
  if (rawStructure && !CARD_STRUCTURES.includes(rawStructure)) {
    return { error: 'card_structure must be one of: ' + CARD_STRUCTURES.join(', ') };
  }
  const cardStructure = rawStructure || DEFAULT_CARD_STRUCTURE;
  // How many FRONT designs the deck has: 'all' (the eight numbered fronts) or
  // 'one' (a single front used by every card). Explicit only, and meaningless
  // outside the 'cards' layout — a sheet template has no numbered fronts to
  // narrow, so asking for one is a mistake worth naming rather than ignoring.
  const rawFrontMode = String((fields && fields.card_fronts) || '').trim();
  if (rawFrontMode && !CARD_FRONT_MODES.includes(rawFrontMode)) {
    return { error: 'card_fronts must be one of: ' + CARD_FRONT_MODES.join(', ') };
  }
  if (rawFrontMode === 'one' && cardStructure !== 'cards') {
    return { error: "card_fronts:'one' requires card_structure:'cards'" };
  }
  const cardFrontMode = rawFrontMode || DEFAULT_CARD_FRONT_MODE;
  return {
    slug,
    displayHe,
    // The validated title, newline-joined — identical to the input except for the
    // blank-line/whitespace trimming buildThemeEntry would have done anyway.
    titleText: titleCheck.title_text,
    titleLines: titleCheck.title_lines,
    nameForm,
    language,
    extraFields,
    visibility,
    cardStructure,
    cardFrontMode,
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

// Human name of a numbered card slot, for an owner-facing message. A PAIRED back
// is named by the front it belongs to ("גב 3"), not by its file number — the
// owner thinks in card styles, and 17.svg means nothing to them.
function cardSlotLabel(n) {
  const num = Number(n);
  const paired = CARD_PAIRED_BACK_NUMBERS.indexOf(num);
  if (paired >= 0) return 'גב ' + (paired + 1);
  return num === CARD_BACK_NUMBER ? 'גב הקלף' : 'פנים ' + (num - 1);
}

// Validate the NEW numbered layout's uploads: for the normal eight-front deck,
// 1.svg .. 9.svg in BOTH clean/ and filled/ — eighteen files, of which 1 is the
// back and 2-9 the eight fronts. In ONE-FRONT mode the required set narrows to
// the back plus the single front (1.svg + 2.svg in each layer, four files). The
// board is NOT one of them (it is a separate output file), so it is accepted here
// but never required; a template can be registered deck-first and get its board
// from the per-asset uploader afterwards.
//
// This is an OWNER-FACING tool, so a failure NAMES every file that is missing or
// misnamed instead of stopping at the first one — a cryptic "missing SVG" costs a
// support round-trip. Returns { error } or { clean, filled }.
function normalizeCardUploads({ files, fileLists, fronts }) {
  const wanted = cardFileNumbersFor(fronts && fronts.length ? fronts : CARD_FRONT_NUMBERS);
  const oneFront = wanted.length < CARD_FILE_NUMBERS.length;
  const clean = collectNumberedCardFiles('clean', files, fileLists);
  const filled = collectNumberedCardFiles('filled', files, fileLists);
  const missing = { clean: [], filled: [] };
  const notSvg = [];
  const unused = new Set();
  for (const layer of ['clean', 'filled']) {
    const got = layer === 'clean' ? clean.got : filled.got;
    for (const n of wanted) {
      if (!got[String(n)]) missing[layer].push(n);
      else if (!looksLikeSvg(got[String(n)])) notSvg.push(layer + '/' + n + '.svg');
    }
    // A file this deck has no card for would be written and never rendered — a
    // silent dead asset. Say so instead: it almost always means the mode picker
    // and the files disagree.
    for (const n of CARD_FILE_NUMBERS) {
      if (!wanted.includes(n) && got[String(n)]) unused.add(n);
    }
  }
  const bad = [...clean.bad, ...filled.bad];
  if (missing.clean.length || missing.filled.length || notSvg.length || bad.length || unused.size) {
    const lines = [
      oneFront
        ? 'מצב "אותו עיצוב לכל הקלפים" דורש 4 קבצים: 1.svg (גב הקלף) ו-2.svg (הפנים) בתיקייה ' +
          'clean, ואותם שניים בתיקייה filled. הלוח אינו חלק מהסט הזה.'
        : 'מבנה הקלפים החדש דורש 18 קבצים: 1.svg עד 9.svg בתיקייה clean, ואותם תשעה בתיקייה ' +
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
    if (unused.size) {
      lines.push(
        'קבצים שאינם בשימוש במצב הזה: ' +
          [...unused]
            .sort((a, b) => a - b)
            .map((n) => n + '.svg')
            .join(', ') +
          ' — בחרו "עיצוב שונה לכל קלף" אם רציתם להעלות את כל התשעה.'
      );
    }
    if (notSvg.length) lines.push('לא נראים כמו SVG: ' + notSvg.join(', '));
    return { error: lines.join('\n') };
  }
  const pick = (got) => {
    const out = {};
    for (const n of wanted) out[String(n)] = got[String(n)];
    return out;
  };
  return { clean: pick(clean.got), filled: pick(filled.got) };
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
  // The front mode only means anything on the 'cards' layout; normalizeMetadata
  // already rejected 'one' with an explicit sheet structure, and a SNIFFED sheet
  // upload simply carries the default.
  const cardFrontMode = cardStructure === 'cards' ? meta.cardFrontMode : DEFAULT_CARD_FRONT_MODE;
  const fronts = cardFrontMode === 'one' ? [...SINGLE_FRONT_NUMBERS] : [...CARD_FRONT_NUMBERS];

  const clean = {};
  const filled = {};
  let assets = null;
  if (cardStructure === 'cards') {
    const cards = normalizeCardUploads({ files, fileLists, fronts });
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

  // The two OPTIONAL second faces. Absent is the ordinary case and must stay
  // silent; present is content-validated, because a junk file recorded here
  // would be read by the generator on every later order.
  const altFonts = {};
  for (const [field, role] of [
    ['title_font_alt', 'title_alt'],
    ['word_font_alt', 'word_alt'],
  ]) {
    const f = files && files[field];
    if (!f || !f.data || !f.data.length) continue;
    if (!looksLikeFont(f.data)) {
      return { error: field + ' does not look like a font (.ttf/.otf)' };
    }
    altFonts[role] = { name: f.filename, data: f.data };
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
    cardFrontMode,
    clean,
    filled,
    assets,
    fonts: {
      title: { name: titleFontFile.filename, data: titleFontFile.data },
      word: { name: wordFontFile.filename, data: wordFontFile.data },
      ...altFonts,
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
  // `titleless` rides along: a title with no {NAME} is the ONE rejection the
  // owner may confirm past (allow_titleless), so the route has to be able to tell
  // it from every other 400 and offer the confirmation.
  if (norm.error) {
    return { error: norm.error, httpStatus: 400, ...(norm.titleless ? { titleless: true } : {}) };
  }
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
    titleFontAlt: written.fonts.title_alt,
    wordFontAlt: written.fonts.word_alt,
    language: norm.language,
    nameForm: norm.nameForm,
    extraFields: norm.extraFields,
    visibility: norm.visibility,
    cardStructure: norm.cardStructure,
    cardFrontMode: norm.cardFrontMode,
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
  const oneFront = norm.cardFrontMode === 'one';
  const cardsNote =
    `Template registered as ${visLabel} and UNCALIBRATED, with the ` +
    (oneFront
      ? '4 single-card SVGs (1 = back, 2 = the ONE front every card uses) in place. The deck ' +
        'cycles its front list, and that list holds a single index — so all 103 word cards ' +
        'render on 2.svg with no duplicated artwork. '
      : '18 single-card SVGs (1 = back, 2-9 = fronts) in place. ') +
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
    card_fronts: isCards ? entryFrontNumbers(entry) : null,
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
  // See onboardTemplate: `titleless` is confirmable, every other 400 is not.
  if (meta.error) {
    return { error: meta.error, httpStatus: 400, ...(meta.titleless ? { titleless: true } : {}) };
  }
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
    cardFrontMode: meta.cardFrontMode,
  });
  appendThemeEntry(themesPathFor(root), meta.slug, entry);
  const oneFront = isCards && meta.cardFrontMode === 'one';
  return {
    key: meta.slug,
    dir: 'resources/canva/templates/' + meta.slug,
    calibrated: false,
    visibility: entry.visibility,
    card_structure: meta.cardStructure,
    card_fronts: isCards ? entryFrontNumbers(entry) : null,
    shell: true,
    theme: entry,
    note:
      `Empty template "${meta.slug}" created (${entry.visibility.toUpperCase()}). Upload each ` +
      (oneFront
        ? 'asset (clean/filled 1.svg = the back and 2.svg = the ONE front every card uses, plus ' +
          'the separate board and both fonts) '
        : isCards
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
// The SAME table for the NEW single-card layout: the numbered files (clean/filled
// 1.svg-9.svg, 1 = back and 2-9 = the eight fronts) plus the board, which is NOT
// one of them — it is a separate output file that happens to live in the same
// dir. Board rows keep the exact role ids the sheet layout uses, so board
// upload/replace works identically in both layouts.
//
// Built per FRONT LIST rather than fixed, because a one-front template ships four
// numbered files, not eighteen. Listing all nine for it would report fourteen
// permanently "missing" assets and never let the checklist read complete.
function cardSvgAssetRoles(fronts, backs) {
  return [
    ...['clean', 'filled'].flatMap((layer) =>
      cardFileNumbersFor(fronts, backs).map((n) => ({
        role: layer + '-' + n,
        rel: layer + '/' + n + '.svg',
        kind: 'svg',
        optional: false,
        label: cardSlotLabel(n) + ' · ' + n + '.svg ' + (layer === 'clean' ? '(נקי)' : '(ממולא)'),
      }))
    ),
    ...SVG_ASSET_ROLES.filter(
      (a) => a.role.endsWith('-board') || a.role.endsWith('-board-chasers')
    ),
  ];
}
// The full nine-file table — the WHITELIST of role ids the replace API accepts,
// and what a template with the default front list gets.
const CARD_SVG_ASSET_ROLES = cardSvgAssetRoles(CARD_FRONT_NUMBERS);

// Font roles resolve their path from the theme entry (the filename the generator
// reads out of themes.json), so their `rel` is computed per-entry, not fixed.
//
// The two ALT roles are OPTIONAL, and that flag is load-bearing: a REQUIRED role
// with nothing on record would make computeTemplateStatus report every template
// shipped to date as broken. Uploading nothing must leave a template exactly as
// it renders today — the generator's resolvers (config.resolve_title_font_alt /
// resolve_word_font_alt) return None when the field is absent, and the one-face
// path runs unchanged.
const FONT_ASSET_ROLES = [
  { role: 'title-font', field: 'title_font', kind: 'font', optional: false, label: 'פונט כותרת' },
  {
    role: 'title-font-alt',
    field: 'title_font_alt',
    kind: 'font',
    optional: true,
    label: 'פונט כותרת שני — לכותרת בשפה שהפונט הראשי לא יודע לצייר (רשות)',
  },
  { role: 'word-font', field: 'word_font', kind: 'font', optional: false, label: 'פונט מילים' },
  {
    role: 'word-font-alt',
    field: 'word_font_alt',
    kind: 'font',
    optional: true,
    label: 'פונט למילים באנגלית — כל מילה באנגלית תודפס בו (רשות)',
  },
];
// The alt roles are the ONLY ones an owner may remove. They are additive, and a
// font uploaded to the wrong template (which has happened) has to be undoable
// without support. Removing a REQUIRED font would leave a template that cannot
// render at all, so that stays impossible.
const REMOVABLE_ROLES = new Set(FONT_ASSET_ROLES.filter((a) => a.optional).map((a) => a.role));
// Whitelist of replaceable role ids — the ONLY roles the replace API accepts.
// Covers BOTH layouts' ids; whether a given role belongs to the template being
// edited is a separate, per-entry check in replaceAsset (a numbered role posted
// at a sheet template is rejected with an explanation, not silently written).
const REPLACEABLE_ROLES = new Set(
  [
    ...SVG_ASSET_ROLES,
    ...CARD_SVG_ASSET_ROLES,
    // The per-front backs are not in the default nine-file table, so whitelist
    // their roles explicitly — otherwise the replace API would reject the very
    // uploads this layout exists for.
    ...cardSvgAssetRoles(CARD_FRONT_NUMBERS, CARD_PAIRED_BACK_NUMBERS),
    ...FONT_ASSET_ROLES,
  ].map((a) => a.role)
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
  // A template CONVERTED to the single-card layout must not have the shipped
  // sheet's fronts.svg/backs.svg copied (or healed) back in: the additive backfill
  // below runs on every asset write, so without this filter a pruned sheet file
  // reappears the moment the owner uploads their first card.
  const skip = obsoleteLayoutRels(entry);
  const filter = skip.size
    ? (src) => !skip.has(path.relative(shipped, src).split(path.sep).join('/'))
    : undefined;
  if (!fs.existsSync(owner)) {
    if (hasShipped) fs.cpSync(shipped, owner, { recursive: true, filter });
    else fs.mkdirSync(owner, { recursive: true });
  } else if (hasShipped) {
    try {
      fs.cpSync(shipped, owner, { recursive: true, force: false, errorOnExist: false, filter });
    } catch {
      /* best-effort heal: a write must still proceed on its own assets */
    }
  }
  return owner;
}

// The files the entry's CURRENT layout has no use for, relative to the template
// dir. Only the sheet↔cards direction is described: a `cards` entry never reads
// the sheet's fronts.svg/backs.svg (its cards are the numbered files, and the
// board is shared by both layouts). A sheet entry is left alone — nothing is
// pruned from a template that was never converted.
function obsoleteLayoutRels(entry) {
  if (!entry || cardStructureOf(entry) !== 'cards') return new Set();
  return new Set(['clean/fronts.svg', 'clean/backs.svg', 'filled/fronts.svg', 'filled/backs.svg']);
}

// Delete the previous layout's now-dead SVGs from the WRITABLE dir. Best-effort
// by design: this is housekeeping, and a template whose conversion is otherwise
// complete must never fail to save because a stale file could not be unlinked.
// The shipped image is never touched — only the owner's copy — so the files are
// gone from what the generator and the checklist read, which is what "replace"
// means here. Returns the rels actually removed (for the caller's report).
function pruneObsoleteLayoutAssets(root, entry, key) {
  const rels = obsoleteLayoutRels(entry);
  if (!rels.size) return [];
  // ONLY the owner's copy, never the shipped image dir — deleting there would
  // destroy repo-committed artwork on any checkout running without DATA_DIR, and
  // a shipped sheet file is harmless anyway: a `cards` entry never reads it, and
  // templateWriteDir's filter keeps it from being copied across later.
  // Resolved WITHOUT templateWriteDir, which would copy the shipped dir in first
  // and re-create the very files being pruned.
  if (!store.enabled()) return [];
  const dir = store.ownerTemplateDir(key);
  if (!dir || !fs.existsSync(dir)) return [];
  const removed = [];
  for (const rel of rels) {
    const abs = path.resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dir + path.sep)) continue; // never escape the dir
    try {
      if (fs.existsSync(abs)) {
        fs.rmSync(abs, { force: true });
        removed.push(rel);
      }
    } catch {
      /* best-effort */
    }
  }
  return removed;
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
// numbered single cards the entry's front list actually calls for — so an entry
// with no `card_structure` yields exactly the list it always did, and one with no
// `cards` block still gets all eighteen.
function assetRolesFor(entry) {
  const table =
    cardStructureOf(entry) === 'cards'
      ? cardSvgAssetRoles(entryFrontNumbers(entry), entryBackNumbers(entry))
      : SVG_ASSET_ROLES;
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

// ---- Which scripts a font can actually draw ---------------------------------
// The whole reason the second faces exist: מרקאנה's title font is League Spartan,
// which has NO Hebrew glyphs, and its title is "{NAME}'s B-day". A Hebrew honoree
// name has nowhere to go, so the back title does not print at all — and nothing
// in the admin screen said so. Reading the font's own character map turns that
// into something the owner can SEE before she sells the design.
//
// Reads the sfnt `cmap` table directly (formats 4/12/6/0 — every one a real .ttf
// /.otf uses) and asks whether a small sample of Hebrew and Latin letters is
// mapped to a glyph. Deliberately a COVERAGE question, not a rendering one:
// generator/calibrate.py `_covers()` answers the same question by drawing the
// text with Pillow and looking for ink, which is stricter but needs Python and
// the font loaded. Two readings of one fact — if a sibling change surfaces
// `_covers` over an API, collapse this into it rather than keeping both.
//
// Returns { hebrew, latin } or null when the file cannot be parsed. Null means
// "unknown" everywhere downstream; it must never read as "broken".
const HEBREW_SAMPLE = [0x05d0, 0x05de, 0x05ea]; // א מ ת
const LATIN_SAMPLE = [0x41, 0x61, 0x7a]; // A a z

// The sfnt table directory: tag -> { offset, length }. Handles a TrueType
// COLLECTION ('ttcf') by reading the first font in it.
function sfntTables(buf) {
  let base = 0;
  if (buf.slice(0, 4).toString('latin1') === 'ttcf') base = buf.readUInt32BE(12);
  const numTables = buf.readUInt16BE(base + 4);
  const out = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    out.set(buf.slice(rec, rec + 4).toString('latin1'), {
      offset: buf.readUInt32BE(rec + 8),
      length: buf.readUInt32BE(rec + 12),
    });
  }
  return out;
}

// The best UNICODE cmap subtable's absolute offset, or null. Preference order is
// the usual one: (3,10) full-repertoire, (3,1) BMP, (0,*) Unicode, (3,0) symbol.
function pickCmapSubtable(buf, cmapOff) {
  const n = buf.readUInt16BE(cmapOff + 2);
  const ranked = [];
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const off = cmapOff + buf.readUInt32BE(rec + 4);
    let rank = null;
    if (platform === 3 && encoding === 10) rank = 0;
    else if (platform === 3 && encoding === 1) rank = 1;
    else if (platform === 0) rank = 2;
    else if (platform === 3 && encoding === 0) rank = 3;
    if (rank !== null) ranked.push([rank, off]);
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => a[0] - b[0]);
  return ranked[0][1];
}

// Does this cmap subtable map `cp` to a real glyph (id != 0)?
function cmapHasGlyph(buf, sub, cp) {
  const format = buf.readUInt16BE(sub);
  if (format === 4) {
    if (cp > 0xffff) return false;
    const segX2 = buf.readUInt16BE(sub + 6);
    const ends = sub + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let s = 0; s < segX2; s += 2) {
      if (buf.readUInt16BE(ends + s) < cp) continue;
      if (buf.readUInt16BE(starts + s) > cp) return false;
      const delta = buf.readInt16BE(deltas + s);
      const ro = buf.readUInt16BE(ranges + s);
      if (ro === 0) return ((cp + delta) & 0xffff) !== 0;
      const gidAt = ranges + s + ro + (cp - buf.readUInt16BE(starts + s)) * 2;
      const gid = buf.readUInt16BE(gidAt);
      return gid !== 0 && ((gid + delta) & 0xffff) !== 0;
    }
    return false;
  }
  if (format === 12) {
    const groups = buf.readUInt32BE(sub + 12);
    for (let i = 0; i < groups; i++) {
      const g = sub + 16 + i * 12;
      const start = buf.readUInt32BE(g);
      if (start > cp) return false;
      if (buf.readUInt32BE(g + 4) >= cp) return buf.readUInt32BE(g + 8) + (cp - start) !== 0;
    }
    return false;
  }
  if (format === 6) {
    const first = buf.readUInt16BE(sub + 6);
    const count = buf.readUInt16BE(sub + 8);
    if (cp < first || cp >= first + count) return false;
    return buf.readUInt16BE(sub + 10 + (cp - first) * 2) !== 0;
  }
  if (format === 0) {
    if (cp > 0xff) return false;
    return buf[sub + 6 + cp] !== 0;
  }
  return false;
}

function fontScriptCoverage(buf) {
  try {
    if (!looksLikeFont(buf)) return null;
    const cmap = sfntTables(buf).get('cmap');
    if (!cmap) return null;
    const sub = pickCmapSubtable(buf, cmap.offset);
    if (sub === null) return null;
    const has = (cp) => cmapHasGlyph(buf, sub, cp);
    return { hebrew: HEBREW_SAMPLE.every(has), latin: LATIN_SAMPLE.every(has) };
  } catch {
    // A truncated/exotic font is UNKNOWN, never "missing Hebrew" — a wrong
    // warning on the screen she uses to decide what to fix is worse than none.
    return null;
  }
}

// Coverage for a font on disk, cached on (size, mtime) so listing every template
// does not re-read a dozen multi-megabyte files on each admin page load.
const FONT_COVERAGE_CACHE = new Map();
function fontCoverageAt(abs) {
  try {
    const st = fs.statSync(abs);
    const sig = st.size + ':' + st.mtimeMs;
    const hit = FONT_COVERAGE_CACHE.get(abs);
    if (hit && hit.sig === sig) return hit.cov;
    const cov = fontScriptCoverage(fs.readFileSync(abs));
    FONT_COVERAGE_CACHE.set(abs, { sig, cov });
    return cov;
  } catch {
    return null;
  }
}

// The font gaps worth telling the owner about, as ready-to-show Hebrew lines.
// Each is a script this template CANNOT draw on a surface, with the upload that
// fixes it named. Only reports what was actually measured: a font whose coverage
// could not be read produces no note at all.
//
// `assets` is the computed asset list (each font role carrying `scripts`).
function fontNotesFrom(assets) {
  const byRole = Object.fromEntries(assets.map((a) => [a.role, a]));
  const cov = (role) => {
    const a = byRole[role];
    return a && a.present ? a.scripts : null;
  };
  const title = cov('title-font');
  const titleAlt = cov('title-font-alt');
  const word = cov('word-font');
  const wordAlt = cov('word-font-alt');
  const notes = [];
  // The מרקאנה case: a Latin display title face on a design sold to Hebrew
  // buyers. The name has nowhere to go and the title does not print.
  if (title && !title.hebrew && !(titleAlt && titleAlt.hebrew)) {
    notes.push({
      role: 'title-font-alt',
      text: 'פונט הכותרת של התבנית לא יודע לצייר עברית — כותרת עם שם בעברית לא תודפס. העלו פונט כותרת שני שיודע עברית.',
    });
  }
  if (title && !title.latin && !(titleAlt && titleAlt.latin)) {
    notes.push({
      role: 'title-font-alt',
      text: 'פונט הכותרת לא יודע לצייר אנגלית — כותרת באנגלית לא תודפס. העלו פונט כותרת שני שיודע אנגלית.',
    });
  }
  if (word && !word.latin && !(wordAlt && wordAlt.latin)) {
    notes.push({
      role: 'word-font-alt',
      text: 'פונט המילים לא יודע לצייר אותיות באנגלית — מילה באנגלית בחפיסה לא תודפס. העלו פונט למילים באנגלית.',
    });
  }
  if (word && !word.hebrew && !(wordAlt && wordAlt.hebrew)) {
    notes.push({
      role: 'word-font',
      text: 'פונט המילים לא יודע לצייר עברית — בדקו שזה באמת הפונט הנכון לתבנית הזאת.',
    });
  }
  return notes;
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
  const assets = roles.map((a) => {
    const present = !!(dir && a.rel && fs.existsSync(path.join(dir, a.rel)));
    return {
      role: a.role,
      label: a.label,
      rel: a.rel,
      kind: a.kind,
      optional: !!a.optional,
      present,
      // The recorded filename, so the screen can show WHICH face is on a role
      // rather than only that something is. With four font roles — two of them
      // optional second faces — "there is a font here" stopped being enough to
      // tell what the template will print with.
      ...(a.kind === 'font' ? { fontName: a.fontName || null } : {}),
      // Which scripts the file can draw (null = could not be read). This is what
      // makes "this title font has no Hebrew" visible before an order is placed.
      ...(a.kind === 'font' && present
        ? { scripts: fontCoverageAt(path.join(dir, a.rel)) }
        : a.kind === 'font'
          ? { scripts: null }
          : {}),
    };
  });
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
    // The honoree TITLE template, so the admin form can show and edit it. Until
    // now neither field was reported at all, which is why a template onboarded
    // with a nameless title could not even be diagnosed from the UI, let alone
    // repaired. `title_lines` is the list the generator renders (one line per
    // entry); `title_text` is the same content newline-joined.
    title_text: (entry && entry.title_text) || '',
    title_lines: Array.isArray(entry && entry.title_lines) ? entry.title_lines : [],
    calibrated: !!(entry && entry.calibrated),
    // Current calibration look-pass values, so the admin form pre-fills on
    // re-edit (null on a fresh, not-yet-calibrated template).
    title_style: (entry && entry.title_style) || null,
    board: (entry && entry.board) || null,
    back: (entry && entry.back) || null,
    // Per-back calibration for a template whose eight styles each have their own
    // back — keyed by card number, `null` inside meaning "this back carries no
    // title". Null (not {}) when the deck shares one back, so the form can tell
    // "not a paired template" from "paired, nothing measured yet".
    backs: (entry && entry.backs) || null,
    word_size: entry && entry.word_size != null ? entry.word_size : null,
    // The owner's line spacing for this deck, or null for the design's own.
    word_pitch: entry && entry.word_pitch != null ? entry.word_pitch : null,
    // Asset layout + the single-card calibration it needs. `card_structure` is
    // always reported (absent on the entry reads as the legacy 'sheet'), so the
    // admin form never has to guess; `card_slots` is the shared word slots +
    // per-front title positions, null until the owner saves them.
    card_structure: cardStructureOf(entry),
    // The front indices this deck actually renders. [2..9] for a normal cards
    // template, a single index for one that uses ONE front design for every
    // card, and null for a legacy sheet. The calibration form iterates THIS
    // rather than a hardcoded 2..9, so it never asks for a title position on a
    // front the deck will never print.
    card_fronts: cardStructureOf(entry) === 'cards' ? entryFrontNumbers(entry) : null,
    // The per-front back list, positionally paired with card_fronts. Empty on a
    // deck that shares one back, so the admin form can tell the two apart.
    card_backs: cardStructureOf(entry) === 'cards' ? entryBackNumbers(entry) : [],
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
    // Script gaps in this template's fonts, already phrased for the owner. Never
    // part of `complete`/`missingRequired`: a template whose title font has no
    // Hebrew is not MISSING a file, it is a design decision that may or may not
    // matter for what it is sold for. Reported, not enforced.
    fontNotes: fontNotesFrom(assets),
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

// ---- The title template ----------------------------------------------------
// A theme entry carries the honoree title in TWO fields, and only one of them is
// read by anything that renders:
//
//   title_lines  AUTHORITATIVE. config.py's `title_lines()` iterates exactly this
//                list, one rendered line per entry, and render_page calibrates the
//                title box against the whole stack. Nothing else is consulted.
//   title_text   The human/source form — the single string the onboarding form
//                collected, newline-separated. NO renderer reads it (grep the
//                generator: it appears only in fixtures).
//
// They could therefore DRIFT, and in the shipped file they already have
// (bachelorette: title_text "{NAME}'S BACHELORETTE" against title_lines
// ["{NAME}'s","Bachelorette"] — the all-caps form prints nowhere). So every write here derives
// title_text FROM the lines rather than storing two independent values: edit the
// lines, and the two can never disagree again.
//
// Placeholders are `{TOKEN}` and are substituted by config.title_lines(): {NAME}
// from the honoree name, everything else from the order's extra fields. A token
// with no value is STRIPPED by the generator's defense-in-depth `re.sub` — which
// is why a title that never had a valid {NAME} in it prints as "'s Birthday" with
// no hint that anything is missing. Catching that at the WRITE is the whole point
// of the validation below.
const MAX_TITLE_LINES = 6;
const MAX_TITLE_LINE = 80;
// A well-formed placeholder token: SHOUTING_SNAKE, which is what config.py's
// substitution map is keyed by. `{name}` / `{Name}` never match a key and would
// be silently stripped at render time, so they are rejected as unknown rather
// than quietly accepted.
const PLACEHOLDER_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/;
// Any brace group at all, well-formed or not — deliberately the SAME pattern the
// generator strips with, so what we validate is exactly what it would erase.
const PLACEHOLDER_ANY_RE = /\{[^{}]*\}/g;
// The one placeholder every theme can always use: the honoree's name.
const NAME_PLACEHOLDER = 'NAME';

// ---- Gender alternation markers -------------------------------------------
// A brace group containing a `|` is NOT a placeholder — it is a GENDER MARKER,
// "{m:בן|f:בת}", carrying its own two labelled forms and resolved from the
// order's honoree gender by generator/config.py `resolve_gender_markers`.
// Hebrew is gendered, so a birthday title has to be able to say בן for a boy and
// בת for a girl from ONE template.
//
// The buyer's recorded gender selects the form with the matching label. An order
// with NO recorded gender falls back to whichever form is written FIRST — the
// template's own default, so a boys' design writes the masculine form first and
// a girls' design the feminine one, with no extra field to configure.
//
// Which is why the labels are MANDATORY here and an unlabelled "{בן|בת}" is
// rejected: the fallback needs the order to be free, so position alone cannot
// also say which form is masculine — and guessing the wording of a word printed
// on 200 cards is not something this should do quietly.
//
// A marker needs no extra field and names no token, so every placeholder check
// below strips markers out first. Otherwise the owner typing "{NAME} {m:בן|f:בת}
// {AGE}" into the admin title box would be told the template does not collect a
// field called "m:בן|f:בת" and the save would be rejected — which is exactly the
// round trip this mechanism depends on.
//
// A stricter cousin of the positional "{female|male}" alternation the site's word
// prompts use (site/js/word-prompts.js `renderQuestion`). Keep the three in step.
const GENDER_MARKER_ANY_RE = /\{[^{}]*\|[^{}]*\}/g;
// "m:" / "male:" / "f:" / "female:" (case-insensitive), mirroring config.py.
const GENDER_FORM_LABEL_RE = /^\s*(m|male|f|female)\s*:/i;
const GENDER_LABEL_OF = { m: 'male', male: 'male', f: 'female', female: 'female' };

// Split a title into render lines: newline-separated, trimmed, blanks dropped.
// Mirrors buildThemeEntry's original split so an edited title lands in exactly
// the shape onboarding produces.
function titleLinesFrom(input) {
  const raw = Array.isArray(input) ? input : String(input == null ? '' : input).split('\n');
  return raw.map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
}

// One title line with its gender markers removed, so placeholder/brace checks
// see only the `{TOKEN}` groups they are about.
function withoutGenderMarkers(line) {
  return String(line == null ? '' : line).replace(GENDER_MARKER_ANY_RE, '');
}

// Every `{TOKEN}` used by a title, in order of first appearance. Gender markers
// are not tokens and are excluded.
function titlePlaceholders(lines) {
  const out = [];
  for (const line of titleLinesFrom(lines)) {
    for (const m of withoutGenderMarkers(line).match(PLACEHOLDER_ANY_RE) || []) {
      const token = m.slice(1, -1).trim();
      if (!out.includes(token)) out.push(token);
    }
  }
  return out;
}

// The SHAPE a usable gender marker has, quoted in every rejection so the fix is
// always in front of whoever hit it. Masculine first here purely as the example.
const GENDER_MARKER_SHAPE = '{m:בן|f:בת}';

// Reject a gender marker the renderer could not honour as written. Every case
// here would otherwise print a wrong or missing word on 200 cards, so it is
// caught at the WRITE, where it can be explained, rather than at the render,
// where it can only be absorbed. Returns an error string, or null when every
// marker is usable.
function badGenderMarker(lines) {
  for (const line of titleLinesFrom(lines)) {
    for (const m of String(line).match(GENDER_MARKER_ANY_RE) || []) {
      const parts = m.slice(1, -1).split('|');
      if (parts.length !== 2) {
        return (
          'the gender marker ' +
          m +
          ' has ' +
          parts.length +
          ' forms — write exactly two, one masculine and one feminine: ' +
          GENDER_MARKER_SHAPE
        );
      }
      const labels = parts.map((p) => {
        const hit = GENDER_FORM_LABEL_RE.exec(p);
        return hit ? GENDER_LABEL_OF[hit[1].toLowerCase()] : null;
      });
      // Unlabelled. The generator would print the first form to EVERYONE, so a
      // girl's deck would silently carry the boy's word — the exact defect the
      // marker exists to remove. Refuse rather than guess which word is which.
      if (labels.some((l) => !l)) {
        return (
          'the gender marker ' +
          m +
          ' does not say which form is which — label them ' +
          GENDER_MARKER_SHAPE +
          ' (m: masculine, f: feminine). The form written FIRST is what prints ' +
          'when an order has no recorded gender, so put this template’s own ' +
          'default first.'
        );
      }
      if (labels[0] === labels[1]) {
        return (
          'the gender marker ' +
          m +
          ' labels both forms ' +
          labels[0] +
          ' — one has to be masculine and the other feminine: ' +
          GENDER_MARKER_SHAPE
        );
      }
    }
  }
  return null;
}

/**
 * Validate a title template against the extra fields the wizard will collect.
 *
 * Returns `{ title_text, title_lines, placeholders, unusedFields }` or `{ error }`.
 *
 * Three failure modes, all of them the class of bug that produced "'s Birthday":
 *  1. EMPTY — a title has to say something.
 *  2. An UNKNOWN placeholder: `{AGE}` on a theme whose extra_fields lacks AGE, or
 *     a mis-cased `{Name}`. The wizard never collects it, so the generator strips
 *     it and the card prints a gap. Named explicitly, with the fix spelled out.
 *  3. NO `{NAME}` at all — legitimate (the "Bride in One Pot" deck carries no name
 *     whatsoever) but never something to arrive at by accident. Allowed only when
 *     the caller passes `allowNoName`, i.e. the owner confirmed it.
 *
 * `unusedFields` is advisory, not an error: an extra field the title never
 * references means the wizard asks the buyer for something nothing prints.
 */
function validateTitle({ titleText, titleLines, extraFields, allowNoName }) {
  const lines = titleLinesFrom(titleLines != null ? titleLines : titleText);
  if (!lines.length) return { error: 'title_text is required' };
  if (lines.length > MAX_TITLE_LINES) {
    return { error: 'title has too many lines (max ' + MAX_TITLE_LINES + ')' };
  }
  const tooLong = lines.find((l) => l.length > MAX_TITLE_LINE);
  if (tooLong) {
    return { error: 'title line too long (max ' + MAX_TITLE_LINE + ' chars): ' + tooLong };
  }
  // Gender markers first: they are brace groups too, so an unusable one has to
  // be named as a MARKER problem before the placeholder checks below report it
  // as a mysterious unknown field.
  const markerError = badGenderMarker(lines);
  if (markerError) return { error: 'title has ' + markerError };
  const fields = Array.isArray(extraFields) ? extraFields : [];
  const known = new Set([NAME_PLACEHOLDER, ...fields]);
  const used = titlePlaceholders(lines);
  for (const token of used) {
    if (!PLACEHOLDER_TOKEN_RE.test(token) || !known.has(token)) {
      return {
        error:
          'title uses {' +
          token +
          '} but the template does not collect it — ' +
          'add ' +
          (PLACEHOLDER_TOKEN_RE.test(token) ? token : 'a valid field name') +
          ' to extra_fields, or fix the placeholder. Available here: ' +
          [...known].map((k) => '{' + k + '}').join(' '),
      };
    }
  }
  // A leftover brace after removing every group means an unclosed one ("{NAME"),
  // which would print raw on the card. Gender markers are removed first — they
  // are legitimate brace groups that PLACEHOLDER_ANY_RE also matches, but an
  // unclosed one ("{בת|בן") must still be caught here rather than left to the
  // generator's last-resort brace stripping.
  const leftover = withoutGenderMarkers(lines.join('\n')).replace(PLACEHOLDER_ANY_RE, '');
  if (leftover.includes('{') || leftover.includes('}')) {
    return { error: 'title has an unclosed { or } — write placeholders as {NAME}' };
  }
  if (!used.includes(NAME_PLACEHOLDER) && !allowNoName) {
    return {
      error:
        'title has no {NAME} placeholder, so every card would print without the ' +
        "honoree's name. Send allow_titleless:true to confirm that is intended.",
      titleless: true,
    };
  }
  return {
    title_text: lines.join('\n'),
    title_lines: lines,
    placeholders: used,
    unusedFields: fields.filter((f) => !used.includes(f)),
  };
}

// Did the owner explicitly confirm a title with no {NAME}? Accepts the boolean
// and the string form a multipart form posts.
function isTruthyFlag(v) {
  return v === true || v === 'true' || v === '1' || v === 1 || v === 'on';
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

// The span of title line spacings that count as a reading rather than a
// mis-measurement, as a fraction of the type size. These ARE calibrate.py's
// `_PITCH_GRID` end points — a value the measurement can return must not be
// refused here, or one rejected field throws away the whole title_style
// (colours and sizes included) and the template reports itself uncalibrated.
const TITLE_LEADING_MIN = 0.3;
const TITLE_LEADING_MAX = 2;

// Validate a title_style blob. Required: fill, outline (hex), outline_w + arch
// (0..1 fractions), shadow (bool). Optional: size / board_size / back_size,
// leading / board_leading / back_leading
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
  // `size_alt` is the cap for a title set in the template's SECOND face — the
  // one a buyer's other-language title reaches (render_page.title_font_for).
  // The two faces have different proportions, so one ceiling cannot suit both.
  for (const k of ['size', 'board_size', 'back_size', 'size_alt']) {
    if (input[k] == null) continue;
    if (!isFiniteNum(input[k]) || input[k] <= 0 || input[k] > 400) {
      return { error: 'title_style.' + k + ' must be a positive size' };
    }
    out[k] = input[k];
  }
  // leading / back_leading / board_leading: the baseline step between a title's
  // lines, as a fraction of the type size, measured off the design's own
  // artwork. One per SURFACE, exactly like the sizes above — a design's front,
  // board and backs are separate text boxes and are spaced separately, and each
  // surface's pinned size was fitted at its own spacing. Absent = fall through
  // to the fronts', then to the renderer's own fixed step, which is what every
  // uncalibrated (and every single-line) title uses.
  //
  // The bounds are calibrate.py's own search grid, deliberately: a value the
  // measurement can legitimately return must not be refused here, because
  // title_style is validated as a WHOLE and one rejected field throws away the
  // colours and sizes measured beside it. סנטוריני's back really does measure
  // 0.48. Outside the grid it is not a design, it is a mis-measurement, and it
  // would print on every card of a paid order.
  for (const k of ['leading', 'back_leading', 'board_leading']) {
    if (input[k] == null) continue;
    if (!isFiniteNum(input[k]) || input[k] < TITLE_LEADING_MIN || input[k] > TITLE_LEADING_MAX) {
      return {
        error:
          'title_style.' +
          k +
          ' must be a fraction ' +
          TITLE_LEADING_MIN +
          '..' +
          TITLE_LEADING_MAX +
          ' of the type size',
      };
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
  // one_block: the design sets this title as ONE text box, so the renderer
  // stacks its lines at exactly `leading` and does NOT open them up to keep
  // their outlines clear of one another. Set by calibration where the original's
  // title ink has no row structure left to read, which is what a ring thick
  // enough to weld the lines together looks like from outside (סיישל). Passed
  // through as a plain boolean — the value it changes is `leading`, which is
  // validated above.
  if (input.one_block != null) {
    if (typeof input.one_block !== 'boolean') {
      return { error: 'title_style.one_block must be a boolean' };
    }
    out.one_block = input.one_block;
  }
  // The instance of a VARIABLE title face the design was set in, on the CSS
  // 100..900 weight scale. Absent for a static face — there is only one cut.
  if (input.font_weight != null) {
    if (!isFiniteNum(input.font_weight) || input.font_weight < 1 || input.font_weight > 1000) {
      return { error: 'title_style.font_weight must be a weight 1..1000' };
    }
    out.font_weight = input.font_weight;
  }
  // Synthetic bold, and the weight it is drawn at. The PAIR or neither: `bold`
  // on its own sends render_page to its house weight (0.035 of the type size),
  // which is another design's answer — twice what calibration measured for the
  // two templates that ship bold. So a weight without a flag is dropped, and a
  // flag without a weight is refused rather than silently re-weighted.
  if (input.bold != null) {
    if (typeof input.bold !== 'boolean') return { error: 'title_style.bold must be a boolean' };
    if (input.bold && input.bold_w == null) {
      return { error: 'title_style.bold needs title_style.bold_w, the measured stroke' };
    }
    out.bold = input.bold;
  }
  if (input.bold_w != null && out.bold) {
    if (!isFiniteNum(input.bold_w) || input.bold_w <= 0 || input.bold_w > 0.2) {
      return { error: 'title_style.bold_w must be a fraction 0..0.2 of the type size' };
    }
    out.bold_w = input.bold_w;
  }
  // Per-front overrides, keyed by front number. A deck's fronts are separate
  // artboards: טוקיו aligns its title flush right on four of its eight fronts
  // and flush left on the other four, and one deck-wide answer misprints half
  // the deck. `front_offset` is the same shape for the title's position.
  if (input.front_align != null) {
    const per = input.front_align;
    if (!per || typeof per !== 'object' || Array.isArray(per)) {
      return { error: 'title_style.front_align must be an object keyed by front number' };
    }
    const kept = {};
    for (const [k, v] of Object.entries(per)) {
      if (!/^[1-9][0-9]?$/.test(String(k))) {
        return { error: 'title_style.front_align keys must be front numbers' };
      }
      if (!TITLE_ALIGNS.includes(v)) {
        return {
          error: 'title_style.front_align values must be one of: ' + TITLE_ALIGNS.join(', '),
        };
      }
      kept[String(k)] = v;
    }
    if (Object.keys(kept).length) out.front_align = kept;
  }
  if (input.front_offset != null) {
    const per = input.front_offset;
    if (!per || typeof per !== 'object' || Array.isArray(per)) {
      return { error: 'title_style.front_offset must be an object keyed by front number' };
    }
    const kept = {};
    for (const [k, o] of Object.entries(per)) {
      if (!/^[1-9][0-9]?$/.test(String(k))) {
        return { error: 'title_style.front_offset keys must be front numbers' };
      }
      if (
        !Array.isArray(o) ||
        o.length !== 2 ||
        !isFiniteNum(o[0]) ||
        !isFiniteNum(o[1]) ||
        Math.abs(o[0]) > 1 ||
        Math.abs(o[1]) > 1
      ) {
        return { error: 'title_style.front_offset values must be [dx,dy] fractions -1..1' };
      }
      kept[String(k)] = [o[0], o[1]];
    }
    if (Object.keys(kept).length) out.front_offset = kept;
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
//
// `fronts` is the deck's OWN front list (default [2..9]) — a one-front template
// has exactly one title position to give, and demanding eight would make it
// impossible to calibrate. Titles for fronts outside the list are dropped, so a
// form that posts more than the deck has cannot write dead geometry.
// Returns a fresh, generator-shaped object. { value } (may be null) | { error }.
function validateCardSlots(input, fronts) {
  const wanted = fronts && fronts.length ? fronts : CARD_FRONT_NUMBERS;
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
  // Every front the deck renders, always: a half-filled map would render some
  // fronts with the title in whatever place the last calibration happened to
  // leave.
  const missing = wanted.filter((n) => !Object.prototype.hasOwnProperty.call(t, String(n)));
  if (missing.length) {
    return {
      error:
        'card_slots.titles is missing a title position for front(s): ' +
        missing.map((n) => n + '.svg').join(', '),
    };
  }
  const titles = {};
  for (const n of wanted) {
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

// Validate a PER-BACK calibration map { "<cardNumber>": slot|null } — a template
// whose eight card styles each have their OWN back (#315). The key is the card
// FILE number, the same numbering `cards.backs` uses, so a key means exactly one
// thing everywhere. A `null` entry is an ANSWER ("this back carries no title"),
// never a gap, so it must survive the round-trip instead of being dropped.
// Each slot may pin its own `size`: eight separately drawn backs give the title
// eight differently sized rooms, and one deck-wide back_size fits only the box
// it was measured against. { value } (may be null) | { error }.
function validateBacks(input, label) {
  if (input == null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: label + ' must be an object or null' };
  }
  const out = {};
  for (const key of Object.keys(input)) {
    if (!/^[0-9]+$/.test(key)) {
      return {
        error: label + ' key must be a card number, got ' + JSON.stringify(key.slice(0, 20)),
      };
    }
    const slotLabel = label + '.' + key;
    const v = validateSlot(input[key], slotLabel);
    if (v.error) return { error: v.error };
    if (v.value === null) {
      out[key] = null;
      continue;
    }
    const size = input[key].size;
    if (size != null && size !== '') {
      if (!isFiniteNum(size) || size <= 0 || size > 400) {
        return { error: slotLabel + '.size must be a positive number or null' };
      }
      v.value.size = size;
    }
    // ...and the spacing that size was measured at. It travels WITH the size:
    // separately drawn backs are separately spaced text boxes, and a size
    // pinned away from its own spacing prints a block nobody measured.
    const lead = input[key].leading;
    if (lead != null && lead !== '') {
      if (!isFiniteNum(lead) || lead < TITLE_LEADING_MIN || lead > TITLE_LEADING_MAX) {
        return {
          error:
            slotLabel +
            '.leading must be a fraction ' +
            TITLE_LEADING_MIN +
            '..' +
            TITLE_LEADING_MAX +
            ' of the type size',
        };
      }
      v.value.leading = lead;
    }
    out[key] = v.value;
  }
  return { value: out };
}

// Validate a full calibration blob { title_style, board, back, word_size } for
// the LIVE PREVIEW path (title_style is REQUIRED — you can't render a title
// without it; board/back/word_size may be null/absent). Returns a fresh,
// generator-shaped object or { error }. Shared by /api/preview so the previewed
// look uses the exact same validation the save path enforces.
// The largest the type may ever set on a design, whatever room its box has —
// one per surface and script, because the four surfaces do not share an answer.
// See generator/config.TYPE_CEILINGS, which reads the same six names.
const TYPE_CEILINGS = [
  'word_max_he',
  'word_max_en',
  'title_max_en',
  'title_max_he',
  'back_title_max_en',
  'back_title_max_he',
];

function validateCalibration(input, fronts) {
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const ts = validateTitleStyle(b.title_style);
  if (ts.error) return { error: ts.error };
  const board = validateSlot(b.board, 'board');
  if (board.error) return { error: board.error };
  const back = validateSlot(b.back, 'back');
  if (back.error) return { error: back.error };
  const backs = validateBacks(b.backs, 'backs');
  if (backs.error) return { error: backs.error };
  let word_size = null;
  if (b.word_size != null && b.word_size !== '') {
    if (!isFiniteNum(b.word_size) || b.word_size <= 0 || b.word_size > 400) {
      return { error: 'word_size must be a positive number or null' };
    }
    word_size = b.word_size;
  }
  // Single-card geometry, only sent by a 'cards' template's form. Absent for
  // every sheet template, so the blob a legacy preview posts is unchanged.
  const cards = validateCardSlots(b.card_slots, fronts);
  if (cards.error) return { error: cards.error };
  return {
    value: {
      title_style: ts.value,
      board: board.value,
      back: back.value,
      backs: backs.value,
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
  // THE HONOREE TITLE — editable after creation, which it was not until now.
  //
  // A template onboarded with a title that carries no usable {NAME} printed
  // "'s Birthday" on every card forever: nothing in this patch accepted
  // title_text/title_lines, so the only way out was hand-editing themes.json on
  // the volume. Both fields are accepted here, `title_lines` (the one the
  // generator actually reads) wins when both arrive, and `title_text` is always
  // re-derived from the saved lines so the pair can never drift apart.
  //
  // Validated against the extra fields this SAME patch results in, so fixing a
  // title and adding the field it needs is one save rather than a chicken-and-egg
  // pair of rejected ones.
  const titleInPatch = 'title_text' in p || 'title_lines' in p;
  const resultingExtraFields = Array.isArray(changed.extra_fields)
    ? changed.extra_fields
    : Array.isArray(entry.extra_fields)
      ? entry.extra_fields
      : [];
  const extraFieldsChanged =
    'extra_fields' in changed &&
    (changed.extra_fields.length !== (entry.extra_fields || []).length ||
      changed.extra_fields.some((f, i) => f !== (entry.extra_fields || [])[i]));
  // CLEARING the title is a legitimate edit now, on an old template as much as a
  // new one: "i want also the old templates to be with title only from now on.
  // but also keep backward compatibility". Every order placed since the buyer
  // started typing her own title carries one, and a carried title replaces the
  // composed one everywhere — so a template's own title only ever reaches the
  // page for an order from BEFORE that. Dropping it is how the owner says "this
  // design has no title of its own any more".
  //
  // Backward compatibility is what makes this a choice rather than a default: an
  // order that predates the change and has no title of its own prints the
  // composed one, and after this edit it would print none. So the template keeps
  // its title until the owner clears it deliberately — this only stops REFUSING
  // the clear.
  const clearingTitle =
    titleInPatch && !titleLinesFrom('title_lines' in p ? p.title_lines : p.title_text).length;
  if (clearingTitle) {
    changed.title_text = '';
    changed.title_lines = [];
  }
  if (!clearingTitle && (titleInPatch || extraFieldsChanged)) {
    const v = validateTitle({
      titleText: p.title_text,
      titleLines: 'title_lines' in p ? p.title_lines : titleInPatch ? undefined : entry.title_lines,
      extraFields: resultingExtraFields,
      // The no-{NAME} confirmation guards the TITLE edit. Narrowing extra_fields
      // on a template whose title never had a name must not demand a confirmation
      // for a title this patch is not touching.
      allowNoName: !titleInPatch || isTruthyFlag(p.allow_titleless),
    });
    if (v.error) {
      return { error: v.error, httpStatus: 400, ...(v.titleless ? { titleless: true } : {}) };
    }
    if (titleInPatch) {
      changed.title_text = v.title_text;
      changed.title_lines = v.title_lines;
    }
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
      // A knob the patch does not MENTION is carried forward, exactly as the
      // calibration pass carries one (see applyCalibration: "absent is unknown,
      // never clear it"). Without this, every save from the calibration form
      // replaced the style wholesale — and the form has no field for the
      // per-front knobs, so `front_align`/`front_offset` were wiped by an owner
      // who only nudged a colour. That is not hypothetical: it is how טוקיו lost
      // its alternating title alignment in production and printed half a deck
      // with the honoree's name flush against the koi.
      //
      // Keyed off the RAW patch, not the validated result, so an explicit
      // `front_align: {}` still CLEARS it — "mentioned" is the test, not "kept".
      const v = validateTitleStyle(p.title_style);
      if (v.error) return { error: v.error, httpStatus: 400 };
      const old =
        entry.title_style &&
        typeof entry.title_style === 'object' &&
        !Array.isArray(entry.title_style)
          ? entry.title_style
          : null;
      const carried = old ? Object.keys(old).filter((k) => !(k in p.title_style)) : [];
      if (carried.length) {
        const merged = validateTitleStyle({ ...old, ...p.title_style });
        // If carrying the old knobs forward makes the whole style illegal, the
        // owner's new one still wins — a save must not fail on history.
        changed.title_style = merged.error ? v.value : merged.value;
      } else {
        changed.title_style = v.value;
      }
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
  if ('backs' in p) {
    const v = validateBacks(p.backs, 'backs');
    if (v.error) return { error: v.error, httpStatus: 400 };
    changed.backs = v.value;
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
  // THE DECK'S LINE SPACING, chosen by the owner rather than inherited from the
  // origin design. In card units, alongside word_size. Null puts the template
  // back on the measured spacing. It is a PIN, not a ceiling: every deck of this
  // template prints at it (generator/build.deck_pitch_for). She picks it off
  // cards rendered at each candidate spacing, a long wrapping phrase included,
  // so the trade a wide rhythm makes is one she has already seen.
  if ('word_pitch' in p) {
    if (p.word_pitch === null || p.word_pitch === '') {
      changed.word_pitch = null;
    } else if (isFiniteNum(p.word_pitch) && p.word_pitch > 0 && p.word_pitch <= 400) {
      changed.word_pitch = p.word_pitch;
    } else {
      return { error: 'word_pitch must be a positive number or null', httpStatus: 400 };
    }
  }
  // HOW BIG THIS DESIGN SETS ITS ENGLISH WORDS, as a fraction of the card's size
  // (generator/config.word_alt_scale reads this exact name). English is set in
  // the SECOND word face, and a Latin face beside a Hebrew one at the same point
  // size does not read as the same size — the Latin x-height is the taller — so
  // the house default holds English at 0.8. A design whose Latin face needs more
  // or less says so here; null returns it to the house fraction.
  //
  // It was readable by the generator and writable by nobody: the owner could tune
  // it in the bench and had no way to save it, so a design that wanted 1.26
  // printed at 0.8 with nothing to say why. Capped at 4 because this MULTIPLIES
  // the size the card already fitted — past that the English leaves the card.
  if ('word_alt_scale' in p) {
    if (p.word_alt_scale === null || p.word_alt_scale === '') {
      changed.word_alt_scale = null;
    } else if (isFiniteNum(p.word_alt_scale) && p.word_alt_scale > 0 && p.word_alt_scale <= 4) {
      changed.word_alt_scale = p.word_alt_scale;
    } else {
      return { error: 'word_alt_scale must be a positive number or null', httpStatus: 400 };
    }
  }
  // HOW FAR APART THE LINES OF ONE WRAPPED ENTRY SIT, as a fraction of the step
  // between entries (generator/config.word_wrap_pitch reads this exact name). A
  // long phrase breaks over two lines, and how close the halves sit is what
  // decides whether the card reads as four items or five.
  //
  // Bounded at 1: past the entry step a continuation sits further from its own
  // first line than from the next entry, and the numbering stops meaning
  // anything. The generator bounds it from BELOW by the ink floor (_card_lead,
  // the tightest spacing at which no two letters touch), so no value here can be
  // the reason two letters touch. Absent = that floor, which is what every deck
  // printed to date has used.
  if ('word_wrap_pitch' in p) {
    if (p.word_wrap_pitch === null || p.word_wrap_pitch === '') {
      changed.word_wrap_pitch = null;
    } else if (isFiniteNum(p.word_wrap_pitch) && p.word_wrap_pitch > 0 && p.word_wrap_pitch <= 1) {
      changed.word_wrap_pitch = p.word_wrap_pitch;
    } else {
      return {
        error: 'word_wrap_pitch must be a number above 0 and at most 1, or null',
        httpStatus: 400,
      };
    }
  }
  // THE SIX CEILINGS. Optional, and null is a real answer meaning "no ceiling"
  // — the state every template ships in and every deck printed so far. Validated
  // like the other type numbers rather than trusted: they reach the generator as
  // a hard cap on what a paid order prints.
  for (const field of TYPE_CEILINGS) {
    if (!(field in p)) continue;
    if (p[field] === null || p[field] === '') {
      changed[field] = null;
    } else if (isFiniteNum(p[field]) && p[field] > 0 && p[field] <= 400) {
      changed[field] = p[field];
    } else {
      return { error: field + ' must be a positive number or null', httpStatus: 400 };
    }
  }

  if ('card_slots' in p) {
    const v = validateCardSlots(p.card_slots, entryFrontNumbers(entry));
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
  // Switch an EXISTING template between "a design per card" and "one design on
  // every card". Onboarding has offered this since #297, but only for a NEW
  // template — an owner converting a shipped sheet deck to cards had no way to say
  // "they're all the same", so the asset checklist demanded all eighteen numbered
  // files. Same meaning as at onboarding: 'one' records a NARROWER FRONT LIST
  // (cards:{back:1,fronts:[2]}), never nine copies of one file, and 'all' drops
  // the block so the entry reads the [2..9] default exactly as an untouched one
  // does. Only meaningful under the 'cards' layout — validated against the
  // structure this same patch results in, so switching layout and front mode in
  // ONE save is allowed while asking for 'one' on a sheet deck is still refused.
  if ('card_fronts' in p) {
    const fm = String(p.card_fronts || '').trim();
    if (!CARD_FRONT_MODES.includes(fm)) {
      return {
        error: 'card_fronts must be one of: ' + CARD_FRONT_MODES.join(', '),
        httpStatus: 400,
      };
    }
    const resultingStructure =
      'card_structure' in changed ? changed.card_structure : cardStructureOf(entry);
    if (fm === 'one' && resultingStructure !== 'cards') {
      return { error: "card_fronts:'one' requires card_structure:'cards'", httpStatus: 400 };
    }
    const isOneNow =
      cardStructureOf(entry) === 'cards' &&
      entryFrontNumbers(entry).length === SINGLE_FRONT_NUMBERS.length &&
      entryFrontNumbers(entry).every((n, i) => n === SINGLE_FRONT_NUMBERS[i]);
    if (fm === 'one' && !isOneNow) {
      changed.cards = { back: CARD_BACK_NUMBER, fronts: [...SINGLE_FRONT_NUMBERS] };
      // The eight fronts each carried their own title position; one front has one.
      changed.calibrated = false;
    } else if (fm === 'all' && isOneNow) {
      changed.cards = null; // dropped below — back to the [2..9] default
      changed.calibrated = false;
    }
  }
  // Eight card STYLES, each with its own back — versus one back shared by all
  // 104 cards, which is every template that existed before this. Only meaningful
  // under the 'cards' layout, validated against the structure this same patch
  // results in so layout + back mode can be set in ONE save.
  //
  // 'per-front' records the POSITIONAL pairing (cards.backs [10..17] against
  // fronts [2..9]); 'shared' drops the list so the entry is byte-for-byte one
  // that never had it. The checklist below then offers a back slot per front
  // instead of the single 1.svg, which is what makes these templates uploadable.
  if ('card_backs' in p) {
    const bm = String(p.card_backs || '').trim();
    if (!CARD_BACK_MODES.includes(bm)) {
      return { error: 'card_backs must be one of: ' + CARD_BACK_MODES.join(', '), httpStatus: 400 };
    }
    const resultingStructure =
      'card_structure' in changed ? changed.card_structure : cardStructureOf(entry);
    if (bm === 'per-front' && resultingStructure !== 'cards') {
      return { error: "card_backs:'per-front' requires card_structure:'cards'", httpStatus: 400 };
    }
    const isPerFrontNow = entryHasPerFrontBacks(entry);
    if (bm === 'per-front' && !isPerFrontNow) {
      // One back per front the deck actually renders, paired by position.
      const fronts =
        'cards' in changed && changed.cards && Array.isArray(changed.cards.fronts)
          ? changed.cards.fronts
          : entryFrontNumbers(entry);
      const cards = { ...(entry.cards && typeof entry.cards === 'object' ? entry.cards : {}) };
      cards.fronts = [...fronts];
      cards.backs = fronts.map(pairedBackFor).filter((n) => n != null);
      delete cards.back; // no shared back on a paired deck — nothing prints it
      changed.cards = cards;
      changed.calibrated = false; // each back may carry its title somewhere else
    } else if (bm === 'shared' && isPerFrontNow) {
      const cards = { ...entry.cards };
      delete cards.backs;
      cards.back = CARD_BACK_NUMBER;
      changed.cards = cards;
      changed.calibrated = false;
    }
  }
  if ('calibrated' in p) {
    if (typeof p.calibrated !== 'boolean') {
      return { error: 'calibrated must be a boolean', httpStatus: 400 };
    }
    // A layout OR front-list switch in the SAME patch wins — see above. Both
    // invalidate the measured geometry, so an explicit calibrated:true riding
    // along in the same save must not resurrect it.
    if (!('card_structure' in changed) && !('cards' in changed)) {
      changed.calibrated = p.calibrated;
    }
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
  // Same for word_pitch:null — "the design's own spacing", i.e. absent.
  if ('word_pitch' in changed && changed.word_pitch === null) delete entry.word_pitch;
  // Same for word_alt_scale:null — "the house fraction", i.e. absent.
  if ('word_alt_scale' in changed && changed.word_alt_scale === null) delete entry.word_alt_scale;
  // Same for word_wrap_pitch:null — "the ink floor", i.e. absent.
  if ('word_wrap_pitch' in changed && changed.word_wrap_pitch === null)
    delete entry.word_wrap_pitch;
  // Same for wordlist:null — "no pool named", i.e. fall back to the generic one.
  // Dropping the key rather than storing null keeps the owner entry readable as
  // the shipped entries are, and topup's `cfg.get("wordlist") or GENERIC` treats
  // absent and null identically anyway.
  if ('wordlist' in changed && changed.wordlist === null) delete entry.wordlist;
  // cards:null means "the default [2..9] front list" — same as absent. Drop the
  // key so a template switched back to eight fronts is byte-for-byte an entry
  // that never had a `cards` block.
  if ('cards' in changed && changed.cards === null) delete entry.cards;
  // The layout changed, so the files the OLD layout needed are now dead weight.
  // The owner asked for replace, not keep: prune them from the writable dir so
  // the asset checklist and every render see only the current layout's files.
  if ('card_structure' in changed || 'cards' in changed) {
    pruneObsoleteLayoutAssets(root, entry, key);
  }
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
      // The title as saved. `title_lines` is what renders; `title_text` is the
      // same thing newline-joined, for the form to show in one box.
      title_text: entry.title_text || '',
      title_lines: Array.isArray(entry.title_lines) ? entry.title_lines : [],
      title_style: entry.title_style || null,
      board: entry.board || null,
      back: entry.back || null,
      word_size: entry.word_size == null ? null : entry.word_size,
      // The line spacing this deck prints at, or null for the design's own.
      word_pitch: entry.word_pitch == null ? null : entry.word_pitch,
      // null = names no pool, i.e. the generic fallback.
      wordlist: entry.wordlist || null,
      calibrated: !!entry.calibrated,
      // Same shape the list reports: the front indices this deck renders, so the
      // form can re-read the saved layout without a refetch. null on a sheet.
      card_structure: cardStructureOf(entry),
      card_fronts: cardStructureOf(entry) === 'cards' ? entryFrontNumbers(entry) : null,
      card_backs: cardStructureOf(entry) === 'cards' ? entryBackNumbers(entry) : [],
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
//
// It runs ONLY as a background job (server/redetect-job.js). There is no
// synchronous twin, deliberately: there was one, it went on calling spawnSync
// after #354 moved the route off it, and a dead blocking copy of a path that
// exists because blocking froze the storefront is just a loaded gun. The pieces
// below (plan / report) are the shared, spawn-free halves.
//
// What re-detection needs to know about a template before it spawns anything —
// or the 404 it must answer with instead. Checked BEFORE a job is registered, so
// a typo never leaves a phantom row behind.
function redetectPlan({ root, key }) {
  const themes = loadThemes(themesPathFor(root));
  const entry = ownTheme(themes, key);
  if (!entry) return { error: 'template not found', httpStatus: 404 };
  return {
    cards: cardStructureOf(entry) === 'cards',
    recipeName: entry.recipe || key,
    themesPath: themesPathFor(root),
  };
}

// The report the button shows, assembled from the two runs' outcomes. Pure —
// it neither spawns nor writes — so both callers say exactly the same thing
// about the same pair of results.
function redetectReport({ key, recipe, calibration, applied }) {
  return {
    key,
    recipe: recipe.recipe,
    calibrated: !!calibration.ok,
    // Surfaced rather than swallowed: a recipe that detected fine while
    // calibration did not is a real, actionable state.
    detail: calibration.ok ? null : calibration.detail || null,
    // …and a calibration killed by its own ceiling is a DIFFERENT actionable
    // state from one that crashed: nothing is wrong with the artwork, the budget
    // was too small for this deck. The panel says which.
    timedOut: !calibration.ok && !!calibration.timedOut,
    // What the merge did with the measurements. A run can succeed end to end and
    // still change nothing the owner can see — every measured field refused by
    // validation, or the surface it cares about never measured at all — and until
    // now that combination reported plain success. This is how she finds out.
    rejected: (applied && applied.rejected) || [],
    kept: (applied && applied.kept) || [],
    // So is a run that succeeded while REFUSING to regularise something. That
    // combination is what let grapefruit come back with unevenly spaced words
    // from press after press of this button: the detector declined the spacing
    // snap every time, said "ok", and the only record was a container log.
    declined: declinedSnapsOf(recipe.recipe),
  };
}

// The regularisations detection refused, read back off the recipe it just wrote.
// Absent on a clean run, and absent on any recipe written before this was
// recorded — both mean "nothing to report".
function declinedSnapsOf(recipePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
    if (!Array.isArray(parsed.declined)) return [];
    return parsed.declined.filter((m) => typeof m === 'string');
  } catch {
    return [];
  }
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

// ---- THE display-name rule -------------------------------------------------
//
// ONE question — "what is this design called RIGHT NOW?" — answered in ONE place,
// because answering it twice is exactly how the site drifted: the storefront read
// the live themes.json label while the admin catalog read the name baked into
// site/js/designs.js at build time, so the same design was "פריז" on the shop
// floor and "מסיבת רווקות" in the admin. A rename is stored on the VOLUME
// (DATA_DIR/templates/themes.json, laid over the shipped file — see loadThemes),
// so the REPO can only ever hold a DEFAULT; the live label has to be resolved,
// never hardcoded. Every surface that shows a design name resolves it through the
// two functions below, so the next rename propagates with no code change:
//   • designDisplayNames() — the public { id: name } map (GET /api/design-names)
//   • displayNameForDesign() — one design's name WITH its built-in fallback
//     (server/design-catalog.js, GET /api/custom-designs)
// Both are pure (no fs/network), expose ONLY names — never any other theme field
// — and route their theme lookup through `ownTheme`, which rejects
// prototype-pollution keys.
//
// designThemeFields() below answers the SAME class of question for the ORDER
// WIZARD's inputs (which extra fields does this design collect, in which
// language) and follows exactly the same rules — pure, own-property lookup, and
// a deliberately narrow whitelist of fields.

// The owner-set label of a generator theme, trimmed; '' when `themes` is missing,
// the key is unknown, or the entry carries no usable `display_he`. '' means "the
// owner has not named this" — it is NEVER a name, so callers can safely treat it
// as "fall back".
function themeDisplayName(themes, theme) {
  if (!themes || typeof themes !== 'object') return '';
  if (typeof theme !== 'string' || !theme) return '';
  const entry = ownTheme(themes, theme);
  const name = entry && typeof entry.display_he === 'string' ? entry.display_he.trim() : '';
  return name;
}

// Build the PUBLIC { <designId>: displayName } map the storefront uses to show a
// current, owner-renamable name. Each orderable design (from site/js/designs.js,
// passed in as [{ id, theme }]) is resolved to its generator theme, and that
// theme's current themes.json `display_he` becomes the design's display name —
// so an admin "rename template" (which edits display_he) propagates to
// products.html / the product page without a rebuild. This is the slug↔product-id
// BRIDGE: designs carry `theme` (the themes.json key), so no separate mapping is
// needed. A design whose theme is unmapped, missing, or has no `display_he` is
// OMITTED (the page keeps its built-in catalog name) — that omission is the
// contract the buyer-side fetcher relies on, so this map stays "owner-set names
// only". Callers that need a name for EVERY design use displayNameForDesign.
function designDisplayNames(themes, designs) {
  const out = {};
  const list = Array.isArray(designs) ? designs : [];
  for (const d of list) {
    if (!d || typeof d.id !== 'string') continue;
    const name = themeDisplayName(themes, d.theme);
    if (name) out[d.id] = name;
  }
  return out;
}

// The wizard-input metadata a theme dictates, whitelisted to the three fields the
// buyer wizard actually branches on. `null` when the key names no known theme.
function themeWizardFields(themes, theme) {
  if (!themes || typeof themes !== 'object') return null;
  const entry = ownTheme(themes, theme);
  if (!entry || typeof entry !== 'object') return null;
  return {
    // The extra inputs the name step collects ([] = a plain one-person deck).
    // Non-string junk is dropped rather than handed to the wizard as a field.
    extra_fields: Array.isArray(entry.extra_fields)
      ? entry.extra_fields.filter((k) => typeof k === 'string' && k)
      : [],
    // The script the honoree name must be written in.
    language: typeof entry.language === 'string' && entry.language ? entry.language : 'hebrew',
    name_form: typeof entry.name_form === 'string' && entry.name_form ? entry.name_form : null,
  };
}

// Build the PUBLIC { <designId>: { extra_fields, language, name_form } } map the
// BUYER WIZARD uses to decide which inputs the name step asks for.
//
// This is the fields counterpart of designDisplayNames, and it exists for the
// same reason. site/js/designs.js carries a HARDCODED mirror of every theme's
// extra_fields, baked into the browser bundle at build time — so when the owner
// changed סנטוריני from a couple deck to a one-person deck IN THE ADMIN (which
// writes DATA_DIR/templates/themes.json), the storefront kept asking the buyer
// for two partner names and years-married, and there was no admin action that
// could ever fix it. Serving the live merged view here makes an admin field edit
// reach the wizard with no rebuild, exactly like a rename already does.
//
// Same contract as designDisplayNames: pure, own-property theme lookup, and only
// the whitelisted keys above ever leave the server. A design whose theme is
// unmapped or missing from themes.json is OMITTED, and the buyer-side fetcher
// relies on that omission to keep its built-in fallback for it.
function designThemeFields(themes, designs) {
  const out = {};
  const list = Array.isArray(designs) ? designs : [];
  for (const d of list) {
    if (!d || typeof d.id !== 'string') continue;
    const fields = themeWizardFields(themes, d.theme);
    if (fields) out[d.id] = fields;
  }
  return out;
}

// The display name of ONE design, always a usable string: the owner's current
// themes.json label if there is one, else the design's own built-in catalog name,
// else its id. This is what a screen listing designs (the admin catalog, the
// custom-design storefront feed) asks for — it must render SOMETHING for a design
// whose theme was never named, and that something must be the same string
// /api/design-names would serve whenever a name exists.
function displayNameForDesign(themes, design) {
  if (!design || typeof design !== 'object') return '';
  const live = themeDisplayName(themes, design.theme);
  if (live) return live;
  const own = typeof design.name === 'string' ? design.name.trim() : '';
  if (own) return own;
  return typeof design.id === 'string' ? design.id : '';
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
  const structure = cardStructureOf(entry);
  // The product picture is the deck's FIRST front — read off the entry's own
  // front list, so a template whose fronts start somewhere other than 2 shows
  // the card it actually prints rather than a file it may not even ship.
  if (structure === 'cards' && slot === 'front') {
    return 'filled/' + entryFrontNumbers(entry)[0] + '.svg';
  }
  return FILLED_IMAGE_REL[structure][slot] || null;
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

  // Resolve the destination path. SVG roles have a fixed rel; a font role keeps
  // the name of the file the owner actually uploaded, and records it.
  //
  // This used to write over the RECORDED filename whenever one was already on
  // record, discarding the uploaded name. On a template whose two roles happen
  // to name the SAME file — anniversary/סנטוריני ships title_font and word_font
  // both as "Dana Yad AlefAlefAlef Normal.ttf" — that makes the two roles
  // impossible to separate: uploading a distinct title font and a distinct word
  // font writes BOTH onto that one file, so whichever went last became the font
  // for both surfaces, and the owner's two differently-named files vanished. The
  // uploaded name is the owner's intent; honour it.
  let rel = spec.rel;
  let recordFontField = null;
  if (kind === 'font') {
    const name = safeBasename(file.filename);
    // No usable name is only fatal when there is no recorded path to fall back
    // on — re-uploading over an existing font must keep working regardless.
    if (!name && !rel) {
      return { error: 'font filename is missing or unsafe', httpStatus: 400 };
    }
    if (name && 'fonts/' + name !== rel) {
      rel = 'fonts/' + name;
      recordFontField = spec.field;
    }
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
      recipeName: entry.recipe || key,
      cards: true,
      pythonBin,
      runner: recipeRunner,
    });
    redetect = { ok: !!r.ok, detail: r.ok ? null : r.detail || null };
  }

  return { key, role, path: displayPath(root, abs), redetect };
}

// Remove an OPTIONAL font from a template — the undo for a font uploaded to the
// wrong role or the wrong template.
//
// There was no way to un-upload anything before this, which was tolerable while
// every asset was required (re-upload the right file and the wrong one is gone).
// An optional second face is different: once recorded it is used on every later
// order, and the only way to stop that was to hand-edit themes.json on the
// volume. So removal is a first-class operation — but a NARROW one: only the
// roles in REMOVABLE_ROLES (the two alt fonts). Clearing a required font would
// leave a template that cannot render.
//
// Deliberately NOT done by widening updateTemplateSettings to accept font
// filenames. Filenames come from what was actually uploaded; a patch that could
// write one could name a file that is not there and break every render for the
// template. Clearing to "nothing" is the only font-field write that cannot lie.
//
// The FILE is deleted only when nothing else in the entry points at it. A theme
// may legitimately record one file under two roles (anniversary/סנטוריני ships
// title_font and word_font as the same file), so unlinking blindly would delete
// the font another role is still rendering with. When in doubt the field is
// cleared and the file left on disk — an unreferenced font is inert.
function clearAsset({ root, key, role }) {
  const themesPath = themesPathFor(root);
  const themes = loadThemes(themesPath);
  const entry = ownTheme(themes, key);
  if (!entry) return { error: 'template not found', httpStatus: 404 };
  if (!REMOVABLE_ROLES.has(role)) {
    return {
      error:
        'asset role "' +
        role +
        '" cannot be removed — only the optional second fonts can. Replace it by uploading a new file.',
      httpStatus: 400,
    };
  }
  const spec = FONT_ASSET_ROLES.find((a) => a.role === role);
  const field = spec.field;
  const recorded = entry[field] ? safeFontRel(entry[field]) : null;
  if (!recorded) return { key, role, field, removed: false, fileDeleted: false };

  // Is any OTHER font field pointing at the same file?
  const sharedWith = FONT_ASSET_ROLES.filter((a) => a.field !== field)
    .map((a) => (entry[a.field] ? safeFontRel(entry[a.field]) : null))
    .filter((rel) => rel && rel === recorded);

  delete entry[field];
  persistThemeEntry(themesPath, key, entry);

  let fileDeleted = false;
  if (!sharedWith.length) {
    // Delete only from the dir this template's writes land in — never from the
    // shipped image dir when the owner store is shadowing it, where an unlink
    // would remove a file the entry no longer names but the shipped entry might.
    const writeDir = templateWriteDir(root, entry, key);
    const abs = writeDir ? path.resolve(writeDir, 'fonts/' + recorded) : null;
    if (abs && (abs === writeDir || abs.startsWith(writeDir + path.sep))) {
      try {
        if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
          fileDeleted = true;
        }
      } catch {
        // Best effort: the field is already cleared, so the font is out of the
        // render either way. A file left behind is inert, not a failure.
      }
    }
  }
  return { key, role, field, removed: true, fileDeleted, file: recorded };
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
  isSafeThemeKey,
  NAME_FORMS,
  SVG_ROLES,
  CARD_STRUCTURES,
  CARD_FILE_NUMBERS,
  CARD_FRONT_NUMBERS,
  CARD_BACK_NUMBER,
  CARD_FRONT_MODES,
  SINGLE_FRONT_NUMBERS,
  CARD_VIEWBOX,
  CARD_WORD_SLOTS,
  cardStructureOf,
  entryFrontNumbers,
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
  // The pieces re-detection is assembled from, so server/redetect-job.js can run
  // the SAME two commands off the event loop without a second copy of the argv,
  // the success test, or the report shape.
  recipeDiffPlan,
  recipeDiffOutcome,
  calibratePlan,
  calibrateOutcome,
  redetectPlan,
  redetectReport,
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
  validateTitle,
  titlePlaceholders,
  titleLinesFrom,
  replaceAsset,
  clearAsset,
  fontScriptCoverage,
  REMOVABLE_ROLES,
  designDisplayNames,
  designThemeFields,
  displayNameForDesign,
  themeDisplayName,
  LANGUAGES,
  VISIBILITIES,
};
