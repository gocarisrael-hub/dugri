// Word-list generators for the production stress harness.
//
// A stress test that only varies the NUMBER of words is not a stress test — this
// project has been bitten repeatedly by WHICH glyphs are present (RTL shaping,
// final-form letters, Latin mixed into Hebrew, digits, punctuation, and words
// long enough to wrap onto three lines inside a fixed card box). So the harness
// varies word CONTENT as a first-class axis, through named profiles.
//
// Every generator returns EXACTLY `n` strings that are unique under the server's
// own dedupe rule (case/whitespace-insensitive, see db.norm) and each <= 80
// chars (db.addWords truncates past that, which would silently collapse two
// long words into one duplicate and shrink the deck under us).
//
// Pure functions, no I/O — unit-tested in tests/unit/stress-words.test.js.

// Server-side cap: db.addWords does .slice(0, 80) on every word.
const WORD_MAX = 80;

// A deterministic PRNG so a red run is reproducible from its seed alone. A
// stress failure you cannot replay is a rumour, not a bug report.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// Hebrew letters, deliberately INCLUDING the five final forms (ך ם ן ף ץ). Those
// only ever appear word-final in real text, and a font that lacks them renders
// tofu — so the harness plants them where real words put them.
const HE = 'אבגדהוזחטיכלמנסעפצקרשת'.split('');
const HE_FINAL = 'ךםןףץ'.split('');
const LAT = 'abcdefghijklmnopqrstuvwxyz'.split('');
const LAT_UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DIGITS = '0123456789'.split('');
// Punctuation that actually shows up in the owner's real lists: the Hebrew
// geresh/gershayim used for abbreviations, quotes, apostrophes, hyphens,
// parentheses, ampersands, slashes and the exclamation/question marks.
const PUNCT = ['"', "'", '־', '-', '(', ')', '!', '?', '.', ',', '&', '/', '״', '׳', '+', '#'];

function pick(r, arr) {
  return arr[Math.floor(r() * arr.length) % arr.length];
}

// One Hebrew token of `len` letters, final-form on the last letter some of the
// time (which is where a final form legally goes).
function heWord(r, len) {
  const out = [];
  for (let i = 0; i < len - 1; i += 1) out.push(pick(r, HE));
  out.push(r() < 0.35 ? pick(r, HE_FINAL) : pick(r, HE));
  return out.join('');
}

function latWord(r, len, upper) {
  const src = upper ? LAT_UP : LAT;
  let out = '';
  for (let i = 0; i < len; i += 1) out += pick(r, src);
  return out;
}

// Suffix a generated token with its index so uniqueness is guaranteed even when
// the random body collides — without changing the token's SHAPE (still the same
// script, still the same rough length). The index is rendered in the token's own
// script where one exists, so a "pure Hebrew" profile stays pure.
function unique(word, i, script) {
  const tag = script === 'he' ? toHebrewNumeral(i) : String(i);
  const joined = word + tag;
  return joined.length > WORD_MAX ? joined.slice(0, WORD_MAX) : joined;
}

// Render `i` using Hebrew letters (base-22) so a Hebrew-only profile never has
// Latin digits smuggled into it by the uniquifier.
function toHebrewNumeral(i) {
  let n = i;
  let out = '';
  do {
    out = HE[n % HE.length] + out;
    n = Math.floor(n / HE.length);
  } while (n > 0);
  return out;
}

// --- Profiles ---------------------------------------------------------------
// Each profile is (n, seed) -> string[] of length n.
const PROFILES = {
  // The bread-and-butter case: short Hebrew nouns, the shape of a real list.
  'short-he': (n, seed) => {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) => unique(heWord(r, 2 + Math.floor(r() * 4)), i, 'he'));
  },

  // Long Hebrew phrases that MUST wrap. The card box is fixed, so a word this
  // long is the auto-shrink / line-breaking path — where an overflow or an
  // infinite layout loop would live.
  'long-he': (n, seed) => {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) => {
      const parts = [];
      // 3-5 words of 6-11 letters => ~30-70 chars => two or three rendered lines.
      const count = 3 + Math.floor(r() * 3);
      for (let k = 0; k < count; k += 1) parts.push(heWord(r, 6 + Math.floor(r() * 6)));
      return unique(parts.join(' ') + ' ', i, 'he');
    });
  },

  // The pathological single token: one unbroken 80-char run with NO space to
  // break on. Nothing in the layout can wrap it; it must shrink or clip.
  'nowrap-he': (n, seed) => {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) => unique(heWord(r, 70), i, 'he').slice(0, WORD_MAX));
  },

  // Pure Latin — english-named themes, and the bidi-free control case.
  latin: (n, seed) => {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) =>
      unique(latWord(r, 3 + Math.floor(r() * 7)), i, 'lat')
    );
  },

  // The real-world nightmare: Hebrew and Latin in ONE token, plus digits. This is
  // bidirectional text inside a single run — the case where RTL reordering, not
  // font coverage, is what breaks.
  mixed: (n, seed) => {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) => {
      const he = heWord(r, 2 + Math.floor(r() * 4));
      const lat = latWord(r, 2 + Math.floor(r() * 5), r() < 0.5);
      const num = Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(r, DIGITS)).join('');
      const forms = [
        `${he} ${lat}`,
        `${lat} ${he}`,
        `${he}${lat}`,
        `${he} ${num}`,
        `${num} ${he}`,
        `${he} ${lat} ${num}`,
      ];
      return unique(pick(r, forms) + ' ', i, 'lat');
    });
  },

  // Punctuation-heavy, including the Hebrew geresh/gershayim and paired brackets.
  // Quotes and apostrophes are also the classic HTML-escaping bug: the generator
  // builds an HTML document and prints it with Chrome, so an unescaped " can
  // break out of an attribute and silently mangle the page.
  punct: (n, seed) => {
    const r = rng(seed);
    return Array.from({ length: n }, (_, i) => {
      const he = heWord(r, 3 + Math.floor(r() * 4));
      const p1 = pick(r, PUNCT);
      const p2 = pick(r, PUNCT);
      return unique(`${p1}${he}${p2} `, i, 'he');
    });
  },

  // HTML/JS metacharacters on purpose. If any of these reach the rendered card as
  // markup rather than text, the deck is silently wrong (or empty) rather than
  // loudly broken — the worst failure mode there is.
  inject: (n, seed) => {
    const r = rng(seed);
    const shapes = [
      '<b>{}</b>',
      '<script>x</script>{}',
      '{} & co',
      '{} <img src=x onerror=1>',
      '"{}"',
      "'{}'",
      '{}</div>',
      '{} {{}}',
      '{} \\n',
      '{} %s',
    ];
    return Array.from({ length: n }, (_, i) => {
      const he = heWord(r, 3 + Math.floor(r() * 3));
      return unique(pick(r, shapes).replace('{}', he) + ' ', i, 'he');
    });
  },

  // Everything at once, in the proportions a messy real list actually has.
  realistic: (n, seed) => {
    const r = rng(seed);
    const mk = [
      () => heWord(r, 2 + Math.floor(r() * 4)),
      () => heWord(r, 6 + Math.floor(r() * 5)),
      () => `${heWord(r, 4)} ${heWord(r, 5)}`,
      () => `${heWord(r, 3)} ${heWord(r, 4)} ${heWord(r, 6)}`,
      () => latWord(r, 4 + Math.floor(r() * 5), r() < 0.3),
      () => `${heWord(r, 4)} ${latWord(r, 4, false)}`,
      () => `${heWord(r, 5)} ${Math.floor(r() * 100)}`,
      () => `${pick(r, PUNCT)}${heWord(r, 5)}${pick(r, PUNCT)}`,
      () => heWord(r, 20 + Math.floor(r() * 25)),
    ];
    return Array.from({ length: n }, (_, i) => unique(pick(r, mk)() + ' ', i, 'he'));
  },
};

const PROFILE_NAMES = Object.keys(PROFILES);

// Build `n` unique words for a profile. Throws on an unknown profile rather than
// silently producing a different test than the results table claims.
function buildWords(profile, n, seed = 42) {
  const fn = PROFILES[profile];
  if (!fn) throw new Error(`unknown word profile: ${profile} (have: ${PROFILE_NAMES.join(', ')})`);
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad word count: ${n}`);
  const words = fn(n, seed).map((w) => String(w).trim().replace(/\s+/g, ' ').slice(0, WORD_MAX));
  // Assert the contract the caller relies on: the server dedupes, so a profile
  // that emits a collision would quietly under-fill the deck and make the run a
  // test of a DIFFERENT word count than the one in the results table.
  const seen = new Set(words.map((w) => w.trim().toLowerCase()));
  if (seen.size !== words.length) {
    throw new Error(
      `profile ${profile} produced ${words.length - seen.size} duplicate(s) at n=${n}`
    );
  }
  return words;
}

export { buildWords, PROFILES, PROFILE_NAMES, WORD_MAX, rng };
