// Pre-production order validation. Before we spend money/time generating a
// print-ready PDF we check that the order is actually producible: the honoree
// name is in the language the chosen theme expects, every extra field the theme
// requires is filled in, and there is at least one word. The core
// `validateOrderForProduction` is a PURE function (no I/O) so it is trivially
// unit-testable; `getTheme`/`loadThemes` are the thin I/O helpers that read the
// generator's themes.json.
const fs = require('fs');
const path = require('path');

// generator/themes.json, relative to this file (server/ -> ../generator/).
const THEMES_PATH = path.join(__dirname, '..', 'generator', 'themes.json');

// Read + parse themes.json fresh each call (it is tiny and rarely changes, and
// reading it live keeps tests from fighting a cached copy). Returns {} when the
// file is missing/unparseable so a bad file never crashes a generation request.
function loadThemes() {
  try {
    return JSON.parse(fs.readFileSync(THEMES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// The theme config object for a themes.json key, or null when unknown.
function getTheme(name) {
  const themes = loadThemes();
  return (name && themes[name]) || null;
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

  // 2) Every extra field the theme requires must be present.
  const required = theme && Array.isArray(theme.extra_fields) ? theme.extra_fields : [];
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
};
