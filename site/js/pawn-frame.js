// pawn-frame.js — where a cutout sits inside the pawn's circle, in the buyer's
// browser, using the SAME rule the generator uses to print it.
//
// WHY THIS EXISTS. The photo step used to show the cutout contained in a square
// on a checkerboard, which answers "did the background come off?" and nothing
// else. The buyer's actual question is whether their friend's face reads at the
// size it prints — and until the deck is made, this is the only place they can
// see that. So the slot now shows the pawn: on the card, inside the dashed
// cut-line, framed exactly as generator/build.py frames it.
//
// THE RULE, mirrored from build.subject_box / build.subject_window /
// build.subject_reach:
//
//   1. the subject is every pixel at or above ALPHA_MIN (24 — low on purpose,
//      a hair matte fades to zero over a few pixels and all of it is subject);
//   2. an alpha that says nothing — nothing opaque, or nothing transparent —
//      is NOT a subject, and the caller falls back to the plain square crop,
//      exactly as subject_box returning None does on the generator side;
//   3. if the cut left several blobs, ONE of them is the subject: the one whose
//      centre of mass is nearest the middle of the frame, with specks dropped
//      first. The others are erased before anything is measured;
//   4. its REACH is the distance from its bounding box's centre to its farthest
//      pixel, measured off the silhouette rather than the box, because a head
//      leaves its box's corners empty and the corner radius would over-state the
//      reach by up to 40% — shrinking the face to leave room nobody occupies;
//   5. the disc covers that reach exactly, so the WHOLE subject fits inside the
//      circle and nothing is cut. Too big means smaller, never trimmed.
//
// Keeping the two in step matters more than the arithmetic being clever: a
// preview that frames differently from the printer is worse than no preview,
// because it is believed. If build.py's framing changes, change this with it.
//
// Steps 2 and 3 were missing here for one release and the owner saw the cost on
// a real order: a photo of two people previewed with BOTH of them shrunk to fit
// the circle, and printed with the honoree alone at full size — the same picture
// in the same tab, disagreeing with itself. The cross-check at the foot of
// tests/unit/pawn-view.test.js now holds the two together on exactly those inputs.
//
// ONE DIFFERENCE REMAINS, KNOWN AND BOUNDED. The generator ERASES the blobs it
// did not pick from the alpha before it saves the square, so a bystander leaves
// no trace on the card. This side can only choose where to put the picture — the
// browser draws the cutout file as it is — so a bystander who happens to fall
// inside the honoree's disc after framing is still visible in the preview, as a
// sliver at its edge, where the print has nothing. Closing it means compositing
// every photo onto a canvas and holding a second copy of it in memory on a
// phone, to remove pixels the framing has already decided not to be about. The
// framing is what the buyer is judging, and the framing now agrees.
//
// EVERYTHING IS EXPRESSED AS A PERCENTAGE OF THE SLOT, never in pixels. The slot
// is square but its size is responsive (96 px on a phone, 300 on a desktop), and
// a percentage answer needs no resize listener and cannot go stale.

// An alpha at or above this counts as subject. Mirrors PHOTO_ALPHA_MIN.
export const ALPHA_MIN = 24;

// How much of the square the visible disc takes. Mirrors PHOTO_DISC_FILL — the
// margin is load-bearing on the printed card (the white ring is dilated OUT of
// the disc and has to land inside the dashed cut-line), and the preview shows
// the same proportion so the buyer sees the real spacing.
export const DISC_FILL = 0.9;

// Long side of the mask the reach is measured on. The generator uses 200 for the
// same job; matching it means the two agree to within a mask pixel, and it keeps
// this off the main thread's back on a phone (a full-resolution scan of a 12 MP
// photo in JS is not free).
export const MASK_PX = 200;

// Below the first share of the frame there is nothing worth framing (a cut that
// collapsed); at or above the second there is nothing transparent to frame BY (an
// ordinary opaque photo, or a segmenter that kept everything). Either way there is
// no silhouette and the answer is `null`, which sends the caller to plainFrame —
// the same fork build.subject_box takes when it returns None. Without this an
// opaque "cutout" was measured corner-to-corner and drawn to fit its own diagonal
// inside the disc, i.e. shrunk by ~1.4x against a print that fills the slot.
// Mirrors PHOTO_SUBJECT_MIN_COVER / PHOTO_SUBJECT_MAX_COVER.
export const MIN_COVER = 0.005;
export const MAX_COVER = 0.995;

// A blob smaller than this share of the biggest one is a speck the segmenter left
// behind, never the subject — dropped before the nearest-to-centre choice so a
// stray scrap at dead centre cannot beat the person. Mirrors PHOTO_BLOB_MIN_SHARE.
export const BLOB_MIN_SHARE = 0.08;

// How far the reach measurement may miss by, in mask pixels. The mask is a
// downscale of the photo, so the silhouette's outermost pixel can fall between
// samples; padding the answer by one keeps the real edge inside the disc rather
// than a fraction of a pixel outside it. Mirrors PHOTO_REACH_SLACK — where the
// generator divides by its own downscale factor to get back to source pixels,
// this measures on the mask itself and so needs no conversion.
export const REACH_SLACK = 1;

/**
 * The 8-connected blobs of a subject mask, biggest first.
 *
 * `mask` is a Uint8Array of 0/1 over `width` x `height`. Each entry is
 * `{ n, box: [l, t, r, b], cx, cy, seed }` — `seed` being one pixel known to
 * belong to it, so the caller can walk it again without hunting for a way in.
 * An iterative flood fill, mirroring build._blobs; the generator runs the same
 * walk on a 200 px mask for the same reason (a full-resolution flood fill is not
 * something to do on a phone's main thread).
 */
function blobs(mask, width, height) {
  const seen = new Uint8Array(width * height);
  const out = [];
  const stack = [];
  for (let y0 = 0; y0 < height; y0++) {
    for (let x0 = 0; x0 < width; x0++) {
      const at = y0 * width + x0;
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
        const x = i % width;
        const y = (i - x) / width;
        n++;
        sx += x;
        sy += y;
        if (x < left) left = x;
        else if (x > right) right = x;
        if (y < top) top = y;
        else if (y > bottom) bottom = y;
        for (let ny = Math.max(0, y - 1); ny < Math.min(height, y + 2); ny++) {
          for (let nx = Math.max(0, x - 1); nx < Math.min(width, x + 2); nx++) {
            const j = ny * width + nx;
            if (mask[j] && !seen[j]) {
              seen[j] = 1;
              stack.push(j);
            }
          }
        }
      }
      out.push({ n, box: [left, top, right + 1, bottom + 1], cx: sx / n, cy: sy / n, seed: at });
    }
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}

/**
 * Everything except the subject's own blob, erased from `mask` — in place.
 *
 * Which blob is the subject: the one whose centre of mass is nearest the centre
 * of the frame. Not the biggest, and this is build.subject_box's reasoning
 * verbatim — a person standing behind the honoree can easily be the larger of the
 * two, and the one being photographed is the one in the middle.
 *
 * Returns the blob that was kept, or null when there was never more than one (in
 * which case the mask is untouched, so a soft matte that reads as a single blob
 * is measured exactly as it was before any of this existed).
 */
function keepSubjectBlob(mask, width, height) {
  const found = blobs(mask, width, height);
  if (found.length < 2) return found[0] || null;
  const biggest = found[0].n;
  const real = found.filter((b) => b.n >= BLOB_MIN_SHARE * biggest);
  const pool = real.length ? real : [found[0]];
  const mx = width / 2;
  const my = height / 2;
  let pick = pool[0];
  let best = Infinity;
  for (const b of pool) {
    const d = (b.cx - mx) ** 2 + (b.cy - my) ** 2;
    if (d < best) {
      best = d;
      pick = b;
    }
  }
  // Re-walk the chosen blob and keep only it. The generator has to dilate its
  // keep-mask because it builds it small and blows it back up; here the walk runs
  // on the very pixels that will be measured, so the blob IS the keep-set and
  // there is nothing to round off.
  const keep = new Uint8Array(width * height);
  const stack = [pick.seed];
  keep[pick.seed] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    const y = (i - x) / width;
    for (let ny = Math.max(0, y - 1); ny < Math.min(height, y + 2); ny++) {
      for (let nx = Math.max(0, x - 1); nx < Math.min(width, x + 2); nx++) {
        const j = ny * width + nx;
        if (mask[j] && !keep[j]) {
          keep[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  mask.set(keep);
  return pick;
}

/**
 * Where the subject sits, from raw RGBA pixels.
 *
 * `image` is anything shaped like ImageData: { data, width, height }, so this is
 * a pure function and testable without a canvas.
 *
 * Returns `{ widthPct, leftPct, topPct }` — the image's width as a percentage of
 * the slot, and the offsets of its top-left corner, also in percent — or `null`
 * when there is no subject to frame. `null` is not a failure: it is the same
 * fork build.subject_box takes, and the caller answers it the same way, with
 * plainFrame — a fully transparent image, an opaque one with no silhouette in it
 * at all, or a cut that collapsed to a speck.
 */
export function subjectFrame(image, opts = {}) {
  const discFill = opts.discFill == null ? DISC_FILL : opts.discFill;
  const alphaMin = opts.alphaMin == null ? ALPHA_MIN : opts.alphaMin;
  const { data, width, height } = image || {};
  if (!data || !width || !height) return null;

  // Pass 1 — the subject mask, its bounding box and how much of the frame it
  // covers. The mask is kept because the blob walk needs it, and because
  // erasing a bystander from it is how the walk's answer is applied.
  const mask = new Uint8Array(width * height);
  let opaque = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] >= alphaMin) {
        mask[y * width + x] = 1;
        opaque++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null; // nothing opaque anywhere
  // Nothing transparent anywhere is the same non-answer: there is no silhouette
  // in an opaque photo, only its rectangle, and framing on a rectangle's diagonal
  // draws it 1.4x smaller than the printer will. build.subject_box refuses the
  // same two extremes before it looks at a single blob.
  const cover = opaque / (width * height);
  if (cover < MIN_COVER || cover > MAX_COVER) return null;

  // Pass 2 — WHICH silhouette. A cut that kept a bystander leaves two blobs, and
  // the generator measures only the one nearest the middle of the frame; measuring
  // both here would preview two small people where the card prints one large one.
  // Erasing happens in the mask, so passes 3 and 4 need know nothing about it.
  if (keepSubjectBlob(mask, width, height)) {
    x0 = width;
    y0 = height;
    x1 = -1;
    y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!mask[y * width + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
  }

  const cx = (x0 + x1 + 1) / 2;
  const cy = (y0 + y1 + 1) / 2;

  // Pass 3 — the reach. Only a row's OUTERMOST subject pixels can be its farthest
  // from the centre (distance grows with |x - cx|), so two scans per row answer
  // it without measuring the interior.
  let reach = 0;
  for (let y = y0; y <= y1; y++) {
    let first = -1;
    let last = -1;
    for (let x = x0; x <= x1; x++) {
      if (mask[y * width + x]) {
        if (first < 0) first = x;
        last = x;
      }
    }
    if (first < 0) continue;
    const dy = y + 0.5 - cy;
    for (const x of [first, last]) {
      const dx = x + 0.5 - cx;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > reach) reach = d;
    }
  }
  if (!(reach > 0)) return null;
  // One mask pixel of slack, never past the box's own corner — which already
  // contains every subject pixel by construction. build.subject_reach ends on the
  // same two lines.
  reach = Math.min(reach + REACH_SLACK, Math.hypot(x1 + 1 - x0, y1 + 1 - y0) / 2);

  // The disc's radius as a share of the slot, and the scale that maps the
  // subject's reach onto it.
  const r = (discFill / 2) * 100;
  const k = r / reach;
  return {
    widthPct: width * k,
    heightPct: height * k,
    leftPct: 50 - cx * k,
    topPct: 50 - cy * k,
  };
}

// Where a face sits in a portrait photo, as a fraction of its height. Mirrors
// build.PHOTO_SUBJECT_Y — the DEGRADED path, taken when there is no alpha to
// measure: an opaque phone photo (which is exactly what "keep the background"
// sends to the printer) or a cut that collapsed.
export const SUBJECT_Y = 0.3;

/**
 * The frame for a photo with NO usable alpha, mirroring build.square_photo's
 * fallback: the biggest square that fits, anchored on the head in portrait and
 * centred left-to-right in landscape. Same answer shape as `subjectFrame`.
 *
 * `width`/`height` are the photo's natural pixel dimensions. Returns null when
 * they are not usable.
 */
export function plainFrame(width, height) {
  if (!(width > 0) || !(height > 0)) return null;
  const side = Math.min(width, height);
  let left = 0;
  let top = 0;
  if (height > width) {
    top = Math.round(SUBJECT_Y * height - side / 2);
    top = Math.max(0, Math.min(top, height - side));
  } else {
    left = Math.floor((width - side) / 2);
  }
  // The square maps onto the whole slot; the disc clips it afterwards, exactly
  // as _disc_mask does on the printed card.
  const k = 100 / side;
  return {
    widthPct: width * k,
    heightPct: height * k,
    leftPct: -left * k,
    topPct: -top * k,
  };
}

// THE BUYER'S OWN ADJUSTMENT, on top of whichever frame the rules above chose.
//
// The framing rules answer "where is the subject?", which is not always the same
// question as "which part of this photo do I want on the pawn". A group shot, a
// photo where the cut kept an arm, a face the buyer wants larger — none of those
// are framing bugs, they are choices, and this is the buyer making them.
//
// zoom > 1 moves closer; dx/dy slide the window across the photo in units of the
// window's own side, so the numbers mean the same thing at every zoom and on
// every photo size. build.apply_photo_view applies the identical transform to
// the crop rectangle, so what she lines up here is what the printer cuts.
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const PAN_MAX = 1;
export const VIEW_DEFAULT = { zoom: 1, dx: 0, dy: 0, bg: false };

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

/** A stored view coerced into range. Anything unusable falls back to the default. */
export function clampView(view) {
  const v = view || {};
  return {
    zoom: clampNum(v.zoom, ZOOM_MIN, ZOOM_MAX, 1),
    dx: clampNum(v.dx, -PAN_MAX, PAN_MAX, 0),
    dy: clampNum(v.dy, -PAN_MAX, PAN_MAX, 0),
    bg: !!v.bg,
  };
}

/** True when this view asks for nothing the automatic framing wouldn't do. */
export function isDefaultView(view) {
  const v = clampView(view);
  return v.zoom === 1 && v.dx === 0 && v.dy === 0;
}

/**
 * `frame` seen through `view` — still in percent-of-slot units, so the caller
 * positions the image exactly as it did before.
 *
 * The window is what moves, not the picture: sliding it right (dx > 0) shows a
 * part of the photo further right, which walks the picture LEFT under the slot.
 * That inversion is why this lives here rather than in the drag handler.
 */
export function applyView(frame, view) {
  if (!frame) return frame;
  const v = clampView(view);
  const z = v.zoom;
  return {
    widthPct: frame.widthPct * z,
    heightPct: frame.heightPct * z,
    leftPct: 50 - z * (50 - frame.leftPct) - 100 * z * v.dx,
    topPct: 50 - z * (50 - frame.topPct) - 100 * z * v.dy,
  };
}

/**
 * The same answer for a Blob, doing the canvas work this time.
 *
 * Best-effort by contract: anything that fails — a browser without
 * createImageBitmap, a canvas the phone refuses to allocate, an undecodable blob
 * — resolves to `null`, and the caller shows the photo the way it always did.
 * A preview is never worth failing an order over.
 */
export async function frameFromBlob(blob) {
  if (!blob || typeof document === 'undefined') return null;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
    const long = Math.max(bitmap.width, bitmap.height) || 1;
    const scale = Math.min(1, MASK_PX / long);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return subjectFrame(ctx.getImageData(0, 0, w, h));
  } catch {
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}

// ---------------------------------------------------------------------------
// THE PAWN'S GEOMETRY, IN ONE PLACE
//
// The same photo is drawn three times over, and until this section existed each
// of the three carried its own copy of the proportions: the PRINTED card (the
// generator, `build.PHOTO_DISC_FILL` + the cut-line circles in the photo-card
// SVG), the PREVIEW CARD at the top of the photos tab, and the EDITOR CIRCLE in
// the row underneath it. Three copies is three chances to disagree, and they did
// — the editor drew its dashed ring at the DISC's size rather than the SLOT's,
// which made every photo look ~11% bigger there than on the card next to it, and
// bigger than it prints. The owner reported that mismatch repeatedly and was
// right every time.
//
// So the numbers live here, once, and generator/test_pawn_three_views.py renders
// all three and fails when they drift apart again.
//
// THE THREE CIRCLES, all of them squares' worth of the SLOT — the square
// `<image id="photo-slot-N">` occupies on the card (66 of the artwork's 223.92
// x 312 units):
//
//   * the SLOT itself: the square the photo is handed. 100%.
//   * the DISC: what the photo is actually clipped to. DISC_FILL of the slot,
//     centred — `build._disc_mask`.
//   * the RING: the dashed line she cuts along. The slot's INSCRIBED circle —
//     `<circle class="cut-line" r="33">` against a 66-unit slot — so it is the
//     full 100% and the white halo lands in the gap between the two.

// The dashed cut-line, as a share of the slot. 1 and not DISC_FILL, and this is
// the whole of the bug the harness was built to catch: on the card the ring is
// the slot's inscribed circle and the photo sits INSIDE it, with the sticker's
// white edge in the gap. An editor that drew the ring at the disc's size showed
// the photo filling the circle to its rim.
export const RING_FILL = 1;

// The white sticker ring, as a share of the SLOT's width, measured on the print.
// The card gets a real dilate — `<filter id="sticker-halo">`: feMorphology
// radius 1.5 over that 66-unit slot, hardened from a blur by an alpha ramp — and
// a browser's nearest cheap equivalent is a stack of white drop-shadows. What
// matters is that it comes out the same WIDTH relative to the circle in all
// three pictures, which is what the harness measures.
export const HALO_FILL = 1.5 / 66;

/** Percent inset of a circle that covers `fill` of the slot, centred in it. */
export function insetPct(fill) {
  return (100 - 100 * fill) / 2;
}

/**
 * The CSS custom properties every pawn circle is drawn from, as a plain object.
 *
 * site/css/pawn.css spends these (with the same values as literal fallbacks, so
 * the page is never wrong before the module runs); the harness sets them from
 * here too, which is what makes it a test of the real stylesheet rather than of
 * a copy of it.
 */
export function pawnCssVars() {
  return {
    '--pawn-disc-inset': insetPct(DISC_FILL).toFixed(4) + '%',
    '--pawn-ring-inset': insetPct(RING_FILL).toFixed(4) + '%',
  };
}

// How many hard shadows the halo is built from, and how far each one is offset
// as a share of the halo's total reach. See haloFilter: chained filters compound,
// and eight evenly-spread offsets of 1/2.5 of the reach sum to 2.414 of a step
// along an axis and 2.61 on the diagonal — 0.97 and 1.04 of the reach, i.e. 8%
// out of round, which is invisible at the size a pawn is drawn.
const HALO_STEPS = 8;
const HALO_STEP_SHARE = 1 / 2.5;

/**
 * The white sticker edge for a circle whose SLOT is `slotPx` across.
 *
 * TWO THINGS THIS HAS TO GET RIGHT, both of them measured by
 * generator/pawn_three_views.py against the printed card.
 *
 * WIDTH. It scales with the slot. The old rule was a fixed 2px+2px+1.5px, which
 * is a different fraction of the row's 116px circle than of the ~58px one on the
 * card above it — so the same photo carried two different white edges in the
 * same tab, and neither was the print's.
 *
 * HARDNESS. `drop-shadow` BLURS; the printed halo does not. The card's edge is an
 * feMorphology dilate hardened by an alpha ramp — a solid white rim that stops
 * dead. A stack of blurred shadows measured 60% too wide and only 9% of it ever
 * reached white, which is why the row's pawn had a soft glow where the card has a
 * sticker edge. Eight HARD shadows (no blur) spread around a circle dilate
 * instead of smearing, and because each filter in a chain sees the previous
 * one's output they compound to the full reach at a fraction of the offset each.
 *
 * Returns a `filter` value, or `'none'` for a photo with no cut-out edge to
 * trace (a photo that keeps its background prints as a plain filled circle).
 */
export function haloFilter(slotPx) {
  const reach = HALO_FILL * (slotPx || 0);
  if (!(reach > 0.4)) return 'none'; // below half a pixel there is nothing to draw
  const step = reach * HALO_STEP_SHARE;
  const out = [];
  for (let i = 0; i < HALO_STEPS; i++) {
    const a = (2 * Math.PI * i) / HALO_STEPS;
    const dx = (Math.cos(a) * step).toFixed(2);
    const dy = (Math.sin(a) * step).toFixed(2);
    out.push(`drop-shadow(${dx}px ${dy}px 0 #fff)`);
  }
  return out.join(' ');
}

/**
 * Where `object-fit: contain` ACTUALLY draws a picture inside its element.
 *
 * `contain` scales the picture to fit and centres what is left over, so the
 * drawn rectangle equals the element only when the two have the same shape.
 * Every other time there is a band down two of the sides, and anything laid over
 * the ELEMENT is laid over that band as well.
 *
 * WHY THIS IS A FUNCTION AND NOT AN ASSUMPTION. The card preview used to assume
 * the two rectangles were the same, on the strength of the frame carrying the
 * card's own `aspect-ratio`. Chrome honours that; SAFARI DOES NOT — given
 * `width: auto` with `max-height`, it leaves the frame at its full inline size
 * and centres the picture inside it. On a phone that is a 36px band down each
 * side of a 327px frame, and the four pawn photos — positioned as percentages of
 * the frame — came out 27% wider than tall (an ellipse where the card prints a
 * circle) and slid 22px off the dashed cut-line they are supposed to fill. The
 * owner reported both symptoms, in those words, and was right about both.
 *
 * Measuring where the picture landed costs one function call and is true in
 * every engine, including whichever one behaves differently next.
 *
 * Returns `{ left, top, width, height }` in the element's own pixels, or `null`
 * when anything needed is missing — an image that has not decoded yet has no
 * natural size, and the caller leaves the layer where it is rather than
 * collapsing it to nothing.
 */
export function containRect(elWidth, elHeight, naturalWidth, naturalHeight) {
  if (!(elWidth > 0) || !(elHeight > 0)) return null;
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  const scale = Math.min(elWidth / naturalWidth, elHeight / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return { left: (elWidth - width) / 2, top: (elHeight - height) / 2, width, height };
}

/**
 * Where one live slot sits on a picture of the CARD, in percent.
 *
 * `geo` is the generator's own slot rect (`preview.pawn_slots`), a fraction of
 * the card — the SQUARE, ring and all. What gets positioned is the DISC inside
 * it, because that is the element the photo is clipped by.
 */
export function liveSlotStyle(geo) {
  const d = DISC_FILL;
  return {
    left: ((geo.x + (geo.w * (1 - d)) / 2) * 100).toFixed(3) + '%',
    top: ((geo.y + (geo.h * (1 - d)) / 2) * 100).toFixed(3) + '%',
    width: (geo.w * d * 100).toFixed(3) + '%',
    height: (geo.h * d * 100).toFixed(3) + '%',
  };
}

/**
 * Where the PHOTO sits inside that disc, in percent of the disc.
 *
 * `subjectFrame`/`plainFrame` answer in percentages of the SLOT and the element
 * these land on is the DISC, so every number is rebased by 1/DISC_FILL here —
 * once, rather than in each of the three callers.
 *
 * A null `frame` is "we could not measure this photo": fill the circle and let
 * it be cropped, which is what the printer does with it too.
 */
export function discPhotoStyle(frame, view) {
  if (!frame) {
    return { width: '100%', height: '100%', left: '0', top: '0', objectFit: 'cover' };
  }
  const f = applyView(frame, view);
  const k = 1 / DISC_FILL;
  const inset = insetPct(DISC_FILL);
  return {
    width: (f.widthPct * k).toFixed(3) + '%',
    height: (f.heightPct * k).toFixed(3) + '%',
    left: ((f.leftPct - inset) * k).toFixed(3) + '%',
    top: ((f.topPct - inset) * k).toFixed(3) + '%',
    objectFit: 'contain',
  };
}
