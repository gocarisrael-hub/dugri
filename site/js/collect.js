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
 * Parse pasted text or a .txt/.csv file's contents into an array of words.
 * Splits on newlines and commas (covers one-per-line lists and CSV/comma lists).
 * @returns {string[]}
 */
export function parseWordText(text) {
  return String(text == null ? '' : text)
    .split(/[\n\r,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
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
