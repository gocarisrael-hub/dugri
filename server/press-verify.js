// Is the file we are about to publish actually the PRESS artifact?
//
// WHY THIS EXISTS. The press build is a two-stage pipeline: Chrome prints the
// deck onto the bigger press sheet (RGB, live text, no boxes), and only then
// does Ghostscript convert it to CMYK and pikepdf write the TrimBox and the
// OutputIntent. The two files LOOK identical in any viewer — same pages, same
// artwork — and the difference only shows at the print shop, after the job is
// on press. So "the file is there" and even "the file is a valid PDF" are both
// true of the WRONG artifact. This module is the difference.
//
// It gates the rename into the download path (server/index.js), so the press
// path can only ever hold a file that carries the properties a shop needs.
// A file that fails is kept aside for diagnosis and reported as a failure —
// never served.
//
// TWO MODES, ONE GATE. The colour half of the press pass is owner-switchable
// (settings press.cmyk_pass — our shop separates the colour itself), so the
// build has a PASS-THROUGH mode that skips Ghostscript and hands over the RGB
// deck with only the boxes written. That mode is checked by `checkPressPdf(buf,
// { cmyk: false })`, and the ONLY thing it relaxes is the two colour assertions:
//
//   still enforced   a complete, openable, non-truncated PDF; a TrimBox on
//                    EVERY page; room on the sheet for the crop marks.
//   relaxed          DeviceCMYK, and the OutputIntent that names which CMYK.
//   added            the file may not carry an OutputIntent while being RGB.
//                    That combination is the file lying about its own colour,
//                    which is worse than plain RGB: the shop's imposition
//                    software reads the tag, not the pixels.
//
// The mode is NOT sniffed from the file — that would make the check circular
// (an RGB file would "prove" it was meant to be RGB, and the intermediate-deck
// failure below would sail through). It is the mode the build was STARTED in,
// captured in the .building marker, so a mid-build flip of the switch cannot
// change what the finished file is measured against.
//
// The same contract is asserted from the outside by `checkPressPdf` in the
// stress harness (scripts/stress/pdfcheck.js, PR #342). Deliberately the same
// four properties; once that harness lands it should import THIS module rather
// than keep a second copy, and it gains the crop-mark check it does not have.
//
// Every threshold below was checked against a real Ghostscript+pikepdf press
// file and against the Chrome intermediate it is so easily confused with:
//
//                        finished press      Chrome intermediate
//   /TrimBox                one per page                       0
//   /OutputIntents                     1                       0
//   /DeviceCMYK                    >= 1                        0
//   /DeviceRGB                         0                      11
//   trim inset in the sheet     ~18.2pt      (no trim box at all)

// A PDF is structurally complete when all of these hold. Chrome writes the
// trailer LAST, so a killed render fails at (2) — which is the whole reason a
// truncated file has to be caught here rather than at the customer's end.
//   1. it starts with the %PDF- header
//   2. its tail carries %%EOF
//   3. `startxref` names a byte offset that is actually inside the file
//   4. that offset lands on a cross-reference table or an indirect object
const HEADER = Buffer.from('%PDF-');
const EOF = Buffer.from('%%EOF');
// The trailer is tiny; 4 KiB is generous and keeps the check O(1) on a
// 200-page, multi-MB deck.
const TAIL = 4096;

const PT_PER_MM = 72 / 25.4;
// generator/press.py MARK_MM: the crop marks start at the bleed edge and point
// outwards, so the sheet must be at least this much bigger than the trim on
// every side or there is nowhere for a mark to be drawn. Half a point of slack
// absorbs Chrome rounding @page to whole device units (it gave 93.81mm for a
// requested 94mm), which is also why press.py centres the boxes rather than
// trusting the ideal offsets.
const MARK_PT = 4 * PT_PER_MM;
const MARK_MIN_PT = MARK_PT - 0.5;

function checkPdf(buf) {
  const out = {
    ok: false,
    bytes: buf ? buf.length : 0,
    header: false,
    eof: false,
    startxref: null,
    startxrefValid: false,
    reason: null,
  };
  if (!buf || !buf.length) {
    out.reason = 'empty file';
    return out;
  }
  out.header = buf.subarray(0, HEADER.length).equals(HEADER);
  if (!out.header) {
    out.reason =
      'not a PDF (first bytes: ' + JSON.stringify(buf.subarray(0, 40).toString('latin1')) + ')';
    return out;
  }
  const tail = buf.subarray(Math.max(0, buf.length - TAIL));
  out.eof = tail.includes(EOF);
  if (!out.eof) {
    out.reason = 'truncated: no %%EOF in the last ' + TAIL + ' bytes';
    return out;
  }
  const tailText = tail.toString('latin1');
  const m = /startxref\s+(\d+)/g;
  let last = null;
  let hit;
  while ((hit = m.exec(tailText)) !== null) last = hit[1];
  if (last == null) {
    out.reason = 'no startxref in the trailer';
    return out;
  }
  out.startxref = Number(last);
  if (!(out.startxref > 0 && out.startxref < buf.length)) {
    out.reason = `startxref ${out.startxref} points outside a ${buf.length}-byte file`;
    return out;
  }
  const at = buf.subarray(out.startxref, out.startxref + 64).toString('latin1');
  out.startxrefValid = /^\s*xref\b/.test(at) || /^\s*\d+\s+\d+\s+obj\b/.test(at);
  if (!out.startxrefValid) {
    out.reason =
      `startxref ${out.startxref} does not point at an xref table or object ` +
      `(${JSON.stringify(at.slice(0, 32))})`;
    return out;
  }
  out.ok = true;
  return out;
}

// Every `/Name [ a b c d ]` rectangle in the file, as arrays of numbers.
//
// A byte scan is enough BECAUSE of what the press pass produces. Object streams
// arrived in PDF 1.5, and neither mode reaches it: Ghostscript runs at
// -dCompatibilityLevel=1.3, and a pass-through file is Chrome's own 1.4 (both
// measured on a real 208-page grapefruit deck, 208 of 208 MediaBoxes found in
// each). So page dictionaries are written in the clear. If either producer ever
// moves to 1.5+, these rectangles become invisible here and this scan has to
// change with it — a silent "0 of 208 pages", not a crash.
function rects(text, name) {
  const re = new RegExp('/' + name + '\\s*\\[([-\\d.eE\\s]+)\\]', 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const nums = m[1].trim().split(/\s+/).map(Number);
    if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) out.push(nums);
  }
  return out;
}

// The smallest gap between a trim box and the sheet it sits on, over all four
// sides — i.e. how much room the crop marks have. Null when we cannot pair a
// trim box with a media box.
function markGutter(media, trim) {
  if (!media.length || !trim.length) return null;
  let worst = Infinity;
  const n = Math.min(media.length, trim.length);
  for (let i = 0; i < n; i += 1) {
    const [mx0, my0, mx1, my1] = media[i];
    const [tx0, ty0, tx1, ty1] = trim[i];
    worst = Math.min(worst, tx0 - mx0, ty0 - my0, mx1 - tx1, my1 - ty1);
  }
  return worst === Infinity ? null : worst;
}

// The press verdict. Four properties, each of which a shop actually depends on:
//
//   * DeviceCMYK — separated inks. Chrome emits DeviceRGB; a shop handed RGB
//     either re-separates it (colours shift) or refuses the file.
//   * /OutputIntents — the named ICC condition the CMYK was separated against.
//     Without it "CMYK" does not say which CMYK.
//   * /TrimBox on every page — where the A7 card is cut out of the larger
//     sheet. This is what imposition software reads; drawn marks are for the
//     human. Its absence is why the shop had to ask in the first place.
//   * room for the crop marks — the sheet has to be bigger than the trim by at
//     least the mark length on every side, or the marks press.py draws fall
//     outside the page. The marks themselves live in a compressed content
//     stream; this geometry is the part that can be checked from the bytes, and
//     it is the part that fails when the sheet is not a press sheet at all.
//
// `opts.cmyk === false` selects the pass-through contract: the first two are the
// shop's job in that mode, so they are not required — everything else is, plus
// the rule that the file may not CLAIM the colour it does not have. See the
// header for why the mode is passed in rather than read off the file.
function checkPressPdf(buf, opts) {
  const wantCmyk = !(opts && opts.cmyk === false);
  const base = checkPdf(buf);
  const out = {
    ...base,
    mode: wantCmyk ? 'cmyk' : 'passthrough',
    trimBox: false,
    outputIntents: false,
    cmyk: false,
    marks: false,
    pages: null,
    gutterPt: null,
  };
  if (!base.ok) return out;
  const text = buf.toString('latin1');
  const media = rects(text, 'MediaBox');
  const trim = rects(text, 'TrimBox');
  out.pages = media.length || null;
  // Every page, not merely somewhere in the file: one page without a TrimBox is
  // one sheet the shop has to guess at.
  out.trimBox = trim.length > 0 && trim.length >= media.length;
  out.outputIntents = /\/OutputIntents\b/.test(text);
  out.cmyk = /\/DeviceCMYK\b/.test(text) || /\/DefaultCMYK\b/.test(text);
  out.gutterPt = markGutter(media, trim);
  out.marks = out.gutterPt != null && out.gutterPt >= MARK_MIN_PT;
  // The geometry half is required in BOTH modes. Skipping the colour pass was a
  // decision about colour; nothing about it changes where the card is cut, and
  // the TrimBox is the only thing in the file that states that.
  const missing = [
    wantCmyk && !out.cmyk && 'DeviceCMYK (still RGB)',
    wantCmyk && !out.outputIntents && 'OutputIntents (no ICC condition)',
    !out.trimBox &&
      `TrimBox on every page (no statement of where to cut: ${trim.length} of ${media.length} pages)`,
    !out.marks &&
      'room for the crop marks (' +
        (out.gutterPt == null
          ? 'the trim is not placed on a sheet at all'
          : `the trim sits ${out.gutterPt.toFixed(2)}pt inside the sheet, needs ` +
            `${MARK_PT.toFixed(2)}pt`) +
        ')',
  ].filter(Boolean);
  if (missing.length) {
    out.ok = false;
    out.reason = wantCmyk
      ? 'this is NOT a press copy — missing ' +
        missing.join(', ') +
        '. It is almost certainly the intermediate RGB deck, from before the ' +
        'Ghostscript pass finished.'
      : 'this is NOT a press copy (pass-through mode) — missing ' +
        missing.join(', ') +
        '. Pass-through drops the COLOUR pass only; the sheet still has to say ' +
        'where to cut, so this is a broken or half-rendered sheet rather than ' +
        'merely an unseparated one.';
    return out;
  }
  // Pass-through only: a file that declares an output intent it did not earn.
  // Left unchecked this would be the quietest failure of the lot — the shop
  // reads the declaration, separates nothing on the strength of it, and RGB goes
  // to plate as though it were already CMYK.
  if (!wantCmyk && out.outputIntents && !out.cmyk) {
    out.ok = false;
    out.reason =
      'this file claims an OutputIntent (a named CMYK condition) while carrying ' +
      'no CMYK at all. Pass-through hands the shop unseparated RGB and has to ' +
      'say so: a false colour declaration is read by imposition software and ' +
      'believed.';
  }
  return out;
}

// Verify a file on disk. Returns the same verdict, with a readable reason when
// the file cannot be read at all. `opts` passes straight through, so the
// caller's build mode decides which contract the file is held to.
function checkPressFile(file, opts) {
  let buf;
  try {
    buf = require('fs').readFileSync(file);
  } catch (e) {
    return { ok: false, bytes: 0, reason: 'could not read the built file: ' + (e.message || e) };
  }
  return checkPressPdf(buf, opts);
}

module.exports = { checkPdf, checkPressPdf, checkPressFile, MARK_PT };
