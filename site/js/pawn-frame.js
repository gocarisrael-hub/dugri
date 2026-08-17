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
