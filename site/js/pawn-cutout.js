// pawn-cutout.js — turn a pawn photo into a transparent die-cut sticker, ON THE
// BUYER'S DEVICE.
//
// WHY THIS EXISTS
// The deck's photo card draws each pawn as a die-cut sticker whose white outline
// is generated from the image's OWN alpha (docs/photo-card.md — the halo is a
// <use> of the slot through a filter that dilates SourceAlpha). A photo straight
// off a phone is fully opaque, so it has no silhouette to trace and prints as a
// white-bordered RECTANGLE. Something has to remove the background.
//
// WHY IN THE BROWSER
//   * zero per-cut cost and no third-party API — the whole point;
//   * nothing is added to the container, which is Alpine/musl and has no
//     onnxruntime wheel to install anyway, and which recently ran out of PIDs;
//   * the photo never leaves the device to be cut;
//   * the buyer SEES the sticker before ordering and can retry a bad one — a bad
//     cut is the one defect that survives to 104 printed cards.
//
// WHAT RUNS
// MediaPipe Tasks Vision' ImageSegmenter with the selfie_multiclass_256x256
// model, both Apache-2.0 and both SELF-HOSTED under /vendor/mediapipe (see the
// README there). No CDN, no network call off our own origin: with the container
// offline this still works, because the buyer's browser already has the files.
//
// EVERYTHING HERE IS BEST-EFFORT. Every failure — an old browser, no WebAssembly,
// a device that runs out of memory, a photo of a landscape with no person in it —
// resolves to null. The caller then keeps the ORIGINAL photo and records the miss
// so the owner can cut it by hand. A cut is never allowed to fail an order.

const VENDOR = '/vendor/mediapipe';
const MODEL = VENDOR + '/selfie_multiclass_256x256.tflite';

// Longest side of the cutout we hand back. The card only ever shows 512px of it
// (docs/photo-card.md) but the generator crops a square out first, so keep some
// slack — and stay well under the 4MB upload cap a PNG this size lands around.
const MAX_PX = 1024;

// selfie_multiclass labels: 0 background, 1 hair, 2 body-skin, 3 face-skin,
// 4 clothes, 5 others (accessories). Everything that is not 0 is the person.
const BACKGROUND_CLASS = 0;

let segmenterPromise = null;

// One segmenter for the whole page, created on first use. Loading it pulls ~18MB
// (the wasm arrives brotli-compressed at ~2.4MB; the model does not compress and
// is the bulk), so this is deliberately NOT started at page load — only when the
// buyer actually picks a photo.
function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import(VENDOR + '/vision_bundle.mjs');
      const fileset = await FilesetResolver.forVisionTasks(VENDOR);
      return await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })().catch((e) => {
      // Remember the failure rather than retrying the 18MB download per photo.
      segmenterPromise = Promise.reject(e);
      throw e;
    });
  }
  return segmenterPromise;
}

// Decode the file UPRIGHT and downscaled.
//
// The EXIF rotation is load-bearing and can only be applied here: a phone photo
// carries its rotation as metadata, and the cutout we produce is a fresh PNG with
// no EXIF at all — so a photo decoded sideways would be sideways for good, with
// the tag that would have fixed it gone. (`build.square_photo` exif-transposes
// what it is given; on the cutout that is a no-op, which is exactly right.)
export async function decodeUpright(file, maxPx = MAX_PX) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return canvas;
}

// Keep only the biggest connected blob of the mask.
//
// The model happily labels a bystander's shoulder in the corner of the frame as
// "person". On a die-cut sticker that prints as a white-outlined scrap floating
// beside the subject, which reads as a printing defect rather than a choice.
// Measured on the evaluation set: this is what removes the stray blob a group
// photo otherwise keeps.
export function largestBlob(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  const sizes = [];
  for (let seed = 0; seed < w * h; seed++) {
    if (!mask[seed] || label[seed] >= 0) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    let count = 0;
    queue[tail++] = seed;
    label[seed] = id;
    while (head < tail) {
      const p = queue[head++];
      count++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) {
        label[p - 1] = id;
        queue[tail++] = p - 1;
      }
      if (x < w - 1 && mask[p + 1] && label[p + 1] < 0) {
        label[p + 1] = id;
        queue[tail++] = p + 1;
      }
      if (y > 0 && mask[p - w] && label[p - w] < 0) {
        label[p - w] = id;
        queue[tail++] = p - w;
      }
      if (y < h - 1 && mask[p + w] && label[p + w] < 0) {
        label[p + w] = id;
        queue[tail++] = p + w;
      }
    }
    sizes.push(count);
  }
  if (sizes.length < 2) return mask;
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = label[i] === best ? 1 : 0;
  return out;
}

// How much of the frame the subject has to cover for the cut to be believable.
// Below this the model found a speck (or nothing): a photo with no person in it
// segments to a handful of stray pixels, and cutting to those would print an
// almost-empty sticker. Better to report a miss and let the original through.
const MIN_COVERAGE = 0.02;

// Give up after this long. A cut that never finishes is worse than no cut: the
// wizard would sit on the photo step waiting for it. On the measured devices the
// whole thing (download included) is a couple of seconds; anything past this is a
// device that cannot do the job, and the miss path exists for exactly that.
const CUT_TIMEOUT_MS = 15000;

// The cutout for `file` as a transparent PNG Blob, or null if we could not make
// one. Never throws.
export function cutPawnPhoto(file) {
  return Promise.race([
    cut(file),
    new Promise((resolve) => setTimeout(() => resolve(null), CUT_TIMEOUT_MS)),
  ]);
}

async function cut(file) {
  try {
    const segmenter = await getSegmenter();
    const source = await decodeUpright(file);
    const result = segmenter.segment(source);
    let png = null;
    try {
      const category = result.categoryMask;
      const mw = category.width;
      const mh = category.height;
      const raw = category.getAsUint8Array();
      const person = new Uint8Array(mw * mh);
      let covered = 0;
      for (let i = 0; i < mw * mh; i++) {
        if (raw[i] !== BACKGROUND_CLASS) {
          person[i] = 1;
          covered++;
        }
      }
      if (covered / (mw * mh) < MIN_COVERAGE) return null;
      png = await compose(source, largestBlob(person, mw, mh), mw, mh);
    } finally {
      result.close();
    }
    return png;
  } catch {
    return null; // a miss, never an error — the caller keeps the original
  }
}

// Paint the mask over the photo as its alpha channel and encode a PNG.
//
// The mask is 256x256 and the photo is up to 1024px, so drawing the mask scaled
// up gives a smoothly interpolated edge for free — which is what the sticker halo
// wants; a hard-thresholded mask at slot resolution shows its stair-steps.
async function compose(source, mask, mw, mh) {
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = mw;
  maskCanvas.height = mh;
  const maskCtx = maskCanvas.getContext('2d');
  const img = maskCtx.createImageData(mw, mh);
  for (let i = 0; i < mw * mh; i++) {
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = mask[i] ? 255 : 0;
  }
  maskCtx.putImageData(img, 0, 0);

  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0, out.width, out.height);
  return await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}
