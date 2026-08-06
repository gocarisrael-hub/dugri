// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildWords, PROFILE_NAMES, WORD_MAX } from '../../scripts/stress/words.js';
import { checkPdf } from '../../scripts/stress/pdfcheck.js';

// The stress harness (scripts/stress/) is only as trustworthy as its two pure
// parts: the word generators that decide WHAT gets rendered, and the PDF
// validator that decides whether the artifact that came back is real. A bug in
// either turns a red into a false alarm — or, far worse, a broken deck into a
// green row. So both are pinned here.

describe('stress word profiles', () => {
  for (const profile of PROFILE_NAMES) {
    it(`${profile}: emits exactly n words, unique under the server's dedupe rule`, () => {
      for (const n of [1, 2, 70, 224, 416, 1600]) {
        const words = buildWords(profile, n, 42);
        expect(words).toHaveLength(n);
        // db.addWords dedupes case/whitespace-insensitively. A collision would
        // silently shrink the deck and make the run test a DIFFERENT word count
        // than the results table claims.
        const norm = new Set(words.map((w) => w.trim().toLowerCase()));
        expect(norm.size, `${profile} @ n=${n} produced duplicates`).toBe(n);
      }
    });

    it(`${profile}: never exceeds the server's 80-char word cap`, () => {
      // Past 80 the server truncates, which can turn two distinct long words
      // into the same stored word — the same silent shrink by another route.
      for (const w of buildWords(profile, 500, 7)) {
        expect(w.length).toBeLessThanOrEqual(WORD_MAX);
        // The server also trims and collapses inner whitespace before storing;
        // a word that changes shape on the way in is not the word we tested.
        expect(w).toBe(w.trim().replace(/\s+/g, ' '));
      }
    });
  }

  it('is deterministic — the same seed replays the same list', () => {
    expect(buildWords('realistic', 50, 99)).toEqual(buildWords('realistic', 50, 99));
    expect(buildWords('realistic', 50, 99)).not.toEqual(buildWords('realistic', 50, 100));
  });

  it('plants Hebrew final forms, Latin, digits and punctuation where claimed', () => {
    const he = buildWords('short-he', 300, 3).join(' ');
    expect(/[ךםןףץ]/.test(he)).toBe(true);
    expect(/[A-Za-z]/.test(he)).toBe(false); // a "pure Hebrew" profile must stay pure

    const mixed = buildWords('mixed', 300, 3).join(' ');
    expect(/[֐-׿]/.test(mixed)).toBe(true);
    expect(/[A-Za-z]/.test(mixed)).toBe(true);
    expect(/\d/.test(mixed)).toBe(true);

    const punct = buildWords('punct', 200, 3).join(' ');
    expect(/["'׳״()!?&/]/.test(punct)).toBe(true);

    // The wrapping profiles must actually be long enough to wrap.
    expect(Math.max(...buildWords('long-he', 200, 3).map((w) => w.length))).toBeGreaterThan(28);
    // ...and nowrap must have NO space to break on.
    expect(buildWords('nowrap-he', 50, 3).every((w) => !w.includes(' '))).toBe(true);
  });

  it('rejects an unknown profile instead of silently testing something else', () => {
    expect(() => buildWords('nope', 10)).toThrow(/unknown word profile/);
  });
});

describe('stress PDF validator', () => {
  // A minimal but STRUCTURALLY COMPLETE PDF, built the way the checker reads it.
  function makePdf({ pages = 2, truncate = 0, badOffset = false } = {}) {
    const body =
      `%PDF-1.7\n` +
      `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [] >>\nendobj\n`;
    const offset = badOffset ? 999999 : body.indexOf('2 0 obj');
    const tail = `trailer\n<< /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
    const buf = Buffer.from(body + tail, 'latin1');
    return truncate ? buf.subarray(0, buf.length - truncate) : buf;
  }

  it('accepts a complete PDF and reads its page count', () => {
    const v = checkPdf(makePdf({ pages: 208 }));
    expect(v.ok).toBe(true);
    expect(v.pages).toBe(208);
    expect(v.eof).toBe(true);
  });

  it('CATCHES the truncated file a killed Chrome leaves at the final path', () => {
    // This is the whole reason the validator exists: the generator prints
    // straight to the destination with no temp-then-rename, so a killed render
    // leaves a real, openable-looking file exactly where a good one would be.
    const v = checkPdf(makePdf({ truncate: 20 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/truncated|%%EOF/);
  });

  it('rejects an empty file', () => {
    expect(checkPdf(Buffer.alloc(0)).reason).toMatch(/empty/);
  });

  it('rejects a JSON error body served as a PDF', () => {
    const v = checkPdf(Buffer.from('{"error":"no pdf"}'));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not a PDF/);
  });

  it('rejects a startxref that points outside the file', () => {
    const v = checkPdf(makePdf({ badOffset: true }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/outside/);
  });
});
