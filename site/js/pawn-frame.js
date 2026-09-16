// pawn-frame.js — the buyer's own adjustment to a pawn photo, and where a picture
// actually lands inside its box.
//
// How a photo is framed and DRAWN lives in site/js/pawn-print.js now, which
// repeats the generator's crop and sticker exactly. What is left here is what was
// never the printer's to decide: the zoom and pan she sets, their range, and the
// geometry of fitting the card's picture into the page.

// THE BUYER'S OWN ADJUSTMENT, on top of the automatic frame.
//
// The framing rules answer "where is the subject?", which is not always the same
// question as "which part of this photo do I want on the pawn". A group shot, a
// photo where the cut kept an arm, a face the buyer wants larger — none of those
// are framing bugs, they are choices, and this is the buyer making them.
//
// zoom > 1 moves closer; dx/dy slide the window across the photo in units of the
// window's own side, so the numbers mean the same thing at every zoom and on every
// photo size. build.apply_photo_view and pawn-print.js viewCrop apply them.
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
 * side of a 327px frame, and the pawn photos laid over it came out 27% wider
 * than tall and 22px off the dashed cut-line they are supposed to fill.
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
