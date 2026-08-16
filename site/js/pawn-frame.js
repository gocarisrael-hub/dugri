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
// THE RULE, mirrored from build.subject_window / build.subject_reach:
//
//   1. the subject is every pixel at or above ALPHA_MIN (24 — low on purpose,
//      a hair matte fades to zero over a few pixels and all of it is subject);
//   2. its REACH is the distance from its bounding box's centre to its farthest
//      pixel, measured off the silhouette rather than the box, because a head
//      leaves its box's corners empty and the corner radius would over-state the
//      reach by up to 40% — shrinking the face to leave room nobody occupies;
//   3. the disc covers that reach exactly, so the WHOLE subject fits inside the
//      circle and nothing is cut. Too big means smaller, never trimmed.
//
// Keeping the two in step matters more than the arithmetic being clever: a
// preview that frames differently from the printer is worse than no preview,
// because it is believed. If build.py's framing changes, change this with it.
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

/**
 * Where the subject sits, from raw RGBA pixels.
 *
 * `image` is anything shaped like ImageData: { data, width, height }, so this is
 * a pure function and testable without a canvas.
 *
 * Returns `{ widthPct, leftPct, topPct }` — the image's width as a percentage of
 * the slot, and the offsets of its top-left corner, also in percent — or `null`
 * when there is no subject to frame (a fully transparent image, or one with no
 * alpha at all, where there is nothing to measure and the caller should fall
 * back to showing the photo as it is).
 */
export function subjectFrame(image, opts = {}) {
  const discFill = opts.discFill == null ? DISC_FILL : opts.discFill;
  const alphaMin = opts.alphaMin == null ? ALPHA_MIN : opts.alphaMin;
  const { data, width, height } = image || {};
  if (!data || !width || !height) return null;

  // Pass 1 — the subject's bounding box.
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] >= alphaMin) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null; // nothing opaque anywhere

  const cx = (x0 + x1 + 1) / 2;
  const cy = (y0 + y1 + 1) / 2;

  // Pass 2 — the reach. Only a row's OUTERMOST subject pixels can be its farthest
  // from the centre (distance grows with |x - cx|), so two scans per row answer
  // it without measuring the interior.
  let reach = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * width * 4;
    let first = -1;
    let last = -1;
    for (let x = x0; x <= x1; x++) {
      if (data[row + x * 4 + 3] >= alphaMin) {
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
