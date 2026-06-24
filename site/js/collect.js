// collect.js — pure helpers for the collaborative word-collection page.
// No top-level DOM access (like configurator.js) so it's unit-testable.

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

function csvEscape(cell) {
  const s = String(cell == null ? '' : cell);
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
