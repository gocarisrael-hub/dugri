// Agent A (Commerce): the box QR's picture.
//
// The QR on a box sticker (generator/pickup_stickers.py) is drawn HERE, in Node,
// and handed to the generator as finished SVG markup: the production image has no
// Python QR library and deliberately no pip layer (see generator/
// requirements-dev.txt), while the server already ships its own npm
// dependencies. qrcode-generator (Kazuhiko Arase, MIT, zero dependencies) is the
// encoder; this file only turns its module matrix into an SVG.
//
// The encoder is required INSIDE the function, for the same reason as every
// server module the tests reload: nothing heavier than node's own modules at the
// top level.

// Error correction M (~15% of the code can be lost and it still reads). A box
// gets handled, and a scuffed corner should not cost the buyer the code; H would
// grow the symbol for little gain on a sticker that is printed fresh.
const ECC = 'M';
// The quiet zone the standard asks for: four modules of white on every side.
// Without it a phone camera can lose the finder patterns against the artwork.
const QUIET = 4;

// The module matrix for `text`: { size, dark(r, c) }.
function matrixFor(text) {
  const qrcode = require('qrcode-generator');
  const qr = qrcode(0, ECC); // 0 = the smallest version that fits
  qr.addData(String(text));
  qr.make();
  const size = qr.getModuleCount();
  return { size, dark: (r, c) => qr.isDark(r, c) };
}

// The QR as a standalone SVG: black modules on white, one unit per module, the
// quiet zone included, so it scales to any printed size with crisp edges. Dark
// modules are merged into horizontal runs, which keeps the markup small (it is
// base64'd into the sticker page). Returns null for empty text.
function svgFor(text) {
  if (!text) return null;
  const { size, dark } = matrixFor(text);
  const total = size + QUIET * 2;
  let d = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!dark(r, c)) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < size && dark(r, c + run)) run++;
      d += 'M' + (c + QUIET) + ' ' + (r + QUIET) + 'h' + run + 'v1h-' + run + 'z';
      c += run;
    }
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    total +
    ' ' +
    total +
    '" shape-rendering="crispEdges">' +
    '<rect width="' +
    total +
    '" height="' +
    total +
    '" fill="#fff"/>' +
    '<path fill="#000" d="' +
    d +
    '"/></svg>'
  );
}

module.exports = { ECC, QUIET, matrixFor, svgFor };
