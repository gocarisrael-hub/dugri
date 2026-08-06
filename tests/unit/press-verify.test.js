// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pressPdf, rgbDeckPdf, truncate, pdf } from './press-pdf-fixture.js';

// The gate that decides whether a finished build may be published as the press
// copy. The failure it exists for is the one that looks fine: an openable,
// page-complete PDF that is the RGB deck, not the CMYK press sheet. Nobody
// notices until it is on press.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const verify = require(path.join(__dirname, '..', '..', 'server', 'press-verify.js'));

describe('press-verify: the finished artifact', () => {
  it('accepts a file carrying all four press properties', () => {
    const v = verify.checkPressPdf(pressPdf());
    expect(v.ok).toBe(true);
    expect(v).toMatchObject({ cmyk: true, outputIntents: true, trimBox: true, marks: true });
    expect(v.pages).toBe(3);
    expect(v.reason).toBe(null);
  });
});

describe('press-verify: the RGB deck wearing the press filename', () => {
  it('rejects it, and says which properties are missing', () => {
    const v = verify.checkPressPdf(rgbDeckPdf());
    // It is a structurally perfect PDF — that is the whole problem.
    expect(verify.checkPdf(rgbDeckPdf()).ok).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.cmyk).toBe(false);
    expect(v.outputIntents).toBe(false);
    expect(v.trimBox).toBe(false);
    expect(v.reason).toContain('NOT a press copy');
    expect(v.reason).toContain('DeviceCMYK');
    expect(v.reason).toContain('OutputIntents');
    expect(v.reason).toContain('TrimBox');
  });

  it('rejects a file where only SOME pages carry a TrimBox', () => {
    // One un-boxed sheet is one sheet the shop has to guess the cut on, so
    // "there is a TrimBox in the file somewhere" is not good enough.
    const half = verify.checkPressPdf(pdf({ pages: 4, trimBoxPages: 3 }));
    expect(half.pages).toBe(4);
    expect(half.trimBox).toBe(false);
    expect(half.ok).toBe(false);
    expect(half.reason).toContain('3 of 4 pages');
    expect(verify.checkPressPdf(pdf({ pages: 4 })).trimBox).toBe(true);
  });

  it('rejects CMYK with an intent but no room for the crop marks', () => {
    // A trim box that fills the sheet: the marks press.py draws would fall off
    // the page. Everything else about the file is right, which is exactly the
    // kind of near-miss a "does it exist" check waves through.
    const v = verify.checkPressPdf(pdf({ pages: 2, gutterPt: 1 }));
    expect(v.cmyk).toBe(true);
    expect(v.outputIntents).toBe(true);
    expect(v.trimBox).toBe(true);
    expect(v.marks).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('crop marks');
  });

  it('accepts a sheet with exactly the mark length of room', () => {
    // The zero-bleed case (press.py BLEED_MM = 0): the gutter is the mark and
    // nothing more, and that is still a legitimate press sheet.
    const v = verify.checkPressPdf(pdf({ pages: 2, gutterPt: verify.MARK_PT }));
    expect(v.marks).toBe(true);
    expect(v.ok).toBe(true);
  });
});

describe('press-verify: a build that was killed', () => {
  it('rejects a truncated file as truncated, not as "not a press copy"', () => {
    const v = verify.checkPressPdf(truncate(pressPdf()));
    expect(v.ok).toBe(false);
    expect(v.eof).toBe(false);
    expect(v.reason).toContain('truncated');
  });

  it('rejects an empty file and a JSON error body served as a PDF', () => {
    expect(verify.checkPressPdf(Buffer.alloc(0)).reason).toContain('empty');
    const notPdf = Buffer.from('{"error":"generation failed"}');
    expect(verify.checkPressPdf(notPdf).reason).toContain('not a PDF');
  });

  it('rejects a startxref pointing outside the file', () => {
    const buf = pressPdf();
    const broken = Buffer.from(
      buf.toString('latin1').replace(/startxref\n\d+/, 'startxref\n99999999'),
      'latin1'
    );
    const v = verify.checkPressPdf(broken);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('outside');
  });
});

describe('press-verify: reading from disk', () => {
  it('reports a missing file as a failure rather than throwing', () => {
    const v = verify.checkPressFile('/nonexistent/dugri/press.pdf');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('could not read');
  });
});
