// pinch-zoom.js — photo-app finger zoom for a fullscreen image overlay.
//
// Used by the product page's enlarge overlay (product.html #pdpZoom). That overlay
// shows the gallery photos in a shared carousel, and at rest the BROWSER owns the
// horizontal swipe (native scroll-snap, like every other carousel on the site).
// This module layers zoom on top WITHOUT taking that swipe away:
//
//   * two-finger pinch scales the photo, anchored on the pinch centroid — the
//     detail you pinch toward is the detail you land on
//   * double-tap toggles fit <-> 2.5x at the tapped point. Pinch is unreliable in
//     the Instagram in-app browser (where most of our traffic lands), so pinch is
//     never the ONLY way in — same rule the wizard's zoom overlay follows
//   * once zoomed in, a one-finger drag PANS, clamped so the photo can never be
//     dragged off the screen
//   * back at fit, the module stops intercepting entirely and the native carousel
//     swipe behaves exactly as it did before
//
// Desktop gets the same reach: double-click toggles, ctrl/⌘+wheel (the trackpad
// pinch gesture) scales, and a drag pans while zoomed.
//
// The handover is expressed in CSS, not here: the module toggles `is-zoomed` on
// the root and the page's stylesheet switches the track's touch-action off it —
// the same trick options.html's wizard zoom uses, one level up. carousel.css
// already sets `pan-x pan-y` on every track, which keeps the native swipe while
// EXCLUDING `pinch-zoom`, so iOS pinches the PHOTO and not the whole page; the
// `is-zoomed` rule takes it to `none` so a pan drag can never scroll the carousel
// out from under the finger.

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;

// Scale a double-tap jumps to. Enough to read a card's small print, not so deep
// that the shopper loses their place in the photo.
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 320;
// A pointer that travelled further than this since it went down was a drag, not a
// tap — otherwise panning a zoomed photo reads as a tap and snaps the zoom.
const TAP_MOVE_MAX = 10; // px
// One notch of a trackpad pinch / ctrl+wheel.
const WHEEL_STEP = 1.12;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const centroid = (t) => ({
  x: (t[0].clientX + t[1].clientX) / 2,
  y: (t[0].clientY + t[1].clientY) / 2,
});

const NOOP_API = { reset() {}, scale: () => 1, destroy() {} };

/**
 * Wire finger zoom onto an overlay.
 *
 * While a photo is zoomed the root carries an `is-zoomed` class — the page's CSS
 * hangs the touch-action handover (and the grab cursor) off it.
 *
 * @param {Element} root      the overlay element (the visible viewport)
 * @param {object}  opts
 * @param {string}  [opts.imgSelector]   selector for a zoomable image
 * @param {string}  [opts.slideSelector] selector for the slide wrapping an image
 * @param {(s:number)=>void} [opts.onScale] called after every scale change
 * @returns {{reset:()=>void, scale:()=>number, destroy:()=>void}}
 */
export function initPinchZoom(root, opts = {}) {
  if (!root || typeof root.addEventListener !== 'function') return NOOP_API;

  const imgSelector = opts.imgSelector || 'img';
  const slideSelector = opts.slideSelector || null;

  // --- live gesture state ---
  let target = null; // the <img> currently being zoomed
  let scale = 1;
  let tx = 0;
  let ty = 0;

  let pinchDist = 0; // >0 while a two-finger pinch is in flight
  let pinchScale = 1; // scale when that pinch started
  let panning = false;
  let panX = 0;
  let panY = 0;
  let downX = 0;
  let downY = 0;
  let moved = false; // this touch has travelled past TAP_MOVE_MAX
  let lastTap = 0;

  // The image a gesture landed on. A pinch can start on the slide's letterbox
  // padding rather than the photo itself, so fall back to the slide's image.
  function imgFrom(node) {
    if (!node || typeof node.closest !== 'function') return null;
    const direct = node.closest(imgSelector);
    if (direct) return direct;
    if (!slideSelector) return null;
    const slide = node.closest(slideSelector);
    return slide ? slide.querySelector(imgSelector) : null;
  }

  // Clear the transform off EVERY image in the overlay, not just `target`: the
  // carousel loops by cloning slides, so more than one node can carry a stale
  // transform after a rebuild.
  function clearAll() {
    const imgs = root.querySelectorAll(imgSelector);
    for (const img of imgs) img.style.transform = '';
  }

  function apply() {
    const zoomed = scale > ZOOM_MIN;
    if (target)
      target.style.transform = zoomed ? `translate(${tx}px, ${ty}px) scale(${scale})` : '';
    // The class is the handover: the stylesheet reads it to take the track's
    // touch-action to `none` while zoomed, and back to the native carousel swipe
    // at fit.
    root.classList.toggle('is-zoomed', zoomed);
    if (typeof opts.onScale === 'function') opts.onScale(scale);
  }

  // Keep the photo covering the viewport: pan only as far as its own edges.
  function clampPan() {
    if (!target) return;
    const maxX = Math.max(0, ((target.clientWidth || 0) * scale - (root.clientWidth || 0)) / 2);
    const maxY = Math.max(0, ((target.clientHeight || 0) * scale - (root.clientHeight || 0)) / 2);
    tx = clamp(tx, -maxX, maxX);
    ty = clamp(ty, -maxY, maxY);
  }

  // Scale to `next`, keeping the point (px, py) — the pinch centroid, the tapped
  // pixel, the cursor — pinned under the finger. With transform-origin at the
  // image's centre C, a client point P sits at C + t + (P - C - t) * s'/s after
  // the change, so solving for P staying put gives t' = d - (d - t) * s'/s where
  // d = P - C. Defaults to the photo's current centre (a plain zoom in place).
  function setScale(next, px, py) {
    if (!target) return;
    const s1 = clamp(next, ZOOM_MIN, ZOOM_MAX);
    if (s1 === scale) return;
    const r = target.getBoundingClientRect();
    // r is the TRANSFORMED box, so the untransformed centre is its centre minus t.
    const cx = r.left + r.width / 2 - tx;
    const cy = r.top + r.height / 2 - ty;
    const dx = typeof px === 'number' ? px - cx : tx;
    const dy = typeof py === 'number' ? py - cy : ty;
    const k = s1 / scale;
    tx = dx - (dx - tx) * k;
    ty = dy - (dy - ty) * k;
    scale = s1;
    if (scale === ZOOM_MIN) {
      tx = 0;
      ty = 0;
    } else {
      clampPan();
    }
    apply();
  }

  // Point a gesture at an image. Switching images (the shopper swiped) drops the
  // previous zoom, so every photo opens at fit.
  function setTarget(img) {
    if (!img || img === target) return;
    clearAll();
    target = img;
    scale = 1;
    tx = 0;
    ty = 0;
  }

  function toggleAt(px, py) {
    if (scale > ZOOM_MIN) reset();
    else setScale(DOUBLE_TAP_SCALE, px, py);
  }

  function reset() {
    scale = 1;
    tx = 0;
    ty = 0;
    pinchDist = 0;
    panning = false;
    lastTap = 0;
    clearAll();
    target = null;
    root.classList.remove('is-zoomed');
    if (typeof opts.onScale === 'function') opts.onScale(scale);
  }

  // ---- touch ----
  function onTouchStart(e) {
    const t = e.touches;
    if (!t) return;
    if (t.length >= 2) {
      setTarget(imgFrom(e.target));
      if (!target) return;
      pinchDist = dist(t);
      pinchScale = scale;
      panning = false;
      moved = true; // a pinch is never a tap
      return;
    }
    if (t.length === 1) {
      downX = panX = t[0].clientX;
      downY = panY = t[0].clientY;
      moved = false;
      // Only claim the drag when there is something to pan. At fit we stay out of
      // the way entirely so the native carousel swipe is untouched.
      panning = scale > ZOOM_MIN && !!target;
    }
  }

  function onTouchMove(e) {
    const t = e.touches;
    if (!t) return;
    if (t.length >= 2 && pinchDist > 0 && target) {
      // cancelable is false once the browser has already committed to a scroll —
      // preventing then is a no-op that only logs a console warning.
      if (e.cancelable) e.preventDefault();
      const c = centroid(t);
      setScale(pinchScale * (dist(t) / pinchDist), c.x, c.y);
      return;
    }
    if (t.length !== 1) return;
    const x = t[0].clientX;
    const y = t[0].clientY;
    if (Math.hypot(x - downX, y - downY) > TAP_MOVE_MAX) moved = true;
    if (!panning || scale <= ZOOM_MIN || !target) return;
    if (e.cancelable) e.preventDefault();
    tx += x - panX;
    ty += y - panY;
    panX = x;
    panY = y;
    clampPan();
    apply();
  }

  function onTouchEnd(e) {
    const remaining = e.touches ? e.touches.length : 0;
    const wasPinch = pinchDist > 0;
    if (remaining > 0) {
      // Fingers still down (one lifted out of a pinch) — end the gesture but don't
      // let the leftover finger be read as a tap.
      pinchDist = 0;
      panning = false;
      moved = true;
      return;
    }
    pinchDist = 0;
    panning = false;
    if (wasPinch || moved) {
      lastTap = 0;
      return;
    }
    const img = imgFrom(e.target);
    if (!img) {
      lastTap = 0;
      return;
    }
    const now = Date.now();
    if (now - lastTap < DOUBLE_TAP_MS) {
      // Swallow the synthetic click/dblclick this tap would otherwise produce, so
      // the toggle doesn't fire twice (and the backdrop handler stays out of it).
      if (e.cancelable) e.preventDefault();
      const pt = e.changedTouches && e.changedTouches[0];
      setTarget(img);
      toggleAt(pt && pt.clientX, pt && pt.clientY);
      lastTap = 0;
    } else {
      lastTap = now;
    }
  }

  // ---- mouse / trackpad ----
  function onDblClick(e) {
    const img = imgFrom(e.target);
    if (!img) return;
    setTarget(img);
    toggleAt(e.clientX, e.clientY);
  }

  // ctrl/⌘+wheel is what a trackpad pinch reports as.
  function onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    const img = imgFrom(e.target);
    if (!img) return;
    if (e.cancelable) e.preventDefault();
    setTarget(img);
    setScale(scale * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP), e.clientX, e.clientY);
  }

  let dragging = false;
  function onMouseDown(e) {
    if (scale <= ZOOM_MIN || !target) return;
    dragging = true;
    panX = e.clientX;
    panY = e.clientY;
    e.preventDefault(); // no text/image drag-select while panning
  }
  function onMouseMove(e) {
    if (!dragging || !target) return;
    tx += e.clientX - panX;
    ty += e.clientY - panY;
    panX = e.clientX;
    panY = e.clientY;
    clampPan();
    apply();
  }
  function onMouseUp() {
    dragging = false;
  }

  root.addEventListener('touchstart', onTouchStart, { passive: true });
  root.addEventListener('touchmove', onTouchMove, { passive: false });
  root.addEventListener('touchend', onTouchEnd, { passive: false });
  root.addEventListener('touchcancel', reset, { passive: true });
  root.addEventListener('dblclick', onDblClick);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('mousedown', onMouseDown);
  // Pan tracking on the window so a fast drag that leaves the photo still follows.
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  return {
    reset,
    scale: () => scale,
    destroy() {
      reset();
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      root.removeEventListener('touchcancel', reset);
      root.removeEventListener('dblclick', onDblClick);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    },
  };
}
