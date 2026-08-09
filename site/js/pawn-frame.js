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
