// title-language.js — the browser's copy of the one-language title rule.
//
// THE RULE, the shop owner's (2026-10-18): the title the cards carry is in ONE language, Hebrew or English, never both.
// Digits, spaces and punctuation belong to neither and are always allowed, so "ליאת חוגגת 40!" and "Liat 40" pass and
// "Liat חוגגת 40" does not.
//
// It is what the generator already assumes. render_page.title_script reads the whole title's language off its FIRST
// strong letter and title_font_for sets the title in the one face that goes with it, and title_is_rtl takes the
// direction from the same letter. So in "Liat חוגגת" the Hebrew is set in a face picked for English (a design's Latin
// display face often has no Hebrew at all: Chrome draws it in a system font nobody chose, or assert_title_drawable
// refuses the deck), and the line is laid out left to right.
//
// server/validate.js is the AUTHORITY (POST /api/collections and PUT /api/collections/:id/title refuse a mixed title);
// this file lets the field say so while she types. tests/unit/title-language.test.js pins the two character classes
// against the server's.

/** Hebrew letters: the alef-bet with the final forms, the Yiddish ligatures, and the presentation forms. */
export const HEBREW_LETTERS = '\\u05D0-\\u05EA\\u05EF-\\u05F2\\uFB1D-\\uFB4F';
/** English letters, and the accented Latin a name may carry (é, ñ, ü); × and ÷ are not letters and are left out. */
export const LATIN_LETTERS = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F';

export const TITLE_LANGUAGE_MESSAGE = 'כותרת בשפה אחת בלבד - עברית או אנגלית';

const HEBREW_RE = new RegExp('[' + HEBREW_LETTERS + ']');
const LATIN_RE = new RegExp('[' + LATIN_LETTERS + ']');

/** True when the title has both Hebrew and English letters in it. */
export function titleMixesLanguages(s) {
  const t = String(s == null ? '' : s);
  return HEBREW_RE.test(t) && LATIN_RE.test(t);
}

/** The inline message for a mixed title, or null when it is in one language. */
export function titleLanguageMessage(s) {
  return titleMixesLanguages(s) ? TITLE_LANGUAGE_MESSAGE : null;
}
