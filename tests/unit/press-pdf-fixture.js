// Tiny but structurally REAL PDFs, for testing the press gate.
//
// The press defect is not "a broken file" — it is a perfectly good PDF that is
// the WRONG ONE. So a test double that is a broken file proves nothing: the
// fixtures here differ from each other exactly where the real artifacts differ,
// and nowhere else.
//
//   pressPdf()          what Ghostscript + pikepdf leave behind: DeviceCMYK, an
//                       OutputIntent, a TrimBox per page, and a sheet bigger
//                       than the trim so the crop marks have somewhere to go.
//   rgbDeckPdf()        what Chrome leaves at the same path minutes earlier:
//                       DeviceRGB, no boxes, no intent. Opens fine. Prints
//                       wrong.
//   truncate(buf)       what a killed Chrome leaves: a head with no trailer.
//
// Offsets are computed for real, so `startxref` lands on the xref table exactly
// as it does in a produced file.

// Page geometry from a real grapefruit press sheet (generator/press.py):
// 87.0 x 118.0mm around a 74 x 105mm trim, i.e. 18.22pt of bleed + crop-mark
// room on every side.
const MEDIA = [0, 0, 246.24, 334.08];
const TRIM = [18.23811, 18.221102, 228.00189, 315.858898];

function assemble(objects) {
  const header = '%PDF-1.3\n';
  let body = '';
  const offsets = [];
  for (const obj of objects) {
    offsets.push(header.length + body.length);
    body += obj + '\n';
  }
  const xrefAt = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` + `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(header + body + xref + trailer, 'latin1');
}

function page(n, { trimBox, cmyk, gutterPt }) {
  const media = gutterPt == null ? MEDIA : [0, 0, MEDIA[2], MEDIA[3]];
  const trim =
    gutterPt == null ? TRIM : [gutterPt, gutterPt, MEDIA[2] - gutterPt, MEDIA[3] - gutterPt];
  const parts = [
    `${n} 0 obj`,
    '<< /Type /Page /Parent 2 0 R',
    `/MediaBox [${media.join(' ')}]`,
    trimBox ? `/TrimBox [${trim.join(' ')}]` : '',
    `/Resources << /ColorSpace << /CS0 ${cmyk ? '/DeviceCMYK' : '/DeviceRGB'} >> >>`,
    '>>',
    'endobj',
  ];
  return parts.filter(Boolean).join('\n');
}

// `trimBoxPages` gives a file where only the first N pages carry a TrimBox —
// the half-boxed case, which is neither a clean press file nor an obvious
// reject.
function pdf({
  pages = 1,
  cmyk = true,
  outputIntents = true,
  trimBox = true,
  trimBoxPages = null,
  gutterPt,
} = {}) {
  const boxed = trimBox === false ? 0 : trimBoxPages == null ? pages : trimBoxPages;
  const kids = [];
  const pageObjs = [];
  for (let i = 0; i < pages; i += 1) {
    const n = 3 + i;
    kids.push(`${n} 0 R`);
    pageObjs.push(page(n, { trimBox: i < boxed, cmyk, gutterPt }));
  }
  const intents = outputIntents
    ? ' /OutputIntents [ << /Type /OutputIntent /S /GTS_PDFX' +
      ' /OutputConditionIdentifier (SWOP2006_Coated3v2) >> ]'
    : '';
  return assemble([
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R${intents} >>\nendobj`,
    `2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>\nendobj`,
    ...pageObjs,
  ]);
}

// The finished press copy.
const pressPdf = (opts) => pdf({ pages: 3, ...opts });

// The intermediate Chrome writes first, and the file the download route used to
// hand over when a poll landed mid-build.
const rgbDeckPdf = () => pdf({ pages: 3, cmyk: false, outputIntents: false, trimBox: false });

// What a killed render leaves: everything up to the point it died, so no
// trailer and no %%EOF.
const truncate = (buf) => buf.subarray(0, Math.floor(buf.length * 0.6));

export { pressPdf, rgbDeckPdf, truncate, pdf };
