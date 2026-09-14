// pawn-print.js — a buyer's pawn, drawn in the browser the way the printer draws it.
//
// WHY THIS EXISTS. The same photo used to be drawn three ways: by the generator
// (build.square_photo + the photo card's SVG sticker), and by two approximations
// of it on the site — CSS percentages, a stack of white drop-shadows for the
// sticker edge, and a framing measured on a 200 px thumbnail. They agreed to a
// couple of percent, which is exactly enough for a buyer to see the difference
// between the card she approved and the card she was sent.
//
// So this does not approximate the printer; it repeats it:
//
//   * THE CROP is build.square_photo's, number for number — the same subject
//     box (on the full-resolution alpha), the same blob choice and bystander
//     erase, the same reach, the same window, the same buyer adjustment, with
//     Python's own rounding (half to even) and Pillow's own BILINEAR resampling
//     wherever the generator resamples a mask. tests/unit/pawn-print.test.js
//     holds it to the generator's answers on committed fixtures.
//   * THE STICKER is the photo card's own markup: the image clipped to the same
//     disc, and a <use> of it through the THEME'S OWN `#sticker-halo` filter,
//     which the server hands over with the blank card. Chrome renders the print
//     from that very filter, so the white edge and its shadow are not imitated.
//   * THE CARD underneath is the generator's render (paper, cut-line, the Dugri
//     pawns in the slots she has not filled), so nothing about it is redrawn here.
//
// Everything the generator does is repeated except resizing the square to 512 px
// before it is placed: the browser scales the source straight into the slot. That
// is a resampling difference, not a geometry one.

// build.PHOTO_* — every constant the crop depends on, under the generator's names.
export const ALPHA_MIN = 24;
export const SUBJECT_MIN_COVER = 0.005;
export const SUBJECT_MAX_COVER = 0.995;
export const BLOB_MIN_SHARE = 0.08;
export const BLOB_MASK_PX = 200;
export const REACH_SLACK = 1.0;
export const SUBJECT_Y = 0.3;
export const DISC_FILL = 0.9;

/** Python 3's round(): halves go to the even neighbour, not up. */
export function pyRound(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// ---- Pillow's BILINEAR resize, for single-channel 8-bit images ----------------
//
// Pillow (libImaging/Resample.c) is a separable convolution whose triangle
// filter WIDENS with the reduction, so a downscale averages every source pixel
// under the output pixel rather than sampling two of them. A canvas does not do
// that, and the generator thresholds the result, so a canvas-resized mask draws
// a different blob edge. Ported with its fixed-point arithmetic.

const PRECISION_BITS = 32 - 8 - 2;
const PRECISION_ONE = 2 ** PRECISION_BITS;

function coeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1);
  const support = filterscale; // the bilinear filter's support is 1.0
  const ss = 1 / filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const pre = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      let w = Math.abs((x + xmin - center + 0.5) * ss);
      w = w < 1 ? 1 - w : 0;
      pre[x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) {
      const k = ww !== 0 ? pre[x] / ww : pre[x];
      kk[xx * ksize + x] = Math.trunc(k < 0 ? -0.5 + k * PRECISION_ONE : 0.5 + k * PRECISION_ONE);
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, kk };
}

const clip8 = (ss) => {
  const v = Math.floor(ss / PRECISION_ONE);
  return v < 0 ? 0 : v > 255 ? 255 : v;
};

/** `src` (w x h, one byte per pixel) resized to W x H exactly as Pillow's BILINEAR. */
export function resizeBilinearL(src, w, h, W, H) {
  let cur = src;
  if (W !== w) {
    const { ksize, bounds, kk } = coeffs(w, W);
    const out = new Uint8Array(W * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let xx = 0; xx < W; xx++) {
        const xmin = bounds[xx * 2];
        const xmax = bounds[xx * 2 + 1];
        let ss = PRECISION_ONE / 2;
        for (let x = 0; x < xmax; x++) ss += cur[row + xmin + x] * kk[xx * ksize + x];
        out[y * W + xx] = clip8(ss);
      }
    }
    cur = out;
  }
  if (H !== h) {
    const { ksize, bounds, kk } = coeffs(h, H);
    const out = new Uint8Array(W * H);
    for (let yy = 0; yy < H; yy++) {
      const ymin = bounds[yy * 2];
      const ymax = bounds[yy * 2 + 1];
      for (let x = 0; x < W; x++) {
        let ss = PRECISION_ONE / 2;
        for (let y = 0; y < ymax; y++) ss += cur[(y + ymin) * W + x] * kk[yy * ksize + y];
        out[yy * W + x] = clip8(ss);
      }
    }
    cur = out;
  }
  return cur === src ? src.slice() : cur;
}

const threshold = (px, at) => {
  const out = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i++) out[i] = px[i] >= at ? 255 : 0;
  return out;
};

/** ImageFilter.MaxFilter(size) — Pillow pads the edges by repeating them. */
function maxFilter(px, w, h, size) {
  const m = size >> 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = 0;
      for (let dy = -m; dy <= m && best < 255; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy)) * w;
        for (let dx = -m; dx <= m; dx++) {
          const v = px[yy + Math.min(w - 1, Math.max(0, x + dx))];
          if (v > best) best = v;
        }
      }
      out[y * w + x] = best;
    }
  }
  return out;
}

/** Image.getbbox() of a mask inside `win` ([l, t, r, b]), or null. */
function bbox(px, w, win) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = win[1]; y < win[3]; y++) {
    for (let x = win[0]; x < win[2]; x++) {
      if (!px[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/** build._blobs: the 8-connected blobs of a mask, biggest first. */
function blobs(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const at = y0 * w + x0;
      if (!mask[at] || seen[at]) continue;
      seen[at] = 1;
      stack.length = 0;
      stack.push(at);
      let n = 0;
      let sx = 0;
      let sy = 0;
      let left = x0;
      let right = x0;
      let top = y0;
      let bottom = y0;
      while (stack.length) {
        const i = stack.pop();
        const x = i % w;
        const y = (i - x) / w;
        n++;
        sx += x;
        sy += y;
        if (x < left) left = x;
        else if (x > right) right = x;
        if (y < top) top = y;
        else if (y > bottom) bottom = y;
        for (let ny = Math.max(0, y - 1); ny < Math.min(h, y + 2); ny++) {
          for (let nx = Math.max(0, x - 1); nx < Math.min(w, x + 2); nx++) {
            const j = ny * w + nx;
            if (mask[j] && !seen[j]) {
              seen[j] = 1;
              stack.push(j);
            }
          }
        }
      }
      out.push({ n, box: [left, top, right + 1, bottom + 1], cx: sx / n, cy: sy / n, x0, y0 });
    }
  }
  // Array.prototype.sort is stable, as Python's sorted() is — equal-sized blobs
  // keep their scan order on both sides.
  out.sort((a, b) => b.n - a.n);
  return out;
}

/**
 * build.subject_box on raw RGBA: `{ box, alpha, erased }` or null.
 *
 * `alpha` is the image's alpha with every blob but the subject erased; `erased`
 * says whether that changed anything, so a caller can skip re-encoding a photo
 * that came through untouched.
 */
export function subjectBox(rgba, w, h) {
  const n = w * h;
  const alpha = new Uint8Array(n);
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    alpha[i] = a;
    if (a < lo) lo = a;
    if (a > hi) hi = a;
  }
  if (hi < ALPHA_MIN || lo >= ALPHA_MIN) return null;
  let solid = threshold(alpha, ALPHA_MIN);
  let box = bbox(solid, w, [0, 0, w, h]);
  if (!box) return null;
  let opaque = 0;
  for (let i = 0; i < n; i++) if (solid[i]) opaque++;
  const cover = opaque / n;
  if (!(SUBJECT_MIN_COVER <= cover && cover <= SUBJECT_MAX_COVER)) return null;

  const scale = BLOB_MASK_PX / Math.max(w, h);
  let sw = w;
  let sh = h;
  let small = solid;
  if (scale < 1) {
    sw = Math.max(1, pyRound(w * scale));
    sh = Math.max(1, pyRound(h * scale));
    small = threshold(resizeBilinearL(solid, w, h, sw, sh), 128);
  }
  const found = blobs(small, sw, sh);
  if (!found.length) return null;
  let pick = found[0];
  let erased = false;
  if (found.length > 1) {
    const biggest = found[0].n;
    let real = found.filter((b) => b.n >= BLOB_MIN_SHARE * biggest);
    if (!real.length) real = found.slice(0, 1);
    const cx = sw / 2;
    const cy = sh / 2;
    let best = Infinity;
    for (const b of real) {
      const d = (b.cx - cx) ** 2 + (b.cy - cy) ** 2;
      if (d < best) {
        best = d;
        pick = b;
      }
    }
    // Re-walk the chosen blob, then dilate and blow the keep-mask back up — the
    // generator's own order of operations, thresholds and all.
    let keep = new Uint8Array(sw * sh);
    const seen = new Uint8Array(sw * sh);
    const stack = [[pick.x0, pick.y0]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
      const at = y * sw + x;
      if (seen[at] || !small[at]) continue;
      seen[at] = 1;
      keep[at] = 255;
      for (let ny = Math.max(0, y - 1); ny < Math.min(sh, y + 2); ny++) {
        for (let nx = Math.max(0, x - 1); nx < Math.min(sw, x + 2); nx++) {
          if (small[ny * sw + nx] && !seen[ny * sw + nx]) stack.push([nx, ny]);
        }
      }
    }
    keep = maxFilter(keep, sw, sh, 5);
    if (sw !== w || sh !== h) keep = threshold(resizeBilinearL(keep, sw, sh, w, h), 96);
    for (let i = 0; i < n; i++) {
      if (!keep[i] && alpha[i]) {
        alpha[i] = 0;
        erased = true;
      }
    }
    solid = threshold(alpha, ALPHA_MIN);
  }

  // The blob's box is only as precise as the small mask; re-measure the full
  // alpha inside a generous window around it.
  let win = pick.box;
  if (scale < 1) {
    const pad = pyRound(2 / scale);
    const [bl, bt, br, bb] = pick.box;
    win = [
      Math.max(0, Math.trunc(bl / scale) - pad),
      Math.max(0, Math.trunc(bt / scale) - pad),
      Math.min(w, Math.trunc(br / scale) + pad),
      Math.min(h, Math.trunc(bb / scale) + pad),
    ];
  }
  const tight = bbox(solid, w, win);
  if (tight) box = tight;
  if (box[2] <= box[0] || box[3] <= box[1]) return null;
  return { box, alpha, erased };
}

/** build.subject_reach, measured off the (erased) alpha. */
export function subjectReach(box, alpha, w, h) {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const corner = Math.hypot(box[2] - box[0], box[3] - box[1]) / 2;
  if (!alpha) return corner;
  let scale = Math.min(1, BLOB_MASK_PX / (Math.max(w, h) || 1));
  let small = alpha;
  let sw = w;
  let sh = h;
  if (scale < 1) {
    sw = Math.max(1, Math.trunc(w * scale));
    sh = Math.max(1, Math.trunc(h * scale));
    small = resizeBilinearL(alpha, w, h, sw, sh);
  } else {
    scale = 1;
  }
  let best = 0;
  for (let y = 0; y < sh; y++) {
    let first = -1;
    let last = -1;
    for (let x = 0; x < sw; x++) {
      if (small[y * sw + x] >= ALPHA_MIN) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    const sy = (y + 0.5) / scale;
    for (const x of [first, last]) {
      best = Math.max(best, Math.hypot((x + 0.5) / scale - cx, sy - cy));
    }
  }
  if (best <= 0) return corner;
  return Math.min(best + REACH_SLACK / scale, corner);
}

/** build.subject_window: the source square whose disc holds the whole subject. */
export function subjectWindow(box, alpha, w, h) {
  const side = (2 * subjectReach(box, alpha, w, h)) / DISC_FILL;
  const left = (box[0] + box[2]) / 2 - side / 2;
  const top = (box[1] + box[3]) / 2 - side / 2;
  return [pyRound(left), pyRound(top), pyRound(left + side), pyRound(top + side)];
}

/** square_photo's crop when there is no silhouette to frame by. */
export function plainCrop(w, h) {
  const side = Math.min(w, h);
  if (h > w) {
    let top = pyRound(SUBJECT_Y * h - side / 2);
    top = Math.max(0, Math.min(top, h - side));
    return [0, top, side, top + side];
  }
  const left = Math.floor((w - side) / 2);
  return [left, 0, left + side, side];
}

/** build.apply_photo_view: the crop moved and scaled the way the buyer placed it. */
export function viewCrop(crop, view) {
  if (!view) return crop;
  const side = crop[2] - crop[0];
  const next = side / view.zoom;
  const cx = (crop[0] + crop[2]) / 2 + view.dx * side;
  const cy = (crop[1] + crop[3]) / 2 + view.dy * side;
  return [
    pyRound(cx - next / 2),
    pyRound(cy - next / 2),
    pyRound(cx + next / 2),
    pyRound(cy + next / 2),
  ];
}

/**
 * The automatic crop for a photo's pixels — square_photo's fork, in one call.
 * `cutout` is the same flag the generator is handed (`--photo-original` is its
 * negation): an original is never measured for a silhouette, even when it has one.
 */
export function autoCrop(rgba, w, h, cutout) {
  const found = cutout ? subjectBox(rgba, w, h) : null;
  if (!found) return { crop: plainCrop(w, h), alpha: null, erased: false };
  return {
    crop: subjectWindow(found.box, found.alpha, w, h),
    alpha: found.alpha,
    erased: found.erased,
  };
}

// ---- the sticker, as the photo card draws it ----------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const num = (v) => String(Math.round(v * 1e4) / 1e4);

/** The nested viewBox that maps `crop` onto the slot square. */
export function cropViewBox(crop) {
  return `${crop[0]} ${crop[1]} ${crop[2] - crop[0]} ${crop[3] - crop[1]}`;
}

/**
 * One slot's sticker, in card units, as SVG markup: the disc the generator
 * multiplies into the photo's alpha, the halo `<use>` BEHIND the photo through
 * the theme's filter, and the photo mapped onto the slot by its crop.
 *
 * `id` must be unique in the document; `slot` is `{ x, y, w, h }` in the card's
 * own viewBox units; `photo` is `{ href, width, height }`; `crop` is the square
 * window of the source (see viewCrop).
 */
export function stickerMarkup({ id, slot, photo, crop, filterId }) {
  const r = (slot.w * DISC_FILL) / 2;
  const cx = slot.x + slot.w / 2;
  const cy = slot.y + slot.h / 2;
  return (
    `<mask id="${id}-disc" maskUnits="userSpaceOnUse" x="${num(slot.x)}" y="${num(slot.y)}"` +
    ` width="${num(slot.w)}" height="${num(slot.h)}">` +
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="#fff"/></mask>` +
    `<use href="#${id}" filter="url(#${filterId})"/>` +
    `<g id="${id}" mask="url(#${id}-disc)">` +
    `<svg data-pawn-crop x="${num(slot.x)}" y="${num(slot.y)}" width="${num(slot.w)}"` +
    ` height="${num(slot.h)}" viewBox="${cropViewBox(crop)}" preserveAspectRatio="none">` +
    `<image href="${esc(photo.href)}" width="${photo.width}" height="${photo.height}"/>` +
    `</svg></g>`
  );
}

/**
 * The theme's `<filter id="sticker-halo">` under a document-unique id. Two cards
 * on one page each carry a copy, and duplicate ids resolve to whichever came
 * first — harmless for identical filters, but not something to lean on.
 */
export function haloFilterMarkup(filter, id) {
  return String(filter || '').replace(/\bid="sticker-halo"/, `id="${id}"`);
}

/** A slot rect as fractions of the card (preview.pawn_slots) in viewBox units. */
export function slotRect(frac, viewBox) {
  const [vx, vy, vw, vh] = viewBox;
  return { x: vx + frac.x * vw, y: vy + frac.y * vh, w: frac.w * vw, h: frac.h * vh };
}

// ---- painting it into the page ------------------------------------------------
//
// Both pages draw through these, so there is one way a pawn reaches the screen.
// A drag repaints on every pointer move: when the photo has not changed, only the
// crop's viewBox attribute is touched, and nothing is parsed or decoded.

/**
 * One sticker into `g` (an SVG <g>): `photo` null empties it. Rebuilt only when
 * the photo or the slot changes; a new crop is a single attribute.
 */
export function paintSticker(g, { id, slot, photo, crop, filterId }) {
  if (!g) return;
  if (!photo) {
    if (g.__pawnKey) g.innerHTML = '';
    g.__pawnKey = null;
    return;
  }
  const key = [photo.href, id, filterId, slot.x, slot.y, slot.w, slot.h].join('|');
  const inner = g.__pawnKey === key && g.querySelector('svg[data-pawn-crop]');
  if (inner) {
    inner.setAttribute('viewBox', cropViewBox(crop));
    return;
  }
  g.innerHTML = stickerMarkup({ id, slot, photo, crop, filterId });
  g.__pawnKey = key;
}

/**
 * A whole card's photos over the generator's picture of it. `svg` sits exactly
 * on that picture; `stickers[i]` is `{ photo, crop, src }` or null for slot i,
 * and gets a `<g class="pawn-live-slot">` whether or not its photo has decoded
 * yet. `src` (the file that prints) is stamped on the group as `data-src`.
 */
export function paintCard(svg, { spec, slots, idPrefix, stickers }) {
  if (!svg || !spec) return;
  const filterId = idPrefix + '-halo';
  const shell = spec.viewBox.join(' ') + '|' + (spec.filter || '');
  if (svg.__pawnShell !== shell) {
    svg.setAttribute('viewBox', spec.viewBox.map(num).join(' '));
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = `<defs>${haloFilterMarkup(spec.filter, filterId)}</defs>`;
    svg.__pawnShell = shell;
  }
  let groups = svg.querySelectorAll('g.pawn-live-slot');
  while (groups.length > stickers.length)
    (groups[groups.length - 1].remove(), (groups = svg.querySelectorAll('g.pawn-live-slot')));
  while (groups.length < stickers.length) {
    svg.insertAdjacentHTML('beforeend', '<g class="pawn-live-slot"></g>');
    groups = svg.querySelectorAll('g.pawn-live-slot');
  }
  stickers.forEach((s, i) => {
    const slot = slotRect(slots[i], spec.viewBox);
    if (s && s.src) groups[i].setAttribute('data-src', s.src);
    else groups[i].removeAttribute('data-src');
    paintSticker(groups[i], {
      id: `${idPrefix}-s${i}`,
      slot,
      photo: s && s.photo,
      crop: s && s.crop,
      filterId,
    });
  });
}

/**
 * One slot as a tile: the generator's card cropped to the slot (plus `margin`
 * card units of paper, so the cut-line and its shadow show whole) with the
 * sticker on it. `base` is the card picture; without it the tile is the sticker
 * alone until it arrives. `src`, the file that prints, is stamped as `data-src`.
 */
export function paintTile(svg, { spec, base, slot, margin = 3, id, photo, crop, src }) {
  if (!svg || !spec) return;
  if (src) svg.setAttribute('data-src', src);
  else svg.removeAttribute('data-src');
  const filterId = id + '-halo';
  const vb = [slot.x - margin, slot.y - margin, slot.w + 2 * margin, slot.h + 2 * margin];
  const shell = vb.join(' ') + '|' + (spec.filter || '') + '|' + (base || '').length + '|' + id;
  if (svg.__pawnShell !== shell || svg.__pawnBase !== base) {
    const [vx, vy, vw, vh] = spec.viewBox;
    svg.setAttribute('viewBox', vb.map(num).join(' '));
    svg.innerHTML =
      `<defs>${haloFilterMarkup(spec.filter, filterId)}</defs>` +
      (base
        ? `<image href="${esc(base)}" x="${num(vx)}" y="${num(vy)}" width="${num(vw)}"` +
          ` height="${num(vh)}" preserveAspectRatio="none"/>`
        : '') +
      '<g class="pawn-sticker"></g>';
    svg.__pawnShell = shell;
    svg.__pawnBase = base;
  }
  paintSticker(svg.querySelector('g.pawn-sticker'), { id, slot, photo, crop, filterId });
}

/** How much of a tile's width the slot square takes (see paintTile's margin). */
export function tileSlotShare(slot, margin = 3) {
  return slot.w / (slot.w + 2 * margin);
}

// ---- decoding a photo the way Pillow reads it ---------------------------------

const prepared = new Map();

const canvasBlob = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png')
  );

/**
 * A photo ready to place: `{ href, width, height, crop }`, cached per source.
 *
 * Decoded the way Pillow sees the file — EXIF rotation applied
 * (ImageOps.exif_transpose), NO colour-profile conversion (Pillow ignores the
 * ICC and the printer renders the untagged square it saves) and no
 * premultiplication — and re-encoded once, so the SVG draws exactly those pixels
 * and, for a cutout, exactly the alpha the generator kept.
 *
 * `src` is a URL or a Blob; `key` names it for the cache (defaults to the URL).
 * Resolves to null when the browser cannot decode it; the caller then draws no
 * photo rather than a wrong one.
 */
export function preparePhoto(src, { cutout, key } = {}) {
  const k = (cutout ? 'c:' : 'o:') + (key || src);
  if (!prepared.has(k)) prepared.set(k, decode(src, !!cutout));
  return prepared.get(k);
}

/** Forget a prepared photo (its object URL is released). */
export function releasePhoto(key, { cutout } = {}) {
  const k = (cutout ? 'c:' : 'o:') + key;
  const p = prepared.get(k);
  prepared.delete(k);
  if (p) p.then((r) => r && URL.revokeObjectURL(r.href)).catch(() => {});
}

async function decode(src, cutout) {
  let bitmap = null;
  try {
    const blob = typeof src === 'string' ? await fetch(src).then((r) => r.blob()) : src;
    bitmap = await createImageBitmap(blob, {
      imageOrientation: 'from-image',
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const w = bitmap.width;
    const h = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const { crop, alpha, erased } = autoCrop(img.data, w, h, cutout);
    if (erased) {
      for (let i = 0; i < w * h; i++) img.data[i * 4 + 3] = alpha[i];
      ctx.putImageData(img, 0, 0);
    }
    const href = URL.createObjectURL(await canvasBlob(canvas));
    return { href, width: w, height: h, crop };
  } catch {
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}
