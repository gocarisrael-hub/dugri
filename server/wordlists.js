// wordlists.js — the owner-editable store for the generator's SEED WORD POOLS.
//
// A "wordlist" is a plain UTF-8 text file, one word per line, that
// generator/topup.py draws filler words from when an order's personal words
// don't reach a full deck (TARGET=412). generator/themes.json links a theme to
// its pool by filename (`"wordlist": "friends-350.txt"`); a theme with no
// `wordlist` falls back to the shared generic-350.txt.
//
// ---------------------------------------------------------------------------
// WHERE THE FILES LIVE — read this before changing anything here.
// ---------------------------------------------------------------------------
// There are TWO directories, and they are NOT interchangeable:
//
//   1. SHIPPED_DIR = <repo>/content/wordlists  — the 11 pools that ship in the
//      Docker image. The container filesystem is EPHEMERAL: this directory is
//      rebuilt from the image on every deploy, so anything written here is LOST
//      on the next deploy. It is therefore treated as READ-ONLY baseline
//      content. This module NEVER writes to it.
//
//   2. STORE_DIR = DATA_DIR/wordlists — the owner's copy, on the persistent
//      Railway volume (DATA_DIR=/data). Same pattern as server/content.js's
//      content-uploads and server/playbook.js's notes. EVERY write this module
//      performs lands here, and only here.
//
// Resolution is STORE-FIRST: a file in STORE_DIR SHADOWS the shipped file of
// the same name. generator/topup.py implements the identical rule (it reads
// DATA_DIR from its inherited env), so the generator and this admin UI always
// agree on which bytes are the live pool.
//
// Editing a SHIPPED list is therefore COPY-ON-WRITE: the first save writes a
// full copy into STORE_DIR, the image's original is left untouched, and the
// override wins from then on. That means an edit survives a redeploy (it's on
// the volume) AND the pristine baseline is always recoverable (revert() just
// deletes the override). A "saved" list that vanishes on the next deploy is the
// one outcome this design exists to prevent.
//
// `source` on every record tells the UI which case a list is in:
//   'shipped'  — only in the image; never edited (delete refused: it would come
//                back on the next deploy anyway).
//   'override' — a shipped name the owner has edited; lives in BOTH dirs, the
//                volume copy wins. Revertible.
//   'custom'   — created by the owner; only on the volume.
//
// THE THEME -> POOL LINK (previously a known gap here, now closed): that link
// lives in generator/themes.json, which is baked into the image and has exactly
// the same ephemerality problem as the pools themselves. It is now an ordinary
// template setting — `wordlist` on updateTemplateSettings (server/templates.js)
// — so a change rides the template store's whole-entry copy-on-write onto the
// volume, and the generator reads it through the same overlay (config.py). This
// module still only READS the linkage (`themeLinks`): the admin wordlists screen
// renders the picker, but the WRITE goes through the templates route, so there
// is exactly one code path that validates and persists a theme entry.
const fs = require('fs');
const path = require('path');
const validate = require('./validate');

// The shipped baseline (read-only) and the persistent owner store (writable).
const SHIPPED_DIR = path.join(__dirname, '..', 'content', 'wordlists');
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STORE_DIR = path.join(DATA_DIR, 'wordlists');

// The implicit pool every theme falls back to when it names none (topup.GENERIC).
const GENERIC = 'generic-350.txt';

// Caps: a pool is filler for a 412-word deck, so a few thousand words is already
// far more than any deck can consume — bound it so a paste can't fill the volume.
const MAX_WORDS = 5000;
// One word per line. Pool words are printed on cards exactly like a buyer's own
// words (topup.py draws filler from here), so they are held to the SAME per-entry
// cap — one source of truth in validate.js, not a second number that can drift.
const MAX_WORD_LEN = validate.MAX_WORD_LEN;
// Bound a single request body's raw text before we even split it.
const MAX_TEXT = 400 * 1024;

// A wordlist NAME is always a bare filename ending in .txt — never a path.
// Latin letters, Hebrew letters, digits, space, hyphen and underscore only, so
// the shipped names (generic-350.txt, "hadar list.txt") are all expressible and
// a Hebrew name the owner types works too. No dots except the extension, which
// alone rules out "..". 1–60 chars of stem.
const NAME_RE = /^[A-Za-z0-9֐-׿][A-Za-z0-9֐-׿ _-]{0,59}\.txt$/;

// Normalize + HARD-validate a client-supplied name. Returns the safe basename or
// null. Traversal is REJECTED, never silently stripped: a caller that sends
// "../db.json" gets an error, not a write to a name it didn't ask for. The
// basename equality check is the belt to NAME_RE's braces (mirrors the
// safeBasename guard in server/templates.js).
function safeName(raw) {
  let n = String(raw == null ? '' : raw).trim();
  if (!n) return null;
  if (n.includes('/') || n.includes('\\') || n.includes('\0')) return null;
  if (path.basename(n) !== n) return null;
  // Accept a name typed without the extension; normalize the case of .txt.
  if (/\.txt$/i.test(n)) n = n.slice(0, -4) + '.txt';
  else n = n + '.txt';
  return NAME_RE.test(n) ? n : null;
}

// Join a validated name under `dir` and PROVE the result stays directly inside
// it (defense in depth behind safeName — same resolve+startsWith shape as
// server/templates.js). Returns null if it would escape.
function resolveIn(dir, name) {
  const base = path.resolve(dir);
  const abs = path.resolve(base, name);
  if (path.dirname(abs) !== base) return null;
  return abs;
}

// ---- word parsing / normalization ------------------------------------------

// Dedup key — MUST match generator/topup.py `_norm`: trimmed, inner whitespace
// collapsed, lowercased. Keeping the two identical means a list that looks
// deduped in admin is also deduped by the generator.
function normKey(word) {
  return String(word == null ? '' : word)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Turn owner input into a clean word array. Accepts EITHER a pasted blob (a
// string) or an array of words, so "paste a whole list" and "type one word"
// share one code path. A blob splits on newlines AND commas (people paste
// comma-separated lists just as often as line-separated ones); semicolons and
// tabs come along for free since they are equally common in a paste.
// Trims, collapses inner whitespace, drops blanks, and dedups
// case/space-insensitively PRESERVING ORDER. Capped at MAX_WORDS.
//
// It does NOT apply the length cap — splitByLength does, and only to the words a
// save is ADDING. That split is deliberate: the shipped pools contain 46 entries
// over the cap (the longest is 41 chars), and they are grandfathered like every
// other pre-existing word list. If parseWords filtered, merely re-saving a
// shipped pool from the admin editor would silently delete those 46 words.
function parseWords(input) {
  let raw;
  if (Array.isArray(input)) {
    raw = input.map((w) => String(w == null ? '' : w));
  } else {
    raw = String(input == null ? '' : input)
      .slice(0, MAX_TEXT)
      .split(/[\r\n,;\t]+/);
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const w = validate.normalizeWordText(item);
    if (!w) continue;
    const k = normKey(w);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

// Split a parsed list into the words a save may keep and the over-length ones it
// must refuse. `existing` is the pool's CURRENT words: an over-length entry that
// is already in the pool passes through untouched, because the admin editor
// round-trips the whole list on every save and the shipped pools predate the cap
// — grandfathering by identity is what lets the owner fix a typo in a pool
// without silently losing its 46 legacy long entries. Only entries that are NEW
// to this pool are held to the cap.
function splitByLength(list, existing) {
  const known = new Set((Array.isArray(existing) ? existing : []).map(normKey));
  const kept = [];
  const tooLong = [];
  for (const w of Array.isArray(list) ? list : []) {
    if (w.length > MAX_WORD_LEN && !known.has(normKey(w))) tooLong.push(w);
    else kept.push(w);
  }
  return { kept, tooLong };
}

// The Hebrew warning for words a save refused, or null when none were. Named so
// the admin screen can show WHICH words were dropped rather than a silent diff.
function tooLongWarning(tooLong) {
  if (!tooLong || !tooLong.length) return null;
  const shown = tooLong.slice(0, 5).map((w) => '"' + w + '"');
  return (
    tooLong.length +
    ' מילים לא נשמרו כי הן ארוכות מדי (המקסימום ' +
    MAX_WORD_LEN +
    ' תווים): ' +
    shown.join(', ') +
    (tooLong.length > shown.length ? ' ועוד' : '')
  );
}

// ---- disk helpers ----------------------------------------------------------

function readFileWords(abs) {
  // utf-8-sig on the Python side: strip a leading BOM here too so a
  // Windows-exported list doesn't smuggle one into the first word.
  const text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  return text.split(/\r?\n/).filter((w) => w.trim() !== '');
}

function existsIn(dir, name) {
  const abs = resolveIn(dir, name);
  try {
    return abs && fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

// Where the generator will actually READ this pool from: the volume copy wins.
// Returns { abs, source } or null when the name exists nowhere.
function resolveWordlist(name) {
  const n = safeName(name);
  if (!n) return null;
  const store = existsIn(STORE_DIR, n);
  const shipped = existsIn(SHIPPED_DIR, n);
  if (store) return { abs: store, source: shipped ? 'override' : 'custom' };
  if (shipped) return { abs: shipped, source: 'shipped' };
  return null;
}

// Atomic write into the PERSISTENT store (tmp file + rename), creating the
// directory on first use — the same shape as content.js/playbook.js/db.js.
// Never writes to SHIPPED_DIR.
function writeStore(name, words) {
  const abs = resolveIn(STORE_DIR, name);
  if (!abs) throw new Error('unsafe wordlist path');
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, words.join('\n') + (words.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, abs);
  return abs;
}

function listDir(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.txt$/i.test(f))
      .filter((f) => !!safeName(f));
  } catch {
    return [];
  }
}

// ---- theme linkage (READ-ONLY) ---------------------------------------------

// Every theme key whose pool is `name`. A theme with no `wordlist` implicitly
// uses GENERIC, exactly like topup.py, so generic-350.txt correctly reports the
// themes that never name it. `themes` is injectable for tests; by default it is
// the live generator/themes.json (via server/validate.js).
function themesUsing(name, themes) {
  const n = safeName(name);
  if (!n) return [];
  const all = themes || validate.loadThemes();
  const out = [];
  for (const key of Object.keys(all || {})) {
    const cfg = all[key];
    if (!cfg || typeof cfg !== 'object') continue;
    const pool = safeName(cfg.wordlist) || GENERIC;
    if (pool === n) out.push(key);
  }
  return out.sort();
}

// The whole theme -> pool map, for the admin page's read-only linkage panel:
// [{ key, display_he, wordlist, implicit }] where `implicit` marks a theme that
// names no pool and therefore falls back to GENERIC.
function themeLinks(themes) {
  const all = themes || validate.loadThemes();
  return Object.keys(all || {})
    .filter((k) => all[k] && typeof all[k] === 'object')
    .map((key) => {
      const named = safeName(all[key].wordlist);
      return {
        key,
        display_he: String(all[key].display_he || key),
        wordlist: named || GENERIC,
        implicit: !named,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ---- public API ------------------------------------------------------------

// Every pool the generator can see — the union of the shipped baseline and the
// owner's store — with its live word count, source, and the themes using it.
function list(themes) {
  const all = themes || validate.loadThemes();
  const names = new Set([...listDir(SHIPPED_DIR), ...listDir(STORE_DIR)].map((f) => safeName(f)));
  const out = [];
  for (const name of names) {
    if (!name) continue;
    const hit = resolveWordlist(name);
    if (!hit) continue;
    let count = 0;
    let updated_at = null;
    try {
      count = readFileWords(hit.abs).length;
      updated_at = fs.statSync(hit.abs).mtime.toISOString();
    } catch {
      /* unreadable file — report it with a zero count rather than 500 */
    }
    out.push({ name, source: hit.source, count, updated_at, themes: themesUsing(name, all) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// One pool's full contents. Returns null for a bad/unknown name.
function read(name, themes) {
  const n = safeName(name);
  if (!n) return null;
  const hit = resolveWordlist(n);
  if (!hit) return null;
  let words = [];
  try {
    words = readFileWords(hit.abs);
  } catch {
    return null;
  }
  return {
    name: n,
    source: hit.source,
    count: words.length,
    words,
    themes: themesUsing(n, themes),
  };
}

// Create a NEW pool on the volume. Refuses a name that already exists in either
// directory (a shipped name would be a silent override, not a creation).
// `words` is a blob or an array. Returns the new record or { error, httpStatus }.
function create({ name, words, text } = {}) {
  const n = safeName(name);
  if (!n) {
    return {
      error: 'שם רשימה לא תקין. אותיות/ספרות, רווח, מקף או קו תחתון, עד 60 תווים.',
      httpStatus: 400,
    };
  }
  if (resolveWordlist(n)) {
    return {
      error: 'כבר קיימת רשימה בשם ' + n + '. בחרו שם אחר או ערכו את הקיימת.',
      httpStatus: 409,
    };
  }
  // A brand-new pool has nothing to grandfather, so every word is held to the cap.
  const { kept, tooLong } = splitByLength(parseWords(words != null ? words : text), []);
  writeStore(n, kept);
  return { ...read(n), too_long: tooLong, warning: tooLongWarning(tooLong) };
}

// REPLACE a pool's contents (the "paste a whole list" save), or APPEND when
// `append` is set (the "type one word at a time" path). Always writes to the
// volume — editing a SHIPPED list is a copy-on-write that leaves the image's
// original untouched and shadows it from then on.
// Returns the updated record or { error, httpStatus }.
function update(name, { words, text, append } = {}) {
  const n = safeName(name);
  if (!n) return { error: 'שם רשימה לא תקין.', httpStatus: 400 };
  const hit = resolveWordlist(n);
  if (!hit) return { error: 'הרשימה ' + n + ' לא נמצאה.', httpStatus: 404 };

  // The pool as it stands. Its words are the grandfather set: already-stored
  // over-length entries survive a re-save, new ones are refused (splitByLength).
  const current = read(n);
  const currentWords = current ? current.words : [];
  const parsed = parseWords(append != null ? append : words != null ? words : text);
  const { kept: incoming, tooLong } = splitByLength(parsed, currentWords);
  let next;
  if (append != null) {
    // Append: keep the existing order, add only genuinely new words. An append of
    // nothing BUT over-length words is a hard error — there is no "added" outcome
    // to report and the owner must see why.
    if (!incoming.length && tooLong.length) {
      return { error: tooLongWarning(tooLong), httpStatus: 400 };
    }
    next = parseWords(currentWords.concat(incoming));
    if (next.length === currentWords.length) {
      return { error: 'המילה כבר קיימת ברשימה.', httpStatus: 409 };
    }
  } else {
    next = incoming;
    if (next.length === 0) {
      return { error: 'רשימה ריקה לא נשמרת. הוסיפו לפחות מילה אחת.', httpStatus: 400 };
    }
  }
  writeStore(n, next);
  return { ...read(n), too_long: tooLong, warning: tooLongWarning(tooLong) };
}

// DELETE a pool. Two hard guards, both with an explanation the owner can act on:
//   • a pool a THEME still points at is refused (the generator would have no
//     filler for that theme) — the message names the themes;
//   • a SHIPPED pool is refused outright: it lives in the Docker image, so
//     "deleting" it would only remove a volume override and the file would be
//     back on the next deploy. Reverting an override is the honest operation
//     (see revert), and there is no way to remove an image file from here.
function remove(name, themes) {
  const n = safeName(name);
  if (!n) return { error: 'שם רשימה לא תקין.', httpStatus: 400 };
  const hit = resolveWordlist(n);
  if (!hit) return { error: 'הרשימה ' + n + ' לא נמצאה.', httpStatus: 404 };

  const used = themesUsing(n, themes);
  if (used.length) {
    return {
      error:
        'אי אפשר למחוק את ' +
        n +
        ' — היא עדיין בשימוש בעיצובים: ' +
        used.join(', ') +
        '. קודם החליפו להם רשימה, ואז מחקו.',
      httpStatus: 409,
      themes: used,
    };
  }
  if (hit.source !== 'custom') {
    return {
      error:
        'הרשימה ' +
        n +
        ' מגיעה עם המערכת ולא ניתן למחוק אותה — היא חלק מקובץ ההתקנה ותחזור בעלייה הבאה לאוויר. אפשר לערוך אותה, ואפשר לבטל את העריכה ולחזור למקור.',
      httpStatus: 409,
    };
  }
  const abs = resolveIn(STORE_DIR, n);
  if (!abs) return { error: 'שם רשימה לא תקין.', httpStatus: 400 };
  fs.unlinkSync(abs);
  return { ok: true, name: n };
}

// REVERT an edited shipped pool: drop the volume override so the image's
// original is live again. Only meaningful for source 'override'.
function revert(name) {
  const n = safeName(name);
  if (!n) return { error: 'שם רשימה לא תקין.', httpStatus: 400 };
  const hit = resolveWordlist(n);
  if (!hit) return { error: 'הרשימה ' + n + ' לא נמצאה.', httpStatus: 404 };
  if (hit.source !== 'override') {
    return { error: 'אין מה לבטל — לרשימה הזו אין גרסה ערוכה.', httpStatus: 409 };
  }
  const abs = resolveIn(STORE_DIR, n);
  if (!abs) return { error: 'שם רשימה לא תקין.', httpStatus: 400 };
  fs.unlinkSync(abs);
  return read(n);
}

// --- staging mirror (see store-import.js) -------------------------------------

// The OWNER-CREATED lists only — the ones living on the volume (STORE_DIR).
// Shipped lists come with the Docker image and are byte-identical on every
// service, so mirroring them would move bytes to no effect; worse, a shipped list
// that the source has and the target doesn't means the two are on different
// builds, which an import must not paper over.
function exportOwnerLists() {
  const out = [];
  for (const file of listDir(STORE_DIR)) {
    const n = safeName(file);
    if (!n) continue;
    try {
      out.push({ name: n, words: readFileWords(path.join(STORE_DIR, n)) });
    } catch {
      /* unreadable file — skip rather than abort the whole export */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Snapshot every owner list into ONE json file before a destructive replace.
// The other stores are single files that store-backup can copy; this one is a
// directory, so the recovery point is a serialized snapshot next to it. Returns
// the path, or null when there are no owner lists to lose. THROWS on failure.
function backup(opts = {}) {
  const lists = exportOwnerLists();
  if (!lists.length) return null;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dest = path.join(DATA_DIR, `wordlists.backup-${now}.json`);
  fs.writeFileSync(dest, JSON.stringify(lists, null, 2), 'utf8');
  return dest;
}

// REPLACE the owner lists with `incoming` (mirror semantics: an owner list not
// present in `incoming` is DELETED). Shipped lists are never touched.
//
// Writes every file BEFORE deleting any, so a mid-way failure leaves the target
// with a superset rather than a hole — the recoverable direction. A bad entry
// aborts before anything is written at all.
function replaceOwnerLists(incoming) {
  if (!Array.isArray(incoming)) throw new Error('wordlists must be an array');
  const staged = [];
  for (const item of incoming) {
    if (!item || typeof item !== 'object') continue;
    const n = safeName(item.name);
    if (!n) throw new Error('invalid wordlist name: ' + String(item && item.name));
    if (!Array.isArray(item.words)) throw new Error('wordlist ' + n + ' has no words array');
    staged.push({ name: n, words: item.words.map((w) => String(w)) });
  }
  fs.mkdirSync(STORE_DIR, { recursive: true });
  for (const { name, words } of staged) {
    const tmp = path.join(STORE_DIR, name + '.tmp');
    fs.writeFileSync(tmp, words.join('\n') + (words.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, path.join(STORE_DIR, name));
  }
  const keep = new Set(staged.map((x) => x.name));
  let removed = 0;
  for (const file of listDir(STORE_DIR)) {
    const n = safeName(file);
    if (!n || keep.has(n)) continue;
    try {
      fs.unlinkSync(path.join(STORE_DIR, n));
      removed += 1;
    } catch {
      /* best-effort: a file we couldn't delete is a leftover, not data loss */
    }
  }
  return { written: staged.length, removed };
}

module.exports = {
  list,
  exportOwnerLists,
  replaceOwnerLists,
  backup,
  read,
  create,
  update,
  remove,
  revert,
  parseWords,
  splitByLength,
  tooLongWarning,
  normKey,
  safeName,
  themesUsing,
  themeLinks,
  resolveWordlist,
  GENERIC,
  MAX_WORDS,
  MAX_WORD_LEN,
  _storeDir: STORE_DIR,
  _shippedDir: SHIPPED_DIR,
};
