// Pure, dependency-free geometry helpers for cropping a tokenized card sheet
// down to a single representative card. Kept in their own module so they can be
// unit-tested without running the tokenizer's top-level file I/O.
//
// The key insight: each REAL card on the 8-up sheet is defined by a clipPath
// whose <path> is a PURE RECTANGLE — its coordinates contain only ~2 distinct
// x-values and ~2 distinct y-values (the card frame/border box). Decorations
// and rounded shapes have many distinct coordinates, so we exclude them.

// Parse a clipPath <path d="..."> coordinate string into an axis-aligned bbox
// plus a flag for whether it is a pure rectangle (<= 2 distinct rounded x AND
// <= 2 distinct rounded y values). Returns null if there aren't enough coords.
export function pathToBox(d) {
  const nums = (String(d).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
  if (nums.length < 4) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const xs = new Set();
  const ys = new Set();
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i];
    const y = nums[i + 1];
    xs.add(Math.round(x));
    ys.add(Math.round(y));
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const isRect = xs.size <= 2 && ys.size <= 2;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, isRect };
}

// Extract bbox + isRect for every clipPath <path> in an SVG source string.
export function clipPathBBoxes(src) {
  const boxes = [];
  const re = /<clipPath\b[^>]*>\s*<path\b[^>]*\bd="([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const box = pathToBox(m[1]);
    if (box) boxes.push(box);
  }
  return boxes;
}

// Given clip boxes and the sheet viewBox [w,h], return the single card box to
// crop to: the top-left member of the most-repeated group of pure-rectangle,
// card-sized boxes. Returns null if no pure-rect card boxes are found (callers
// then fall back to the old grid-cell behaviour).
export function pickCardBox(boxes, viewBoxW, viewBoxH) {
  const cards = boxes.filter(
    (b) => b.isRect && b.w > 80 && b.h > 120 && b.w < viewBoxW * 0.9 && b.h < viewBoxH * 0.95
  );
  if (!cards.length) return null;
  // The real cards are the most-repeated size; quantize and pick that group.
  const groups = new Map();
  for (const b of cards) {
    const key = `${Math.round(b.w / 6)}x${Math.round(b.h / 6)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const best = [...groups.values()].sort(
    (a, c) => c.length - a.length || c[0].w * c[0].h - a[0].w * a[0].h
  )[0];
  // Top-left card: smallest y, then smallest x.
  return best.slice().sort((a, c) => a.y - c.y || a.x - c.x)[0];
}
