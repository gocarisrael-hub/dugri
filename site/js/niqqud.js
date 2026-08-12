// niqqud.js — the browser's copy of the niqqud refusal.
//
// THE RULE: a new word may not be pointed. "שָׁלוֹם" is refused; "שלום" is what
// goes on the card.
//
// The vowel points and cantillation marks are COMBINING marks — they hang off
// the letter before them — and the card faces are display fonts drawn for
// unpointed Hebrew (Gveret Levin, Comix, Aharoni CLM…). So a pointed word does
// not print as a pointed word: the marks land as boxes, collide with the letter,
// or vanish, on a deck the customer has already paid for. They also spend the
// entry cap: "שָׁלוֹם" counts 8 characters for a 5-letter word.
//
// REFUSED, not stripped — even though stripping loses no meaning (שָׁלוֹם and שלום
// read the same). Nothing here silently rewrites what a person typed; a refusal
// is a correction she makes herself in one line, a strip is a change nobody is
// told about. The message carries the unpointed form so the fix can be copied
// straight out of it.
//
// server/validate.js is the AUTHORITY — this file only makes the wall arrive
// WHILE she is typing rather than as an HTTP 400 after she has moved on.
// tests/unit/niqqud.test.js pins NIQQUD_CHARS character-for-character against
// the server's, so the two cannot drift into disagreeing.

/**
 * The Hebrew combining marks, as a regex source string — and ONLY those:
 *
 *   U+0591–U+05AF   te'amim (cantillation)
 *   U+05B0–U+05BD   the points themselves (sheva … meteg)
 *   U+05BF          rafe
 *   U+05C1, U+05C2  shin dot / sin dot
 *   U+05C4, U+05C5  upper / lower dot
 *   U+05C7          qamats qatan
 *
 * NOT here, and tested to stay accepted: the Hebrew block's PUNCTUATION, which
 * is ordinary printable type — U+05BE maqaf (בן־גוריון), U+05C0 paseq, U+05C3
 * sof pasuq, U+05C6 nun hafukha, and the geresh ׳ / gershayim ״ (U+05F3/U+05F4)
 * that abbreviations like ר״ח are written with.
 */
export const NIQQUD_CHARS = '\\u0591-\\u05BD\\u05BF\\u05C1\\u05C2\\u05C4\\u05C5\\u05C7';

const NIQQUD_RE = new RegExp('[' + NIQQUD_CHARS + ']', 'u');

/** True when the string carries any Hebrew combining mark. */
export function hasNiqqud(s) {
  return NIQQUD_RE.test(String(s == null ? '' : s));
}

/**
 * The same string without its marks — the form to type instead. Used to SHOW the
 * fix, never to submit: the page refuses the word, it does not correct it.
 */
export function stripNiqqud(s) {
  return String(s == null ? '' : s).replace(new RegExp('[' + NIQQUD_CHARS + ']', 'gu'), '');
}

/**
 * The Hebrew refusal for one word entry, naming the unpointed form. The marks
 * are invisible on their own, so "remove the niqqud" with nothing to point at is
 * not actionable — the clean word is.
 * @returns {string|null}
 */
export function wordNiqqudMessage(s) {
  if (!hasNiqqud(s)) return null;
  const clean = stripNiqqud(s).trim().replace(/\s+/g, ' ');
  return 'אי אפשר להדפיס ניקוד על הקלפים - הסירו אותו וכתבו: ' + clean;
}

/**
 * Split a list into the entries that may be submitted and the pointed ones.
 * Mirrors splitByEmoji: a paste still submits its good words, and the customer
 * is told which were left behind, rather than the whole paste failing over one
 * pointed word.
 * @returns {{ok: string[], withNiqqud: string[]}}
 */
export function splitByNiqqud(list) {
  const ok = [];
  const withNiqqud = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const w = String(raw == null ? '' : raw).trim();
    if (!w) continue;
    if (hasNiqqud(w)) withNiqqud.push(w);
    else ok.push(w);
  }
  return { ok, withNiqqud };
}

/**
 * The Hebrew message for a batch that was pointed, naming the words (up to 3) in
 * their unpointed form so they can be retyped, not just counted. Null when clean.
 * @returns {string|null}
 */
export function batchNiqqudMessage(list) {
  const bad = Array.isArray(list) ? list : [];
  if (!bad.length) return null;
  if (bad.length === 1) return wordNiqqudMessage(bad[0]);
  const shown = bad.slice(0, 3).map((w) => stripNiqqud(w).trim().replace(/\s+/g, ' '));
  return (
    bad.length +
    ' מילים לא נוספו כי הן מנוקדות (אי אפשר להדפיס ניקוד על הקלפים). כתבו אותן בלי ניקוד: ' +
    shown.join(', ') +
    (bad.length > shown.length ? ' ועוד' : '')
  );
}
