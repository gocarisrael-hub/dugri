// word-bank.js — freezing the approved 412 words as a production input.
//
// WHY THIS EXISTS. The deck is 104 cards, and the words fill whatever is left
// after its pawn cards: 412 on the standard deck (103 word cards x 4) and four
// fewer for every four players past the first four, which is db.deckWordsFor and
// what `deckWords` below has to be told.
// A buyer sends 70+ of her own and the rest is filled from a seed pool. Until
// now that fill happened at PRINT time, inside order_to_pdf, into a temp file in
// a scratch dir that is deleted with the run — so the 412 that got printed:
//
//   * did not exist before the print, so there was nothing to show anybody;
//   * was not stored, so nothing recorded what was actually produced;
//   * was NOT REPRODUCIBLE. The pools live in DATA_DIR/wordlists and the admin
//     wordlist screen rewrites them; the per-order pool override (#410) is
//     editable too. Re-run the same order after either changed and you get a
//     different 412.
//
// The last one is the one that matters. The production-preview step this repo is
// heading for has to show the customer THE deck that will be printed, and there
// can only be one production version of it. Neither is possible while the bank
// is recomputed on demand from mutable inputs.
//
// So: at APPROVAL (the owner closing the collection — סיום, which is what
// actually starts production) the top-up runs once and the result is stored on
// the collection. Production then prints the stored list.
//
// ONE IMPLEMENTATION OF THE RULE. The top-up is generator/topup.py and it stays
// there: this module SHELLS OUT to it rather than reimplementing the priority
// order (personal -> theme pool -> generic), the case/space-insensitive dedup or
// the store-shadows-image pool lookup in JavaScript. Two implementations of one
// rule is how the preview and the print end up disagreeing, which is the exact
// failure this whole change exists to prevent.
//
// HOW THE FROZEN BANK REACHES THE PRINTER — and why the generator needs no
// change at all. topup() keeps every word it is given and only fills a shortfall:
// hand it 412 and it returns those 412, in order, untouched. So production simply
// writes the frozen bank into the words file it already writes, and the deck is
// the approved bank by construction.
//
// ...which is also why the SIZE has to be right here and cannot be fixed later.
// topup only ever fills a shortfall — it never trims — so an oversized bank walks
// straight through production untouched and comes out as extra cards. The bank is
// the deck; there is no second chance to size it.
//
// WHEN IT IS DISCARDED. The owner's rule, asked and answered: "discarded and
// re-frozen on the next close". Reopening a collection throws the bank away, so
// a closed-edited-reclosed order freezes again with version + 1. Changing the
// seed pool on a closed order throws it away too — that is a production input,
// and a bank that no longer matches its inputs is worse than no bank, because it
// looks authoritative. An order with no bank falls back to exactly the old
// behaviour: topup at print time.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
// The freeze is a pure text pass over two files — no Chrome, no rendering. It is
// bounded anyway, because it runs inside an HTTP request the owner is waiting on.
const TIMEOUT_MS = Number(process.env.WORD_BANK_TIMEOUT_MS || 30000);

// The shape stored on the collection, minus its version — db.setWordBank stamps
// that, from a counter that OUTLIVES the bank. It has to: a reopen deletes the
// bank, so counting from the previous record would reset every re-freeze to 1
// and lose the one fact the number is there to carry — that this order has been
// approved before. `pool` is the seed pool the top-up was ASKED for (null = the
// theme's own), which is what makes a later pool change detectable as staleness.
// The dedup key topup.py uses (`_norm`): trimmed, inner whitespace collapsed,
// lowercased. Kept identical on purpose — the two have to agree about what "the
// same word" means or the boundary lands off by one.
const normWord = (w) =>
  String(w == null ? '' : w)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

// How many of `frozen`'s leading words came from `personal`.
function personalSpan(frozen, personal) {
  const mine = new Set((personal || []).map(normWord).filter(Boolean));
  let n = 0;
  while (n < frozen.length && mine.has(normWord(frozen[n]))) n += 1;
  return n;
}

function record({ words, theme, pool, personalCount, noTopup, deckWords }) {
  return {
    created_at: new Date().toISOString(),
    theme,
    pool: pool || null,
    // The deck this bank was SIZED FOR — db.deckWordsFor(collection), which is
    // 412 at the default four players and four fewer for every four beyond it.
    // Stored so the bank says what it is: a bank frozen for a 400-word deck and
    // a bank frozen for a 412-word one are different production inputs, and the
    // only way to tell them apart after the fact is to have written it down.
    deck_words: Number.isInteger(deckWords) && deckWords > 0 ? deckWords : null,
    // Whether this bank was frozen for an order that asked for NO filler. Stored
    // so the same drift check that catches a changed pool catches a buyer who
    // changed her mind about being filled at all (see isStale).
    no_topup: !!noTopup,
    personal_count: personalCount,
    words,
  };
}

/**
 * Run the real top-up and return the frozen bank, or null if it could not run.
 *
 * NULL IS A SUPPORTED ANSWER, not an error to throw at the owner. Freezing
 * happens inside "close the collection", and a close must not fail because
 * Python is missing on a dev box or a pool file is unreadable. Without a bank
 * production behaves exactly as it did before this module existed, so the cost
 * of a failed freeze is the old behaviour, not a broken order.
 */
function freeze({ personalWords, theme, pool, noTopup, python, deckWords }) {
  const words = (Array.isArray(personalWords) ? personalWords : [])
    .map((w) => String(w == null ? '' : w).trim())
    .filter(Boolean);
  if (!words.length || !theme) return null;
  const tmp = path.join(os.tmpdir(), 'dugri-freeze-' + crypto.randomUUID());
  const src = tmp + '-in.txt';
  const out = tmp + '-out.txt';
  try {
    fs.writeFileSync(src, words.join('\n') + '\n', 'utf8');
    const args = [path.join(REPO_ROOT, 'generator', 'topup.py'), src, theme, out];
    if (pool) args.push(pool);
    // A NO-FILL order still goes through topup.py, at target 0. It is the same
    // function answering "fill it to nothing", so her words come back deduped by
    // the one implementation of that rule and no pool is read — which is exactly
    // what this module refuses to reimplement in JavaScript for the ordinary
    // case, and has no more business reimplementing here.
    if (noTopup) args.push('--target=0');
    // HOW BIG THE DECK IS, said out loud. Without this the top-up ran to its own
    // module default (topup.TARGET = 412, the STANDARD deck's number) whatever
    // the collection asked for — so a 16-player order, whose deck holds 400 and
    // whose buyer was capped at 400, froze 412: her 400 plus twelve shop filler
    // words the cap had just told her she could not have. Production then dealt
    // 412 words into ceil(412/4) = 103 word cards ON TOP OF her four pawn cards
    // and printed 107 cards / 214 pages against a price, a box, a paper order and
    // a print run all pinned to 104.
    //
    // topup only ever fills a SHORTFALL, so the wrong target could not be caught
    // downstream: the oversized bank passed through order_to_pdf untouched. The
    // number has to be right HERE, at the one moment the list is decided.
    else if (Number.isInteger(deckWords) && deckWords > 0) args.push('--target=' + deckWords);
    const r = spawnSync(python || process.env.PYTHON_BIN || 'python3', args, {
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
    });
    if (r.error || r.status !== 0 || !fs.existsSync(out)) return null;
    const frozen = fs
      .readFileSync(out, 'utf8')
      .split('\n')
      .map((w) => w.trim())
      .filter(Boolean);
    if (!frozen.length) return null;
    return record({
      words: frozen,
      theme,
      pool,
      noTopup,
      // WHERE HER WORDS END in the frozen list — measured on the OUTPUT, not
      // taken from the input's length. topup dedupes (trimmed, inner whitespace
      // collapsed, lowercased) before it fills, so a list with two spellings of
      // one word yields fewer frozen entries than it had; counting the input
      // would push the boundary into the filler by exactly that many. Her words
      // come first and a pool word equal to one of hers is skipped as a
      // duplicate, so walking the prefix while it is still hers is exact.
      personalCount: personalSpan(frozen, words),
      deckWords,
    });
  } catch {
    return null;
  } finally {
    for (const f of [src, out]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort — a temp file we could not remove is not a failed order */
      }
    }
  }
}

/**
 * The words production must print for this collection.
 *
 * The frozen bank when there is one — that is the whole point of freezing it —
 * and the buyer's own words otherwise, which is what every order did before.
 * `personalWords` is passed in rather than read here so this module never needs
 * the store.
 */
/**
 * Where the buyer's OWN words end in the list production is about to print.
 *
 * This is the number the 'personal-first' card order splits on, and it cannot be
 * recovered downstream: a frozen bank arrives at the generator as one flat list
 * of 412, so the generator — which measures the boundary itself when it is handed
 * her raw words — measures 412 and splits nothing. Silently: the deck prints, it
 * just prints blended, which is exactly how the owner found it ("i try to say to
 * him first costumer words and then ours and it still comes the pdf not like
 * this").
 *
 * Null when there is nothing to say: no bank (the generator's own measurement is
 * right then), or a bank frozen before this was recorded.
 */
function personalCountForProduction(collection) {
  const bank = collection && collection.word_bank;
  if (!bank || !Array.isArray(bank.words) || !bank.words.length) return null;
  const n = Number(bank.personal_count);
  return Number.isInteger(n) && n > 0 && n < bank.words.length ? n : null;
}

function wordsForProduction(collection, personalWords) {
  const bank = collection && collection.word_bank;
  if (bank && Array.isArray(bank.words) && bank.words.length) return bank.words;
  return personalWords;
}

/**
 * Whether a stored bank still matches the inputs it was frozen from.
 *
 * Only the seed pool, the theme and whether she wanted filling AT ALL can drift
 * under it: the words themselves are frozen, and a change to those means a
 * reopen, which drops the bank outright.
 */
function isStale(collection) {
  const bank = collection && collection.word_bank;
  if (!bank) return false;
  const pool = collection.wordlist || null;
  const theme = collection.theme || null;
  if (!!bank.no_topup !== !!collection.no_topup) return true;
  // A bank frozen for a no-fill order holds no filler, so the pool it names is
  // not an input it was made from and cannot drift under it.
  if (bank.no_topup) return !!(theme && bank.theme !== theme);
  return (bank.pool || null) !== pool || (theme && bank.theme !== theme);
}

module.exports = {
  freeze,
  wordsForProduction,
  personalCountForProduction,
  isStale,
  personalSpan,
  TIMEOUT_MS,
};
