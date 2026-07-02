// Extract the disco-ball + heels bachelorette card (the top-left card of the
// Canva full-deck sheet — the exact art on the printed reference card) and
// strip its baked text, producing a decorations-only background SVG.
//
//   node poc/puppeteer/extract-card.mjs
//
// The sheet is an 8-up layout; each card is a top-level
//   <g transform="matrix(1, 0, 0, 1, X, Y)"> ... </g>
// The disco-ball+heels card sits at matrix(1,0,0,1, 9, 10).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC =
  '/Users/hadar/projects/alias/resources/canva/full deck/with backgrounf/דוגרי רווקות חדש/1.svg';
const OUT = join(__dirname, 'background.svg');

let src = readFileSync(SRC, 'utf8');

function matchG(str, idx) {
  let depth = 0;
  let i = idx;
  while (i < str.length) {
    if (str.startsWith('<g', i) && (str[i + 2] === ' ' || str[i + 2] === '>')) {
      depth++;
      i += 2;
    } else if (str.startsWith('</g>', i)) {
      depth--;
      i += 4;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  throw new Error('unbalanced');
}
// --- strip all baked text glyphs across the whole sheet (any fill) ---
// Each glyph is <g fill="..." fill-opacity="1"><g transform="translate(x,y)">...</g></g>.
const startRe = /<g fill="[^"]*" fill-opacity="1"><g transform="translate\(/g;
const removals = [];
let m;
while ((m = startRe.exec(src)) !== null) {
  const s = m.index;
  const e = matchG(src, s);
  removals.push([s, e]);
  startRe.lastIndex = e;
}
for (let k = removals.length - 1; k >= 0; k--) {
  src = src.slice(0, removals[k][0]) + src.slice(removals[k][1]);
}

// --- crop the root viewBox to the top-left card (its disco ball + heels) ---
// Sheet is an 8-up layout in a viewBox of 0 0 841.92 595.5; the top-left card
// occupies roughly x:9..201, y:10..287. Everything else falls outside the crop.
src = src.replace(/<svg\b[^>]*>/, (tag) => {
  return tag
    .replace(/\swidth="[^"]*"/, ' width="195"')
    .replace(/\sheight="[^"]*"/, ' height="281"')
    .replace(/\sviewBox="[^"]*"/, ' viewBox="7 8 195 281"');
});

writeFileSync(OUT, src);
console.log(`Stripped ${removals.length} glyph groups -> ${OUT}`);
