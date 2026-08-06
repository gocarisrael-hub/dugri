// Structural validation of a downloaded PDF.
//
// WHY THIS EXISTS: the generator prints Chrome's output STRAIGHT to the final
// path — there is no temp-then-rename. So a Chrome that was killed (timeout,
// OOM, PID-ceiling) leaves a TRUNCATED file sitting at exactly the path the
// download route serves, and every "is the file there?" check passes while the
// customer gets a corrupt PDF. "Present" is not "valid"; this module is the
// difference.
//
// Pure: takes a Buffer, returns a verdict. Unit-tested in
// tests/unit/stress-pdfcheck.test.js.

// A PDF is complete when ALL of these hold:
//   1. it starts with the %PDF- header
//   2. its tail carries %%EOF (Chrome writes this LAST — a killed render has no
//      %%EOF, which is the single most reliable truncation signal we have)
//   3. `startxref` names a byte offset that is actually inside the file
//   4. that offset lands on a cross-reference table or an indirect object (an
//      xref STREAM, which is what Chrome emits) — not on garbage
const HEADER = Buffer.from('%PDF-');
const EOF = Buffer.from('%%EOF');

// How much of the tail to search. The trailer is tiny; 4 KiB is generous and
// keeps the check O(1) on a 200-page, multi-MB deck.
const TAIL = 4096;

function checkPdf(buf) {
  const out = {
    ok: false,
    bytes: buf ? buf.length : 0,
    header: false,
    eof: false,
    startxref: null,
    startxrefValid: false,
    pages: null,
    pagesSource: null,
    reason: null,
  };
  if (!buf || !buf.length) {
    out.reason = 'empty file';
    return out;
  }
  out.header = buf.subarray(0, HEADER.length).equals(HEADER);
  if (!out.header) {
    // A JSON error body served with a PDF content-type lands here — worth
    // quoting back, since that is what the admin UI would have tried to open.
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
  // Classic table, or an indirect object header introducing an xref stream.
  out.startxrefValid = /^\s*xref\b/.test(at) || /^\s*\d+\s+\d+\s+obj\b/.test(at);
  if (!out.startxrefValid) {
    out.reason = `startxref ${out.startxref} does not point at an xref table or object (${JSON.stringify(at.slice(0, 32))})`;
    return out;
  }

  const pages = countPages(buf);
  out.pages = pages.count;
  out.pagesSource = pages.source;
  out.ok = true;
  return out;
}

// Best-effort page count straight off the bytes.
//
// The authoritative number would need a full parser (page dicts can live inside
// compressed object streams). We do NOT need authoritative: the generate
// response already reports the page count the generator INTENDED, and this is
// the independent cross-check on the file that actually arrived. So we report a
// number AND how we got it, and the caller treats a null as "unknown", never as
// "zero pages".
function countPages(buf) {
  const text = buf.toString('latin1');
  // The page-tree root states /Count. Take the LARGEST such count: nested Pages
  // nodes each carry their own, and the root's is the total.
  let best = null;
  const counts = /\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/g;
  let m;
  while ((m = counts.exec(text)) !== null) {
    const n = Number(m[1]);
    if (best == null || n > best) best = n;
  }
  if (best != null) return { count: best, source: 'pages-count' };
  // Fall back to counting leaf page objects (/Type /Page not followed by 's').
  const leaves = text.match(/\/Type\s*\/Page(?![s\w])/g);
  if (leaves) return { count: leaves.length, source: 'page-objects' };
  return { count: null, source: 'unknown' };
}

// Is this actually the PRESS copy, or the ordinary home-print deck wearing its
// filename?
//
// WHY THIS IS SEPARATE: the two artifacts are byte-different but LOOK identical
// in a viewer, and the difference only shows up at the print shop — after the
// job is on press. The press pass (generator/press.py) stages Ghostscript's CMYK
// output in a temp dir and only moves it to the final path at the very end, so
// anything served from that path before the move is the un-converted RGB deck.
// A structural check alone happily passes it.
//
// Three properties only the finished press file has:
//   * /TrimBox on every page — where the card is cut out of the larger sheet.
//     press.py calls this "the part a shop's imposition software actually reads".
//   * /OutputIntents — the named ICC condition the CMYK was separated against.
//   * DeviceCMYK — Ghostscript's -sColorConversionStrategy=CMYK result. Chrome
//     emits DeviceRGB.
function checkPressPdf(buf) {
  const base = checkPdf(buf);
  const out = { ...base, trimBox: false, outputIntents: false, cmyk: false };
  if (!base.ok) return out;
  const text = buf.toString('latin1');
  out.trimBox = /\/TrimBox\b/.test(text);
  out.outputIntents = /\/OutputIntents\b/.test(text);
  out.cmyk = /\/DeviceCMYK\b/.test(text) || /\/DefaultCMYK\b/.test(text);
  const missing = [
    !out.trimBox && 'TrimBox (no statement of where to cut)',
    !out.outputIntents && 'OutputIntents (no ICC condition)',
    !out.cmyk && 'DeviceCMYK (still RGB)',
  ].filter(Boolean);
  if (missing.length) {
    out.ok = false;
    out.reason =
      'this is NOT a press copy — missing ' +
      missing.join(', ') +
      '. It is almost certainly the intermediate RGB deck, served before the ' +
      'Ghostscript pass finished.';
  }
  return out;
}

export { checkPdf, checkPressPdf, countPages };
