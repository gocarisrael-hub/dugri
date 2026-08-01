import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initPinchZoom, ZOOM_MIN, ZOOM_MAX } from '../../site/js/pinch-zoom.js';

// jsdom has no layout and no TouchEvent, so these tests drive the module the way
// the browser would: plain Events carrying a `touches` list of {clientX, clientY}.
// Element sizes (which the pan clamp needs) are stubbed per element, and the
// transformed rect is derived from the transform we ourselves wrote — that's
// enough to assert the gesture MATH (scale, focal anchoring, clamping) and the
// touch-action handover, which is where the bugs live.

const OVERLAY_W = 400;
const OVERLAY_H = 800;
const IMG_W = 300;
const IMG_H = 600;

/** Fix an element's layout size (jsdom reports 0 for everything). */
function sizeOf(el, w, h) {
  Object.defineProperty(el, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: h, configurable: true });
}

/** Parse `translate(Xpx, Ypx) scale(S)` back into numbers. */
function readTransform(img) {
  const t = img.style.transform;
  if (!t) return { x: 0, y: 0, scale: 1 };
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(t);
  if (!m) throw new Error(`unexpected transform: ${t}`);
  return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
}

/**
 * Build the product overlay's shape: an overlay > track > N slides, each with an
 * image centred in the overlay. Returns { root, track, imgs }.
 */
function buildOverlay(n = 2) {
  const root = document.createElement('div');
  root.className = 'pdp-zoom';
  const track = document.createElement('div');
  track.id = 'pdpZoomTrack';
  root.appendChild(track);
  sizeOf(root, OVERLAY_W, OVERLAY_H);

  const imgs = [];
  for (let i = 0; i < n; i++) {
    const slide = document.createElement('div');
    slide.className = 'pdp-zoom-slide';
    const img = document.createElement('img');
    sizeOf(img, IMG_W, IMG_H);
    // The untransformed image is centred in the overlay; report the box the
    // current transform would produce so focal-point maths has real numbers.
    img.getBoundingClientRect = () => {
      const { x, y, scale } = readTransform(img);
      const w = IMG_W * scale;
      const h = IMG_H * scale;
      return {
        width: w,
        height: h,
        left: (OVERLAY_W - w) / 2 + x,
        top: (OVERLAY_H - h) / 2 + y,
      };
    };
    slide.appendChild(img);
    track.appendChild(slide);
    imgs.push(img);
  }
  document.body.appendChild(root);
  return { root, track, imgs };
}

/** Dispatch a touch event carrying `points` as both touches and changedTouches. */
function touch(target, type, points, { changed } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.touches = points;
  e.changedTouches = changed || points;
  target.dispatchEvent(e);
  return e;
}

const pt = (x, y) => ({ clientX: x, clientY: y });

/** Two fingers `d` px apart, horizontally centred on (cx, cy). */
const pinch = (d, cx = OVERLAY_W / 2, cy = OVERLAY_H / 2) => [
  pt(cx - d / 2, cy),
  pt(cx + d / 2, cy),
];

let api = null;

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  if (api) api.destroy();
  api = null;
  vi.useRealTimers();
});

describe('initPinchZoom', () => {
  it('is a no-op API when there is no root element', () => {
    const noop = initPinchZoom(null);
    expect(noop.scale()).toBe(1);
    expect(() => {
      noop.reset();
      noop.destroy();
    }).not.toThrow();
  });

  it('scales the photo by the ratio the fingers spread', () => {
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    touch(imgs[0], 'touchstart', pinch(100));
    touch(imgs[0], 'touchmove', pinch(200));

    expect(api.scale()).toBeCloseTo(2, 5);
    expect(readTransform(imgs[0]).scale).toBeCloseTo(2, 5);
  });

  it('pinching in from a zoomed state shrinks back toward fit', () => {
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    touch(imgs[0], 'touchstart', pinch(100));
    touch(imgs[0], 'touchmove', pinch(300)); // 3x
    touch(imgs[0], 'touchend', [], { changed: [pt(0, 0)] });

    touch(imgs[0], 'touchstart', pinch(300));
    touch(imgs[0], 'touchmove', pinch(150)); // half of 3x

    expect(api.scale()).toBeCloseTo(1.5, 5);
  });

  it('never scales outside [ZOOM_MIN, ZOOM_MAX]', () => {
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    touch(imgs[0], 'touchstart', pinch(50));
    touch(imgs[0], 'touchmove', pinch(5000));
    expect(api.scale()).toBe(ZOOM_MAX);

    touch(imgs[0], 'touchmove', pinch(1));
    expect(api.scale()).toBe(ZOOM_MIN);
  });

  it('anchors the zoom on the pinch centroid, so that point stays put', () => {
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    // Pinch centred on a point left of and above the photo's centre.
    const cx = 140;
    const cy = 300;
    const before = imgs[0].getBoundingClientRect();
    const relX = (cx - before.left) / before.width; // where in the photo it sits
    const relY = (cy - before.top) / before.height;

    touch(imgs[0], 'touchstart', pinch(100, cx, cy));
    touch(imgs[0], 'touchmove', pinch(200, cx, cy));

    // That same fraction of the photo is still under (cx, cy) afterwards.
    const after = imgs[0].getBoundingClientRect();
    expect(after.left + relX * after.width).toBeCloseTo(cx, 4);
    expect(after.top + relY * after.height).toBeCloseTo(cy, 4);
  });

  it('pans with one finger once zoomed, and clamps at the photo edges', () => {
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    touch(imgs[0], 'touchstart', pinch(100));
    touch(imgs[0], 'touchmove', pinch(200)); // 2x -> 600x1200 photo in a 400x800 box
    touch(imgs[0], 'touchend', [], { changed: [pt(0, 0)] });

    touch(imgs[0], 'touchstart', [pt(200, 400)]);
    touch(imgs[0], 'touchmove', [pt(240, 460)]);
    expect(readTransform(imgs[0])).toMatchObject({ x: 40, y: 60 });

    // Keep dragging: it stops where the photo's edge meets the overlay's.
    // maxX = (300*2 - 400)/2 = 100, maxY = (600*2 - 800)/2 = 200.
    touch(imgs[0], 'touchmove', [pt(1000, 1000)]);
    expect(readTransform(imgs[0])).toMatchObject({ x: 100, y: 200 });
  });

  it('leaves one-finger drags alone while at fit, so the carousel keeps its swipe', () => {
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    touch(imgs[0], 'touchstart', [pt(200, 400)]);
    const move = touch(imgs[0], 'touchmove', [pt(60, 400)]);

    expect(move.defaultPrevented).toBe(false);
    expect(imgs[0].style.transform).toBe('');
  });

  it('marks the overlay is-zoomed, which is what hands the track its gesture over', () => {
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    expect(root.classList.contains('is-zoomed')).toBe(false);

    touch(imgs[0], 'touchstart', pinch(100));
    touch(imgs[0], 'touchmove', pinch(200));
    // Zoomed: the drag is ours to pan with, never the carousel's to scroll with
    // (product.html hangs `touch-action: none` on the track off this class).
    expect(root.classList.contains('is-zoomed')).toBe(true);

    api.reset();
    expect(root.classList.contains('is-zoomed')).toBe(false);
  });

  it('double-tap toggles between fit and a readable zoom', () => {
    vi.useFakeTimers();
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    const tap = () => {
      touch(imgs[0], 'touchstart', [pt(200, 400)]);
      touch(imgs[0], 'touchend', [], { changed: [pt(200, 400)] });
    };

    tap();
    vi.advanceTimersByTime(100);
    tap();
    expect(api.scale()).toBeGreaterThan(ZOOM_MIN);

    tap();
    vi.advanceTimersByTime(100);
    tap();
    expect(api.scale()).toBe(ZOOM_MIN);
    expect(imgs[0].style.transform).toBe('');
  });

  it('two slow taps are not a double-tap', () => {
    vi.useFakeTimers();
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    for (let i = 0; i < 2; i++) {
      touch(imgs[0], 'touchstart', [pt(200, 400)]);
      touch(imgs[0], 'touchend', [], { changed: [pt(200, 400)] });
      vi.advanceTimersByTime(600);
    }
    expect(api.scale()).toBe(ZOOM_MIN);
  });

  it('a drag that ends where a second tap would be is not a double-tap', () => {
    vi.useFakeTimers();
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    touch(imgs[0], 'touchstart', [pt(200, 400)]);
    touch(imgs[0], 'touchend', [], { changed: [pt(200, 400)] });
    vi.advanceTimersByTime(100);
    // second "tap" travels far — a pan, not a tap
    touch(imgs[0], 'touchstart', [pt(200, 400)]);
    touch(imgs[0], 'touchmove', [pt(200, 300)]);
    touch(imgs[0], 'touchend', [], { changed: [pt(200, 300)] });

    expect(api.scale()).toBe(ZOOM_MIN);
  });

  it('lifting one finger out of a pinch does not register as a tap', () => {
    vi.useFakeTimers();
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    touch(imgs[0], 'touchstart', pinch(100));
    touch(imgs[0], 'touchmove', pinch(200));
    const zoomed = api.scale();
    touch(imgs[0], 'touchend', [pt(200, 400)], { changed: [pt(150, 400)] });
    touch(imgs[0], 'touchend', [], { changed: [pt(200, 400)] });
    vi.advanceTimersByTime(50);
    touch(imgs[0], 'touchstart', [pt(200, 400)]);
    touch(imgs[0], 'touchend', [], { changed: [pt(200, 400)] });

    expect(api.scale()).toBeCloseTo(zoomed, 5);
  });

  it('zooming a different photo drops the previous one back to fit', () => {
    const { root, imgs } = buildOverlay(2);
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    touch(imgs[0], 'touchstart', pinch(100));
    touch(imgs[0], 'touchmove', pinch(200));
    expect(imgs[0].style.transform).not.toBe('');

    touch(imgs[1], 'touchstart', pinch(100));
    touch(imgs[1], 'touchmove', pinch(300));

    expect(imgs[0].style.transform).toBe('');
    expect(readTransform(imgs[1]).scale).toBeCloseTo(3, 5);
  });

  it('starts a pinch that lands on the slide letterbox, not the photo', () => {
    const { root, track, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });
    const slide = track.querySelector('.pdp-zoom-slide');

    touch(slide, 'touchstart', pinch(100));
    touch(slide, 'touchmove', pinch(200));

    expect(readTransform(imgs[0]).scale).toBeCloseTo(2, 5);
  });

  it('ignores gestures that land outside any photo', () => {
    const { root } = buildOverlay();
    const chrome = document.createElement('button'); // e.g. the close button
    root.appendChild(chrome);
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    touch(chrome, 'touchstart', pinch(100));
    touch(chrome, 'touchmove', pinch(200));

    expect(api.scale()).toBe(ZOOM_MIN);
  });

  it('ctrl+wheel (the trackpad pinch) zooms, a plain wheel does not', () => {
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    const wheel = (init) =>
      imgs[0].dispatchEvent(
        Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), {
          clientX: 200,
          clientY: 400,
          ...init,
        })
      );

    wheel({ deltaY: -100 });
    expect(api.scale()).toBe(ZOOM_MIN);

    wheel({ deltaY: -100, ctrlKey: true });
    expect(api.scale()).toBeGreaterThan(ZOOM_MIN);
  });

  it('double-click toggles the zoom for mouse users', () => {
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });

    imgs[0].dispatchEvent(
      Object.assign(new Event('dblclick', { bubbles: true }), { clientX: 200, clientY: 400 })
    );
    expect(api.scale()).toBeGreaterThan(ZOOM_MIN);
  });

  it('reports every scale change through onScale', () => {
    const { root, imgs } = buildOverlay();
    const onScale = vi.fn();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide', onScale });

    touch(imgs[0], 'touchstart', pinch(100));
    touch(imgs[0], 'touchmove', pinch(200));
    expect(onScale).toHaveBeenLastCalledWith(2);

    api.reset();
    expect(onScale).toHaveBeenLastCalledWith(1);
  });

  it('reset clears the transform off every photo, clones included', () => {
    const { root, imgs } = buildOverlay(3);
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });
    imgs[2].style.transform = 'translate(5px, 5px) scale(2)'; // stale clone

    touch(imgs[0], 'touchstart', pinch(100));
    touch(imgs[0], 'touchmove', pinch(200));
    api.reset();

    for (const img of imgs) expect(img.style.transform).toBe('');
    expect(api.scale()).toBe(ZOOM_MIN);
  });

  it('destroy unbinds, so later gestures do nothing', () => {
    const { root, imgs } = buildOverlay();
    api = initPinchZoom(root, { imgSelector: 'img', slideSelector: '.pdp-zoom-slide' });
    api.destroy();

    touch(imgs[0], 'touchstart', pinch(100));
    touch(imgs[0], 'touchmove', pinch(200));

    expect(imgs[0].style.transform).toBe('');
    api = null;
  });
});
