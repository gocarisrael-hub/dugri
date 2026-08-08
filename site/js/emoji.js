// emoji.js — the browser's copy of the emoji refusal.
//
// THE RULE, in the shop owner's words: "refuse for emojis in title and words."
//
// Everything a buyer types into the custom title or the word list is PRINTED on
// cards. The card faces are Hebrew and Latin display fonts with no emoji glyphs,
// so a 🎉 does not reach the deck as a 🎉 — it reaches it as a blank box, or as
// whatever the renderer substitutes, on all 104 cards of an order she has
// already paid for, and she finds out when the parcel opens.
//
// Hence a REFUSAL rather than a clean-up. Silently stripping the emoji would be
// worse than refusing: she typed it on purpose, the deck would come back without
// it, and nothing would ever have told her. Refusing costs one correction.
//
// server/validate.js is the AUTHORITY — a client-side check is a courtesy, and a
// determined browser or a re-post has to hit the same wall. This file exists so
// the wall arrives WHILE she is typing, in the field, instead of as an HTTP 400
// after she has moved on. tests/unit/emoji.test.js pins EMOJI_CHARS and
// EMOJI_UNIT character-for-character against the server's, so the two can never
// drift into disagreeing about what is acceptable.
//
// No `\p{Extended_Pictographic}`: this file is served to phones untranspiled,
// and an unsupported property escape is a PARSE error — it would take the whole
// wizard down rather than degrade. The ranges are hand-rolled instead, and each
// one is named below. The full reasoning (including everything deliberately left
// OUT, so an ordinary name is never refused) lives beside the server copy in
// server/validate.js — read that comment before changing a range here.

/**
 * The emoji character class, as a regex source string.
 *
 *   U+FE0F           the "render as emoji" selector — the difference between the
 *                    printable © and the unprintable ©️
 *   U+20E3           the combining keycap (1️⃣–9️⃣)
 *   U+2600–U+27BF    Miscellaneous Symbols (☀ ☎ ★ ⚡ ❗) + Dingbats (✂ ✈ ✅ ❤ ➕)
 *   U+2B00–U+2BFF    Misc Symbols and Arrows (⭐ ⭕ ⬛ ⬅)
 *   U+231A/B, 23CF,  the emoji stranded inside Miscellaneous Technical
 *   23E9–23F3,       (⌚ ⌛ ⏏ ⏩ ⏰ ⏳ ⏸ ⏺) — picked out one by one, because the
 *   23F8–23FA        rest of that block is ordinary technical marks
 *   U+3030, 303D,    〰 〽 ㊗ ㊙
 *   U+3297, 3299
 *   U+1F000–U+1FAFF  the pictographic planes; contains no letter, digit or mark
 *                    of punctuation in any script, so it is taken whole. Skin
 *                    tones (1F3FB–1F3FF) and the regional-indicator letters that
 *                    build flag pairs (1F1E6–1F1FF) live inside it.
 *   U+E0000–U+E007F  the invisible tag characters that spell subdivision flags
 *
 * NOT here, and tested to stay accepted: © ® ™ ‼ ⁉ ℹ, the arrows U+2190–U+21FF,
 * the en/em dashes a phone substitutes for a hyphen, the Hebrew geresh ׳ and
 * gershayim ״, niqqud, digits and ordinary Latin punctuation. U+200D (ZWJ) is
 * not here either — an emoji ZWJ sequence always contains a pictograph, so 👩‍👩‍👧
 * is caught by its members; ZWJ appears only as the JOIN in findEmoji, so a
 * family is reported as ONE emoji the way a person sees it.
 */
export const EMOJI_CHARS =
  '\\uFE0F' +
  '\\u20E3' +
  '\\u2600-\\u27BF' +
  '\\u2B00-\\u2BFF' +
  '\\u231A\\u231B\\u23CF' +
  '\\u23E9-\\u23F3\\u23F8-\\u23FA' +
  '\\u3030\\u303D\\u3297\\u3299' +
  '\\u{1F000}-\\u{1FAFF}' +
  '\\u{E0000}-\\u{E007F}';

/** One pictograph plus what attaches to it: VS16, a skin tone, trailing tags. */
const EMOJI_ATOM = '[' + EMOJI_CHARS + ']\\uFE0F?[\\u{1F3FB}-\\u{1F3FF}]?[\\u{E0020}-\\u{E007F}]*';

/**
 * One emoji as a PERSON counts it. Keycaps and flag pairs come first (both are
 * built from several codepoints and would otherwise split); then an atom with
 * any number of ZWJ-joined atoms, which is what makes 👩‍👩‍👧 one emoji rather than
 * three. The last alternative catches an ACCEPTED character wearing the emoji
 * selector (©️) — without it the refusal for "©️" would name a lone invisible
 * U+FE0F and read as "remove: ".
 */
export const EMOJI_UNIT =
  '[0-9#*]\\uFE0F?\\u20E3' +
  '|[\\u{1F1E6}-\\u{1F1FF}]{2}' +
  '|' +
  EMOJI_ATOM +
  '(?:\\u200D' +
  EMOJI_ATOM +
  ')*' +
  '|[^' +
  EMOJI_CHARS +
  '\\u200D]\\uFE0F';

/**
 * True when the string contains any emoji. Cheap — this runs on every keystroke.
 * @returns {boolean}
 */
export function hasEmoji(s) {
  return new RegExp('[' + EMOJI_CHARS + ']', 'u').test(String(s == null ? '' : s));
}

/**
 * The emoji in a string, in order, de-duplicated, each one a whole
 * user-perceived emoji. Used to NAME them in the refusal: "remove 🎉" is
 * actionable, "invalid input" is not.
 * @returns {string[]}
 */
export function findEmoji(s) {
  const found = String(s == null ? '' : s).match(new RegExp(EMOJI_UNIT, 'gu')) || [];
  const seen = new Set();
  const out = [];
  for (const e of found) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

/** At most 5 of the offending emoji, so an all-emoji paste is not a wall of text. */
function emojiList(found) {
  return found.slice(0, 5).join(' ') + (found.length > 5 ? ' ועוד' : '');
}

/**
 * The Hebrew refusal for a custom title: what is wrong, why, and which character
 * to remove. Null when the title is clean.
 * @returns {string|null}
 */
export function titleEmojiMessage(s) {
  const found = findEmoji(s);
  if (!found.length) return null;
  return 'אי אפשר להדפיס אימוג׳י על הקלפים - הסירו אותו מהכותרת: ' + emojiList(found);
}

/**
 * The same refusal for the honoree's name — the DEFAULT title is built from it,
 * so an emoji there lands on the same printed line.
 * @returns {string|null}
 */
export function nameEmojiMessage(s) {
  const found = findEmoji(s);
  if (!found.length) return null;
  return 'אי אפשר להדפיס אימוג׳י על הקלפים - הסירו אותו מהשם: ' + emojiList(found);
}

/**
 * The same refusal for one word entry.
 * @returns {string|null}
 */
export function wordEmojiMessage(s) {
  const found = findEmoji(s);
  if (!found.length) return null;
  return 'אי אפשר להדפיס אימוג׳י על הקלפים - הסירו אותו מהמילה: ' + emojiList(found);
}

/**
 * Split a list into the entries that may be submitted and the ones carrying
 * emoji. Mirrors splitByLength in collect.js: a paste still submits its good
 * words, and the customer is told exactly which ones were left behind, rather
 * than the whole paste failing over one 🎉.
 * @returns {{ok: string[], withEmoji: string[]}}
 */
export function splitByEmoji(list) {
  const ok = [];
  const withEmoji = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const w = String(raw == null ? '' : raw).trim();
    if (!w) continue;
    if (hasEmoji(w)) withEmoji.push(w);
    else ok.push(w);
  }
  return { ok, withEmoji };
}

/**
 * The Hebrew message for a batch that carried emoji, naming the words (up to 3)
 * so they can be found and fixed rather than only counted. Null when clean.
 * @returns {string|null}
 */
export function batchEmojiMessage(list) {
  const bad = Array.isArray(list) ? list : [];
  if (!bad.length) return null;
  if (bad.length === 1) return wordEmojiMessage(bad[0]);
  const shown = bad.slice(0, 3).map((w) => '"' + w + '"');
  return (
    bad.length +
    ' מילים לא נוספו כי הן מכילות אימוג׳י (אי אפשר להדפיס אותו על הקלפים): ' +
    shown.join(', ') +
    (bad.length > shown.length ? ' ועוד' : '')
  );
}
