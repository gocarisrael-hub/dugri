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

// ---------------------------------------------------------------------------
// Emoji: REFUSED, never stripped.  ("refuse for emojis in title and words")
// ---------------------------------------------------------------------------
// Everything a buyer types into the title or the word list is PRINTED. The card
// faces are Hebrew and Latin display fonts with no emoji glyphs at all, so a 🎉
// does not arrive on the card as a 🎉 — it arrives as a blank box, or as
// whatever the renderer happens to substitute, on all 104 cards of an order the
// customer already paid for, and she finds out when the parcel opens.
//
// So the rule is a REFUSAL, at the moment she types it, not a clean-up. Silently
// stripping the emoji would be worse than refusing: she put it there on purpose,
// the deck would come back without it, and nothing would ever have told her.
// Refusing costs one correction; stripping costs the order's goodwill.
//
// This is a companion to — NOT a replacement for — the font-coverage guard
// (render_page.assert_title_drawable). That one asks "can THIS font draw this
// character"; this one asks "is this character an emoji", which is a question no
// font can answer for us and which we want answered in the browser, before the
// order exists.
//
// WHAT COUNTS. There is no `regex` module on the Python side and no Unicode
// property escape (`\p{Extended_Pictographic}`) anywhere in this repo — the
// site's ES modules are served to phones untranspiled, and an unsupported escape
// is a PARSE error, which takes the whole wizard down rather than degrading. So
// the ranges are hand-rolled, and here is exactly what is in them and why:
//
//   U+FE0F                 VS16, the "render the previous character as an emoji"
//                          selector. Refused on its own — it is the difference
//                          between the printable © and the unprintable ©️.
//   U+20E3                 the combining keycap, which only ever builds 1️⃣–9️⃣.
//   U+2600–U+27BF          Miscellaneous Symbols (☀ ☎ ★ ⚡ ❗) + Dingbats
//                          (✂ ✈ ✉ ✅ ❤ ➕). Whole blocks: every member is a
//                          pictograph, and no card font draws any of them.
//   U+2B00–U+2BFF          Misc Symbols and Arrows — ⭐ ⭕ ⬛ ⬅.
//   U+231A U+231B U+23CF,  the handful of emoji stranded inside Miscellaneous
//   U+23E9–U+23F3,         Technical (⌚ ⌛ ⏏ ⏩ ⏰ ⏳ ⏸ ⏺). Picked out one by one
//   U+23F8–U+23FA          rather than taking the block, which is full of
//                          ordinary technical marks.
//   U+3030 U+303D          〰 〽 ㊗ ㊙ — the four CJK characters with emoji
//   U+3297 U+3299          presentation.
//   U+1F000–U+1FAFF        the pictographic planes: mahjong/domino/cards,
//                          enclosed supplements, Misc Symbols & Pictographs,
//                          Emoticons, Transport & Map, Supplemental Symbols,
//                          Chess, Extended-A. Taken whole because the range
//                          contains no text at all — nothing in it is a letter,
//                          a digit or a mark of punctuation in any script.
//                          Skin-tone modifiers (U+1F3FB–U+1F3FF) and the
//                          regional-indicator letters that build flag pairs
//                          (U+1F1E6–U+1F1FF) live inside it.
//   U+E0000–U+E007F        the tag characters that spell out subdivision flags
//                          (🏴󠁧󠁢󠁳󠁣󠁴󠁿). Invisible on their own, so they must be named.
//
// WHAT IS DELIBERATELY *NOT* IN THEM. Over-refusing loses orders, and a buyer
// turned away for typing her own name is the expensive failure here. So the line
// is drawn at emoji-BY-DEFAULT: a character that a plain text font renders as
// ordinary type is accepted, even when Unicode also lists it as an emoji.
// Accepted, with tests to keep them accepted: © ® ™ (Latin-1 / letterlike, and
// the owner said © stays), ‼ ⁉ ℹ (punctuation and letterlike), → ↔ ↩ and the
// rest of U+2190–U+21FF (typographic arrows), – — the en/em dashes a phone
// substitutes for a hyphen, the Hebrew geresh ׳ and gershayim ״, apostrophes,
// niqqud and te'amim (U+0591–U+05C7), digits, and every ordinary Latin mark.
// Any of those the moment it is followed by U+FE0F is refused — at that point it
// is not the typographic character any more, it is the emoji.
//
// U+200D (ZWJ) is NOT in the class on purpose: an emoji ZWJ sequence always
// contains at least one pictograph, so 👩‍👩‍👧 is already caught by its members. ZWJ
// only appears below as the JOIN in findEmoji, so that the family is reported as
// ONE thing the way a person sees it, not as three.
const EMOJI_CHARS =
  '\\uFE0F' + // emoji presentation selector
  '\\u20E3' + // combining enclosing keycap
  '\\u2600-\\u27BF' + // Miscellaneous Symbols + Dingbats
  '\\u2B00-\\u2BFF' + // Miscellaneous Symbols and Arrows
  '\\u231A\\u231B\\u23CF' + // ⌚ ⌛ ⏏
  '\\u23E9-\\u23F3\\u23F8-\\u23FA' + // ⏩…⏳, ⏸ ⏹ ⏺
  '\\u3030\\u303D\\u3297\\u3299' + // 〰 〽 ㊗ ㊙
  '\\u{1F000}-\\u{1FAFF}' + // the pictographic planes (incl. skin tones + flags)
  '\\u{E0000}-\\u{E007F}'; // flag tag characters

// One emoji "atom": a pictograph plus the pieces that attach to it — an optional
// VS16, an optional skin tone, and any trailing flag tags.
const EMOJI_ATOM = '[' + EMOJI_CHARS + ']\\uFE0F?[\\u{1F3FB}-\\u{1F3FF}]?[\\u{E0020}-\\u{E007F}]*';

// One emoji as a PERSON counts it. Keycaps and flag pairs first (both are built
// from several codepoints and would otherwise split), then an atom with any
// number of ZWJ-joined atoms after it — which is what makes 👩‍👩‍👧 report as one
// emoji rather than three.
// The last alternative is what makes the ©️ case readable: © is an ACCEPTED
// character, so it is not in EMOJI_CHARS and the atom cannot reach it — without
// this the refusal for "©️" would name a lone, invisible U+FE0F and read as
// "remove: ". It matches only when the character carrying the selector is itself
// accepted, so it can never steal a codepoint from a real emoji sequence.
const EMOJI_UNIT =
  '[0-9#*]\\uFE0F?\\u20E3' + // 1️⃣  #️⃣
  '|[\\u{1F1E6}-\\u{1F1FF}]{2}' + // 🇮🇱
  '|' +
  EMOJI_ATOM +
  '(?:\\u200D' +
  EMOJI_ATOM +
  ')*' + // 👩‍👩‍👧  🏳️‍🌈
  '|[^' +
  EMOJI_CHARS +
  '\\u200D]\\uFE0F'; // ©️  ‼️  →️

// True when the string contains ANY emoji character. Cheap — this is the check
// that runs on every keystroke and on every word of an inbound list.
function hasEmoji(s) {
  return new RegExp('[' + EMOJI_CHARS + ']', 'u').test(String(s == null ? '' : s));
}

// The emoji in a string, in the order they appear, de-duplicated, each one a
// whole user-perceived emoji. Used to NAME them in the refusal — "remove 🎉" is
// actionable, "invalid input" is not.
function findEmoji(s) {
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

// The offending emoji, listed for a message: at most 5, so a paste made entirely
// of emoji doesn't produce a wall of text.
function emojiList(found) {
  return found.slice(0, 5).join(' ') + (found.length > 5 ? ' ועוד' : '');
}

// The Hebrew refusal for a custom title. It says WHAT is wrong (an emoji), WHY
// (it cannot be printed) and WHICH character to remove. Null when the title is
// clean.
function titleEmojiMessage(s) {
  const found = findEmoji(s);
  if (!found.length) return null;
  return 'אי אפשר להדפיס אימוג׳י על הקלפים - הסירו אותו מהכותרת: ' + emojiList(found);
}

// The same refusal for the honoree's name, which is what the DEFAULT title is
// built from — so an emoji there lands on exactly the same printed line.
function nameEmojiMessage(s) {
  const found = findEmoji(s);
  if (!found.length) return null;
  return 'אי אפשר להדפיס אימוג׳י על הקלפים - הסירו אותו מהשם: ' + emojiList(found);
}

// The same refusal for one word entry.
function wordEmojiMessage(s) {
  const found = findEmoji(s);
  if (!found.length) return null;
  return 'אי אפשר להדפיס אימוג׳י על הקלפים - הסירו אותו מהמילה: ' + emojiList(found);
}

// The Hebrew refusal for a BATCH of entries that carried emoji — a paste, a
// file, an inbound WhatsApp message. Names the words themselves (up to 3) so
// they can be found and fixed, rather than only counting them. Null when the
// batch was clean.
function batchEmojiMessage(list) {
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

// ---------------------------------------------------------------------------
// Niqqud: REFUSED on a new word, never stripped.
// ---------------------------------------------------------------------------
// The vowel points and cantillation marks are COMBINING marks — they hang off
// the letter before them, and the card faces are display fonts (Gveret Levin,
// Comix, Aharoni CLM…) drawn for unpointed Hebrew. A pointed word therefore does
// not print as a pointed word: the marks land as boxes, or collide with the
// letter, or vanish — per card, on a deck that was already paid for. They also
// eat the entry cap, so "שָׁלוֹם" counts as 8 characters for a 5-letter word.
//
// Why refuse rather than strip, when stripping loses no meaning (שָׁלוֹם and שלום
// read the same)? Because the same reason the emoji rule refuses applies here in
// weaker form — this codebase does not silently rewrite what a person typed —
// and because a refusal is a one-line correction the contributor makes herself,
// while a strip is a change nobody is ever told about. The message carries the
// unpointed form, so the fix is to copy the word back out of it.
//
// WHAT COUNTS: the combining marks of the Hebrew block, and only those.
//   U+0591–U+05AF   te'amim (cantillation)
//   U+05B0–U+05BD   the points themselves (sheva … meteg)
//   U+05BF          rafe
//   U+05C1 U+05C2   shin dot / sin dot
//   U+05C4 U+05C5   upper/lower dot
//   U+05C7          qamats qatan
//
// WHAT IS DELIBERATELY NOT: the Hebrew block's PUNCTUATION, which is ordinary
// printable type and is accepted — U+05BE maqaf (־), U+05C0 paseq, U+05C3 sof
// pasuq, U+05C6 nun hafukha, and the geresh ׳ / gershayim ״ (U+05F3/U+05F4) that
// abbreviations are written with. A word like ר״ח or בן־גוריון is normal Hebrew
// and must keep sailing through.
const NIQQUD_CHARS = '\\u0591-\\u05BD\\u05BF\\u05C1\\u05C2\\u05C4\\u05C5\\u05C7';
const NIQQUD_RE = new RegExp('[' + NIQQUD_CHARS + ']', 'u');

// True when the string carries any Hebrew combining mark.
function hasNiqqud(s) {
  return NIQQUD_RE.test(String(s == null ? '' : s));
}

// The same string without its marks — the form the contributor should type. Used
// to SHOW the fix in the refusal, never to store: nothing here rewrites a word.
function stripNiqqud(s) {
  return String(s == null ? '' : s).replace(new RegExp('[' + NIQQUD_CHARS + ']', 'gu'), '');
}

// The Hebrew refusal for one word entry. It names the word AND its unpointed
// form, because the marks are invisible on their own — "remove the niqqud" with
// nothing to point at is not actionable, and the clean form can just be copied.
function wordNiqqudMessage(s) {
  if (!hasNiqqud(s)) return null;
  const clean = normalizeWordText(stripNiqqud(s));
  return 'אי אפשר להדפיס ניקוד על הקלפים - הסירו אותו וכתבו: ' + clean;
}

// The same refusal for a BATCH — a paste, a file, an inbound WhatsApp message.
// Names the unpointed words (up to 3) so they can be retyped, not just counted.
function batchNiqqudMessage(list) {
  const bad = Array.isArray(list) ? list : [];
  if (!bad.length) return null;
  if (bad.length === 1) return wordNiqqudMessage(bad[0]);
  const shown = bad.slice(0, 3).map((w) => normalizeWordText(stripNiqqud(w)));
  return (
    bad.length +
    ' מילים לא נוספו כי הן מנוקדות (אי אפשר להדפיס ניקוד על הקלפים). כתבו אותן בלי ניקוד: ' +
    shown.join(', ') +
    (bad.length > shown.length ? ' ועוד' : '')
  );
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

// The extra fields a render should ACTUALLY use for an order, as one flat
// {FIELD: value} dict — the same sources `readExtraField` consults, plus an
// optional per-request `override`.
//
// This exists because "what we validated" and "what we rendered" were read from
// two different places. The generate route took the fields from the REQUEST BODY
// alone and defaulted to {}, while the validator read them off the stored order —
// and the admin "produce" button posts nothing but `{theme}`. So every produced
// order rendered with an empty dict: טוקיו's title ("{NAME}'S" / "{AGE}S") lost
// its age and printed a lone "S", because config.py's title_lines() strips any
// placeholder it cannot fill. Silent, and only visible on the finished PDF.
//
// Precedence, lowest first: order.extra_fields, then collection.extra_fields
// (matching readExtraField's collection-first result), then `override`. A BLANK
// value never wins — a layer can only supply a field, never erase one, so a
// caller that omits (or blanks) a field falls back to what the buyer chose
// instead of silently dropping it from a paid order. To actually change a
// field, edit the order (PATCH /api/admin/collections/:id) — the stored order
// stays the single source of truth for what the buyer bought.
function effectiveExtraFields(collection, override) {
  const order = (collection && collection.order) || null;
  const out = {};
  const layers = [order && order.extra_fields, collection && collection.extra_fields, override];
  for (const src of layers) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v == null) continue;
      const key = String(k).trim();
      const val = String(v).trim();
      if (!key || !val) continue;
      out[key] = val;
    }
  }
  return out;
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

  // Whether this order carries its own title. Every order placed through the
  // wizard now does — the buyer types the title and nothing composes one — so
  // both checks below apply only to the ORDERS THAT PREDATE that, which still
  // print a title the theme composes from the name and its extra fields.
  const hasCustomTitle = String((collection && collection.custom_title) || '').trim() !== '';

  // 1) Name language must match the theme's name_form — for a legacy order only.
  // The name is not printed on a title-carrying order: it is the order's label,
  // taken from the title's first line, so a Hebrew label on an English design is
  // not a problem to flag, it is just what she called her order.
  const langProblem = hasCustomTitle ? null : checkNameLanguage(name, theme);
  if (langProblem) problems.push(langProblem);

  // 2) Every extra field the theme requires must be present — again, legacy only.
  // The extras (AGE / YEARS / NAME1 / NAME2) only ever fed the composed title.
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
  readExtraField,
  effectiveExtraFields,
  validateOrderForProduction,
  MAX_WORD_LEN,
  normalizeWordText,
  isWordTooLong,
  wordLengthMessage,
  wordLengthMessageForLen,
  // Emoji refusal. EMOJI_CHARS / EMOJI_UNIT are exported so the browser copy
  // (site/js/emoji.js) can be pinned character-for-character against them in
  // tests/unit/emoji.test.js — a drift between the two would mean the field and
  // the API disagree about what is acceptable.
  EMOJI_CHARS,
  EMOJI_UNIT,
  hasEmoji,
  findEmoji,
  titleEmojiMessage,
  nameEmojiMessage,
  wordEmojiMessage,
  batchEmojiMessage,
  // Niqqud refusal on a NEW word. NIQQUD_CHARS is exported for the same reason
  // EMOJI_CHARS is: the browser copy (site/js/niqqud.js) is pinned against it in
  // tests, so the field and the API can never disagree about what is acceptable.
  NIQQUD_CHARS,
  hasNiqqud,
  stripNiqqud,
  wordNiqqudMessage,
  batchNiqqudMessage,
};
