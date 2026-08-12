// collect.js — pure helpers for the collaborative word-collection page.
// No top-level DOM access (like configurator.js) so it's unit-testable.

/**
 * The longest a single word ENTRY may be — the whole entry, spaces included, not
 * per unbroken token. "מכבי חיפה" (9) and "בית ספר" (7) pass; a 30-character
 * entry does not.
 *
 * MIRRORS `MAX_WORD_LEN` in server/validate.js, which is the authority — this is
 * the browser's copy so a too-long entry is caught while it is being typed
 * instead of hours later. tests/unit/word-length.test.js asserts the two numbers
 * are equal, so they cannot drift apart unnoticed.
 */
export const MAX_WORD_LEN = 25;

/** Normalize a word for dedupe: trim, collapse inner whitespace, lowercase. */
export function normalizeWord(s) {
  return String(s == null ? '' : s)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Dedupe + clean a list of words. Trims and collapses whitespace, drops empties,
 * removes case/space-insensitive duplicates, and preserves first-seen order.
 * @returns {string[]}
 */
export function dedupeWords(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw == null ? '' : raw)
      .trim()
      .replace(/\s+/g, ' ');
    if (!text) continue;
    const n = normalizeWord(text);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(text);
  }
  return out;
}

/**
 * Order a word list newest-first for display. The server returns words in
 * insertion order (oldest first, newest last), so a NON-mutating reverse puts the
 * most recently added word at the top — where the owner/contributor sees it
 * immediately. Stable across refreshes (server order is stable), and it never
 * touches the source array, so delete/edit still target words by id regardless of
 * display order.
 * @returns {Array}
 */
export function newestFirst(words) {
  return Array.isArray(words) ? words.slice().reverse() : [];
}

/**
 * How much of a batch has to look numbered before we believe it is a list.
 * A numbered list is a property of the BATCH, not of one line: "1. משהו" pasted
 * alone is ambiguous, sixty-three lines numbered 1..63 are not.
 */
export const LIST_MIN_ENTRIES = 3;
export const LIST_MIN_SHARE = 0.6;

function ordinalOf(entry) {
  const m = /^(\d{1,3})\s*([.)\]:\-])(\s*)(.*)$/.exec(entry);
  if (!m) return null;
  const [, num, , gap, rest] = m;
  if (!rest) return null;
  // No space after the separator? Then the remainder must not start with a digit,
  // so a decimal ("14.5") is never mistaken for an ordinal and its value.
  if (!gap && /^\d/.test(rest)) return null;
  return { n: Number(num), rest: rest.trim() };
}

/**
 * Drop the numbering from a pasted numbered list — and ONLY from one.
 *
 * People paste "1. שוקולד / 2. הצחוק שלה / 3. …" straight out of Notes or
 * WhatsApp, and every number used to be stored as part of the word and printed on
 * the card. The owner sent a collection where sixty-three entries all carried
 * their list number.
 *
 * The danger is the opposite mistake, and her own list is full of it: "ערוץ 14",
 * "שירלי מכאן 11", "C14" and "60 שניות עם ליאל אלי" are real words with real
 * numbers in them. So this never touches a number that is not a LEADING ordinal
 * followed by a separator, and never acts on a single line in isolation — a batch
 * qualifies only when enough of it is numbered AND the numbers do not repeat,
 * which is what tells a list apart from a coincidence.
 *
 * Returns the entries unchanged when the batch does not qualify.
 * @returns {string[]}
 */
export function stripListNumbers(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length < LIST_MIN_ENTRIES) return list;
  const parsed = list.map(ordinalOf);
  const numbered = parsed.filter(Boolean);
  if (numbered.length < LIST_MIN_ENTRIES) return list;
  if (numbered.length / list.length < LIST_MIN_SHARE) return list;
  // Distinct numbers: a real list counts, it does not repeat. This is what stops
  // a batch of prices or scores ("3. 3. 3.") reading as an ordered list.
  const distinct = new Set(numbered.map((p) => p.n));
  if (distinct.size !== numbered.length) return list;
  return list.map((entry, i) => (parsed[i] ? parsed[i].rest : entry));
}

/**
 * Parse pasted text or a .txt/.csv file's contents into an array of words.
 * Splits on newlines and commas (covers one-per-line lists and CSV/comma lists),
 * then drops list numbering when the batch is a numbered list (stripListNumbers).
 * @returns {string[]}
 */
export function parseWordText(text) {
  return stripListNumbers(
    String(text == null ? '' : text)
      .split(/[\n\r,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * The stored/rendered form of an entry: trimmed, inner whitespace collapsed. The
 * length cap is measured against this, so "מכבי  חיפה" counts as 9 — we measure
 * what lands on the card, not what was typed.
 * @returns {string}
 */
export function cleanWord(s) {
  return String(s == null ? '' : s)
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * True when an entry is over MAX_WORD_LEN (measured on its cleaned form).
 * @returns {boolean}
 */
export function isWordTooLong(s) {
  return cleanWord(s).length > MAX_WORD_LEN;
}

/**
 * The Hebrew message for one over-length entry, naming the ACTUAL length and the
 * limit so the person typing knows how much to cut. Null when the entry fits.
 * @returns {string|null}
 */
export function wordLengthMessage(s) {
  const t = cleanWord(s);
  if (t.length <= MAX_WORD_LEN) return null;
  return (
    'המילה ארוכה מדי: ' + t.length + ' תווים, המקסימום הוא ' + MAX_WORD_LEN + '. קצרו ונסו שוב.'
  );
}

/**
 * Split a parsed list into the entries that may be submitted and the over-length
 * ones. Used by the paste/file paths so a batch still submits its good words and
 * the customer is told exactly which ones were left behind, rather than the whole
 * paste failing.
 * @returns {{ok: string[], tooLong: string[]}}
 */
export function splitByLength(list) {
  const ok = [];
  const tooLong = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const w = cleanWord(raw);
    if (!w) continue;
    if (w.length > MAX_WORD_LEN) tooLong.push(w);
    else ok.push(w);
  }
  return { ok, tooLong };
}

/**
 * The Hebrew message for a batch that had over-length entries, naming them (up to
 * 3) so they can be found and shortened. Null when there were none.
 * @returns {string|null}
 */
export function batchLengthMessage(tooLong) {
  if (!Array.isArray(tooLong) || !tooLong.length) return null;
  if (tooLong.length === 1) return wordLengthMessage(tooLong[0]);
  const shown = tooLong.slice(0, 3).map((w) => '"' + w + '"');
  return (
    tooLong.length +
    ' מילים לא נוספו כי הן ארוכות מדי (המקסימום ' +
    MAX_WORD_LEN +
    ' תווים): ' +
    shown.join(', ') +
    (tooLong.length > shown.length ? ' ועוד' : '')
  );
}

function csvEscape(cell) {
  let s = String(cell == null ? '' : cell);
  // Neutralize spreadsheet formula injection (leading =, +, -, @, tab, CR).
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Build the print-ready Bulk-Create CSV: 32 columns c1w1..c8w4 (card,word),
 * one row per page of 32 words, last row padded with empty strings.
 * Ported from the Python build_csv in CLAUDE.md (shuffle omitted for
 * deterministic output; callers can pre-shuffle if desired).
 * @returns {string} CSV text
 */
export function buildBulkCsv(words) {
  const PER = 32;
  const clean = dedupeWords(words);
  const headers = [];
  for (let c = 1; c <= 8; c++) for (let w = 1; w <= 4; w++) headers.push(`c${c}w${w}`);
  const pages = Math.max(1, Math.ceil(clean.length / PER));
  const padded = clean.concat(new Array(pages * PER - clean.length).fill(''));
  const rows = [headers.join(',')];
  for (let p = 0; p < pages; p++) {
    rows.push(
      padded
        .slice(p * PER, (p + 1) * PER)
        .map(csvEscape)
        .join(',')
    );
  }
  return rows.join('\n');
}
