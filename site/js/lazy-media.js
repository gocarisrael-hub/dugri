// lazy-media.js — deferred loading for pictures inside a HORIZONTAL carousel.
//
// WHY THIS EXISTS. `loading="lazy"` only defers on VERTICAL distance from the
// viewport. A slide scrolled off to the side of a carousel is, as far as the
// browser is concerned, on screen — so every slide of every card loads up front.
// Measured on the shop grid at 390x844 against the owner's real gallery: 20 of
// 20 horizontally-clipped slides were fetched before any interaction, which is
// most of a 26 MB page.
//
// WHAT IT DOES. A deferred <img> holds its `src`/`srcset` in data-* attributes
// and carries none of its own, so the browser has nothing to fetch. A scroll
// listener on the track hydrates the ones that have come near the scrollport.
// `loading="lazy"` is kept on the element, so the two compose: this module owns
// the HORIZONTAL axis and the browser keeps owning the vertical one.
//
// CLONES. The endless-loop rail duplicates its slides with cloneNode, which
// copies attributes but NOT event listeners. So nothing here is a per-image
// listener: hydration reads the live DOM on every pass (a clone is found like any
// other slide), and the error handler is bound ONCE to the track in the CAPTURE
// phase — `error` does not bubble, but it does capture, so a clone's failure
// reaches the same handler its original would.

// Geometry margin for the FIRST pass: nothing beyond the scrollport. Once the
// shopper touches the carousel we widen it, so the next slide is already there by
// the time the swipe lands.
const IDLE_MARGIN = 0;
const ACTIVE_MARGIN = 1.25;
// How much of a slide must actually be inside the scrollport to count as
// visible, in CSS px. Slides in a snap carousel sit flush, so the next one's edge
// lands ON the boundary — and at fractional layout positions (a grid column at
// 163.33 px) it can spill a hundredth of a pixel inside. Without this floor
// roughly half the tiles loaded a second picture nobody could see. One pixel is
// well below anything a person could notice and well above layout rounding.
const MIN_VISIBLE_PX = 1;

/**
 * Make `img` deferred: it renders nothing and requests nothing until hydrate()
 * runs. `fallback` is the URL to fall back to if the deferred source fails.
 *
 * A failing `srcset` candidate does NOT make the browser retry `src` on its own —
 * it just fires `error` — so a fallback has to be applied by hand, and applying it
 * means clearing srcset/sizes as well. See watchTrack's error handler.
 */
export function defer(img, { src, srcset, sizes, fallback } = {}) {
  if (!img || !src) return img;
  img.removeAttribute('src');
  img.removeAttribute('srcset');
  img.dataset.lazySrc = src;
  if (srcset) img.dataset.lazySrcset = srcset;
  if (sizes) img.dataset.lazySizes = sizes;
  if (fallback && fallback !== src) img.dataset.lazyFallback = fallback;
  // The browser still owns the VERTICAL axis once hydrated.
  img.loading = 'lazy';
  img.decoding = 'async';
  return img;
}

/** Whether this <img> is still waiting for its source. */
export function isDeferred(img) {
  return !!(img && img.dataset && img.dataset.lazySrc);
}

/**
 * Give a deferred <img> its source. Idempotent — the data-* attributes are
 * consumed, so a second pass (or a scroll) skips it.
 *
 * `sizes` is set BEFORE `srcset`: the browser resolves the candidate at the
 * moment srcset is assigned, and with no sizes yet it would assume 100vw and
 * pick a rung far larger than the box.
 */
export function hydrate(img) {
  if (!isDeferred(img)) return false;
  const { lazySrc, lazySrcset, lazySizes } = img.dataset;
  delete img.dataset.lazySrc;
  delete img.dataset.lazySrcset;
  delete img.dataset.lazySizes;
  if (lazySizes) img.sizes = lazySizes;
  if (lazySrcset) img.srcset = lazySrcset;
  img.src = lazySrc;
  return true;
}

/**
 * Take an <img> one step down its fallback chain after a load failure. Returns
 * false once the chain is exhausted (the caller may then drop the slide).
 *
 * The chain has TWO steps, because a picture can fail for two different reasons:
 *
 *   1. the DERIVATIVE is unavailable (no Pillow on the host, an undecodable
 *      upload, a swept cache) → fall back to the ORIGINAL upload, which is
 *      already sitting in `src`. All that is needed is to remove `srcset`:
 *      it outranks `src`, so leaving it would have the browser re-resolve
 *      straight back to the candidate that just 404'd. Note the browser does NOT
 *      do this by itself — a failing srcset candidate fires `error` and stops.
 *   2. the ORIGINAL is gone too (an entry in design-images.json whose upload
 *      isn't on this instance) → fall back to the SHIPPED render, when the slot
 *      has one.
 *
 * Each step is taken at most once, so a failing fallback cannot loop.
 */
export function fallback(img) {
  if (!img || !img.dataset) return false;
  // Step 1 — drop the ladder, keep the original already in `src`.
  if (img.getAttribute('srcset')) {
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    return true;
  }
  // Step 2 — the shipped render, if this slot ships one.
  const to = img.dataset.lazyFallback;
  if (!to) return false;
  delete img.dataset.lazyFallback;
  img.src = to;
  return true;
}

/**
 * Watch a horizontal scroll `track` and hydrate its deferred images as they come
 * near the scrollport. Returns a `{ refresh, destroy }` handle.
 *
 * Geometry is read from getBoundingClientRect, never from scrollLeft: RTL
 * browsers disagree on that property's sign, and rects are the same in both.
 */
export function watchTrack(track, opts = {}) {
  if (!track || typeof track.querySelectorAll !== 'function') {
    return { refresh() {}, destroy() {} };
  }
  let margin = IDLE_MARGIN;
  let queued = false;
  let dead = false;
  // Geometry settling. A pass reads rects, and a pass that runs BEFORE the page
  // has settled reads rects that are about to change — mid-settle the slides can
  // be narrower than the track, so several of them appear to be on screen and
  // get hydrated. (Measured: on a 4-column desktop grid, five of six tiles
  // fetched a second picture nobody could see.) A hydration cannot be taken
  // back, so the fix is not to re-run later but to hold off:
  //   • the FIRST visible slide is hydrated straight away — it is what the
  //     shopper is looking at, and delaying it would cost real paint time;
  //   • any ADDITIONAL slide waits for the track's width to repeat across two
  //     passes, i.e. for layout to have stopped moving.
  let lastWidth = -1;
  let settleTries = 0;

  function pass() {
    queued = false;
    if (dead || !track.isConnected) return;
    const imgs = track.querySelectorAll('img[data-lazy-src]');
    if (!imgs.length) return;
    const tr = track.getBoundingClientRect();
    // A zero-width track is not laid out yet (display:none — the zoom overlay
    // before it is opened — or called before the first frame). Hydrating on
    // those numbers would load everything or nothing; wait for a real layout.
    if (tr.width <= 0) return;

    // …and give up waiting eventually, so a permanently animating container
    // still gets its pictures.
    const settled = tr.width === lastWidth || ++settleTries > 4;
    lastWidth = tr.width;
    if (!settled) schedule();

    const pad = tr.width * margin;
    let taken = 0;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      // A slide with no box of its own (a fully collapsed clone) is skipped
      // rather than eagerly hydrated.
      if (r.width <= 0 && r.height <= 0) continue;
      // Must overlap the scrollport by at least MIN_VISIBLE_PX — see the note
      // there. Merely TOUCHING the edge is not being on screen: slides in a snap
      // carousel sit flush, so the next one's edge lands exactly on the boundary.
      const visible =
        r.right > tr.left - pad + MIN_VISIBLE_PX && r.left < tr.right + pad - MIN_VISIBLE_PX;
      if (!visible) continue;
      if (taken > 0 && !settled) break; // the rest wait for a stable layout
      hydrate(img);
      taken++;
    }
  }

  function schedule() {
    if (queued || dead) return;
    queued = true;
    // Bound to `window`: requestAnimationFrame throws "Illegal invocation" when
    // called with a detached receiver, and this ships to in-app browsers.
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(pass);
    } else {
      setTimeout(pass, 16);
    }
  }

  // Any sign the shopper is engaging with this carousel widens the window, so the
  // neighbouring picture is in flight before the swipe finishes.
  function engage() {
    margin = ACTIVE_MARGIN;
    schedule();
  }

  const listeners = [
    ['scroll', schedule, { passive: true }],
    ['pointerdown', engage, { passive: true }],
    ['touchstart', engage, { passive: true }],
    ['keydown', engage, true],
    // The dots / arrows advance the track programmatically; the resulting smooth
    // scroll fires 'scroll', but engaging on the click gets the picture moving a
    // frame earlier.
    ['click', engage, true],
  ];
  for (const [type, fn, o] of listeners) track.addEventListener(type, fn, o);

  // The track's own scroll is not the only thing that changes what is on screen:
  // the PAGE scrolling brings a rail into view, a rotate/resize reflows the grid,
  // and scrollIntoView on a card moves both axes at once. Re-check on those too,
  // so a picture is never left unloaded because the movement happened somewhere
  // other than this element. Every pass is rAF-coalesced, so this is one layout
  // read per frame at most.
  const winListeners = [
    ['scroll', schedule, { passive: true, capture: true }],
    ['resize', schedule, { passive: true }],
    ['orientationchange', schedule, { passive: true }],
  ];
  const win = typeof window !== 'undefined' ? window : null;
  if (win) for (const [type, fn, o] of winListeners) win.addEventListener(type, fn, o);

  // ONE error handler for the whole track, in the CAPTURE phase. `error` does not
  // bubble from <img>, but it does capture — so this catches every slide,
  // including loop CLONES, which cloneNode would never have copied a per-image
  // listener onto.
  function onError(e) {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    if (fallback(img)) return;
    if (typeof opts.onUnrecoverable === 'function') opts.onUnrecoverable(img);
  }
  track.addEventListener('error', onError, true);

  // First pass after layout exists.
  schedule();
  // The rail injects loop clones inside initCarousel, and a caption/price repaint
  // can add cards later; a cheap second pass catches anything that arrived after
  // the first frame without needing a MutationObserver.
  const late = setTimeout(schedule, 0);

  return {
    refresh: schedule,
    destroy() {
      dead = true;
      clearTimeout(late);
      for (const [type, fn, o] of listeners) track.removeEventListener(type, fn, o);
      if (win) for (const [type, fn, o] of winListeners) win.removeEventListener(type, fn, o);
      track.removeEventListener('error', onError, true);
    },
  };
}
