// Pre-production order validation. Before we spend money/time generating a
// print-ready PDF we check that the order is actually producible: the honoree
// name is in the language the chosen theme expects, every extra field the theme
// requires is filled in, and there is at least one word. The core
// `validateOrderForProduction` is a PURE function (no I/O) so it is trivially
// unit-testable; `getTheme`/`loadThemes` are the thin I/O helpers that read the
// generator's themes.json.
const fs = require('fs');
const path = require('path');
const store = require('./template-store');

// generator/themes.json, relative to this file (server/ -> ../generator/) — the
// SHIPPED layer, which in production lives in the (ephemeral) Docker image.
const THEMES_PATH = path.join(__dirname, '..', 'generator', 'themes.json');

// Read + parse the themes fresh each call (they are tiny and rarely change, and
// reading live keeps tests from fighting a cached copy). Returns the MERGED
// overlay view — the image's shipped themes with the owner store's entries
// (DATA_DIR/templates/themes.json) laid over them — so validating an order for
// an OWNER-UPLOADED theme finds it instead of failing as "unknown theme". Each
// layer is read defensively: a missing/unparseable file resolves to {} so a bad
// file never crashes a generation request.
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}
function loadThemes() {
  const shipped = readJson(THEMES_PATH);
  const ownerPath = store.ownerThemesPath();
  const owner = ownerPath ? readJson(ownerPath) : {};
  return { ...shipped, ...owner };
}

// The theme config object for a themes.json key, or null when unknown.
function getTheme(name) {
  const themes = loadThemes();
  return (name && themes[name]) || null;
}

// ---------------------------------------------------------------------------
// The word-entry length cap.
// ---------------------------------------------------------------------------
// The longest a SINGLE word entry may be, counted over the WHOLE entry with its
// spaces included — not per unbroken token. "מכבי חיפה" (9) and "בית ספר" (7)
// pass; a 30-character entry does not. Per-entry is the owner's deliberate
// choice over per-token (which would have let a 21-character phrase through
// while only capping one long run): an entry that fits on a card line reads
// better than one that wraps. It is a design call about the card, so don't
// quietly relax it to per-token.
//
// It also keeps the renderer out of trouble. A long unbreakable token drives an
// O(n^2) fitting loop in render_page: measured on staging, an 80-character token
// took `grapefruit` from 4.6s to 61.9s and pushed `daniel-amit` past its 120s
// timeout into an HTTP 500. NOTE the honest margin — 80 is the only length ever
// measured to break, and nothing between 25 and 80 was tested. 25 is far below
// the one known-bad point; it is NOT a measured safe maximum.
//
// GRANDFATHERED: this is an ENTRY-time rule only. Word lists stored before it
// existed (production has orders of 416/224/109 words) keep their entries
// byte-for-byte and must still generate — nothing in the render path enforces
// this cap, and no migration rewrites stored data.
const MAX_WORD_LEN = 25;

// The stored form of an entry: trimmed, inner whitespace runs collapsed. The cap
// is measured against THIS, so "מכבי  חיפה" (double space) counts as 9 — we
// measure what actually gets rendered, not what was typed.
function normalizeWordText(s) {
  return String(s == null ? '' : s)
    .trim()
    .replace(/\s+/g, ' ');
}

// True when an entry is over the cap (measured on its normalized form).
function isWordTooLong(s) {
  return normalizeWordText(s).length > MAX_WORD_LEN;
}

// The Hebrew rejection message for an entry of `len` characters: it names the
// ACTUAL length and the limit, so the person typing knows how much to cut,
// rather than a bare "invalid input".
function wordLengthMessageForLen(len) {
  return 'המילה ארוכה מדי: ' + len + ' תווים, המקסימום הוא ' + MAX_WORD_LEN + '. קצרו ונסו שוב.';
}

// The same message for an actual entry, or null when the entry fits.
function wordLengthMessage(s) {
  const t = normalizeWordText(s);
  return t.length > MAX_WORD_LEN ? wordLengthMessageForLen(t.length) : null;
}

// Hebrew block U+0590–U+05FF; Latin ASCII letters. A name is validated against
// the theme's expected script: it must contain the expected script and none of
// the other.
const HEBREW_RE = /[֐-׿]/;
const LATIN_RE = /[A-Za-z]/;

// Hebrew label for the expected name language (both english forms read the same
// to a client).
const LANG_LABEL = { hebrew: 'עברית', english: 'אנגלית', 'english-caps': 'אנגלית' };

// Hebrew labels for the extra fields a theme can require.
const FIELD_LABEL = {
  AGE: 'גיל',
  YEARS: 'שנים',
  NAME1: 'שם ראשון',
  NAME2: 'שם שני',
};

// Read one extra field for the order. W3 stores these on the collection and/or
// the order; we accept either (collection first). Returns the trimmed value, or
// null when it is absent/blank anywhere we look.
function readExtraField(collection, field) {
  const order = (collection && collection.order) || null;
  const sources = [collection && collection.extra_fields, order && order.extra_fields];
  for (const src of sources) {
    if (src && typeof src === 'object') {
      const v = src[field];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return null;
}

// Check ONE name against a theme's expected script. Returns a human-readable
// Hebrew warning string when the name doesn't fit the theme's name_form, or null
// when it fits (or there is nothing to check). Shared by the pre-production
// validator below and the live order preview (/api/preview), so the customer
// sees the same language warning immediately while choosing.
function checkNameLanguage(name, theme) {
  const n = name ? String(name).trim() : '';
  if (!n || !theme || !theme.name_form) return null;
  const form = theme.name_form;
  const hasHeb = HEBREW_RE.test(n);
  const hasLat = LATIN_RE.test(n);
  const expected = LANG_LABEL[form] || form;
  const bad =
    form === 'hebrew'
      ? !hasHeb || hasLat
      : (form === 'english' || form === 'english-caps') && (!hasLat || hasHeb);
  if (!bad) return null;
  return 'שם החוגג/ת צריך להיות ב' + expected + ' (בהתאם לעיצוב): "' + n + '"';
}

// PURE validator: given the collection, its theme config (from getTheme, may be
// null when the theme is unknown), and the words list (an array or a count),
// returns an array of human-readable Hebrew problem strings. Empty array = the
// order is producible. The same strings are stored on order.production.errors,
// shown in admin, and listed in the client/Dugri email.
function validateOrderForProduction(collection, theme, words) {
  const problems = [];
  const name = collection && collection.honoree_name ? String(collection.honoree_name).trim() : '';

  // 1) Name language must match the theme's name_form.
  const langProblem = checkNameLanguage(name, theme);
  if (langProblem) problems.push(langProblem);

  // 2) Every extra field the theme requires must be present — UNLESS the buyer
  // set their own custom title. The theme extras (AGE / YEARS / NAME1 / NAME2)
  // only ever fed the DEFAULT title, so a custom-title order does not need them
  // and must not be flagged for their absence.
  const hasCustomTitle = String((collection && collection.custom_title) || '').trim() !== '';
  const required =
    !hasCustomTitle && theme && Array.isArray(theme.extra_fields) ? theme.extra_fields : [];
  for (const field of required) {
    if (!readExtraField(collection, field)) {
      const label = FIELD_LABEL[field] || field;
      problems.push('חסר שדה חובה: ' + label + ' (' + field + ')');
    }
  }

  // 3) At least one word to produce.
  const count = Array.isArray(words) ? words.length : Number(words) || 0;
  if (count < 1) {
    problems.push('אין מילים להפקה — יש להוסיף לפחות מילה אחת.');
  }

  return problems;
}

module.exports = {
  loadThemes,
  getTheme,
  checkNameLanguage,
  validateOrderForProduction,
  MAX_WORD_LEN,
  normalizeWordText,
  isWordTooLong,
  wordLengthMessage,
  wordLengthMessageForLen,
};
