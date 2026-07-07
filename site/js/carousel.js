// carousel.js — dependency-free, RTL-aware carousel engine for the dugri site.
// Two surfaces from one module, both on a NATIVE horizontal scroll track (the
// browser owns touch, so swiping is 100% reliable — the module never intercepts
// the finger):
//   • 'scroller'  — free-glide product / reviews rail (NO snap) with a "turbo"
//                   momentum extender that adds decaying scroll ON TOP of the
//                   phone's own fling after the finger lifts, so the rail travels
//                   faster / further. Card width is the PAGE's job via CSS.
//   • 'slideshow' — full-bleed hero, one slide at a time, native scroll-snap
//                   (x mandatory), auto-advances on a timer.
//
// Nothing here calls preventDefault or captures the pointer: every listener is
// passive, so the native scroll / fling is never fought. Advances (dots, arrows,
// autoplay) use slide.scrollIntoView({inline:'start'}), which is RTL-safe with no
// scrollLeft-sign math. The module NEVER sets a card width and NEVER restyles
// anything global — it only wires behaviour and renders its own controls. Import
// it anywhere: a missing / empty root no-ops.
//
// Public API (returned by initCarousel):
//   { next(), prev(), goTo(i), current(), pause(), play(), destroy() }
//
// RTL: the site is dir="rtl". "next" always means the *later* slide (index+1).
// Advances are geometry-free (scrollIntoView) and dot-sync uses relative center
// distances, so both are correct in LTR and RTL across every browser's
// scrollLeft sign convention. Keyboard arrows are mapped visually (in RTL,
// ArrowLeft advances, ArrowRight goes back).

// ---- pure helpers (exported, unit-tested) --------------------------------

// Index of the card whose center is nearest `railCenter`. `centers` is the list
// of card center coordinates (any axis, any sign) and `railCenter` the track's
// center. Uses only relative distances, so it is direction-agnostic — correct in
// both LTR and RTL. Returns 0 for an empty / invalid list.
export function nearestByCenter(centers, railCenter) {
  if (!Array.isArray(centers) || centers.length === 0) return 0;
  const target = Number(railCenter) || 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const d = Math.abs((Number(centers[i]) || 0) - target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Turbo momentum: map a release velocity (px/ms, signed) to the INITIAL per-frame
// boost distance added on top of the native fling. Below TURBO_THRESHOLD the
// gesture is a tap / slow drag → no boost (returns 0). Above it, scale by
// TURBO_GAIN (0.7 × a ~16ms frame). Sign is preserved so it is direction-agnostic.
export const TURBO_THRESHOLD = 0.25; // px/ms — below this, no boost
export const TURBO_GAIN = 0.7 * 16; // velocity → initial per-frame px
export function turboBoostPx(velocity) {
  const v = Number(velocity) || 0;
  if (Math.abs(v) < TURBO_THRESHOLD) return 0;
  return v * TURBO_GAIN;
}

/** A safe no-op API, returned for a missing / empty / already-torn-down root. */
function noopApi() {
  const noop = () => {};
  return {
    next: noop,
    prev: noop,
    goTo: noop,
    current: () => -1,
    pause: noop,
    play: noop,
    destroy: noop,
  };
}

/**
 * Wire a carousel on `root` (the scroll container; its direct children are the
 * slides/cards). Returns an imperative API. Idempotent: a second call on the
 * same root returns the first instance instead of double-initialising.
 *
 * @param {Element} root
 * @param {object} [opts]
 * @param {'scroller'|'slideshow'} [opts.mode='scroller']
 * @param {number}  [opts.interval=5000]  slideshow auto-advance ms
 * @param {boolean} [opts.autoplay=true]  slideshow only: auto-advance on a timer
 * @param {boolean} [opts.loop]           default: true for slideshow, false for scroller
 * @param {boolean} [opts.dots=true]
 * @param {boolean} [opts.arrows]         default: true for slideshow, false for scroller
 * @param {Element} [opts.dotsInto]       render dots into this element (else after root)
 * @param {Element} [opts.arrowsInto]     render arrows into this element (else after root)
 */
export function initCarousel(root, opts = {}) {
  // ---- guards ------------------------------------------------------------
  if (!root || !root.children || root.children.length === 0) return noopApi();
  if (root.__carousel) return root.__carousel; // idempotent

  const mode = opts.mode === 'slideshow' ? 'slideshow' : 'scroller';
  const interval = Number.isFinite(opts.interval) ? opts.interval : 5000;
  const autoplay = opts.autoplay !== false; // slideshow auto-advance (scroller never plays)
  const loop = opts.loop != null ? !!opts.loop : mode === 'slideshow';
  const showDots = opts.dots !== false;
  const showArrows = opts.arrows != null ? !!opts.arrows : mode === 'slideshow';

  const slides = Array.from(root.children);
  const n = slides.length;

  let index = 0; // current logical slide
  const cleanups = []; // teardown thunks
  const on = (el, type, fn, o) => {
    if (!el) return;
    el.addEventListener(type, fn, o);
    cleanups.push(() => el.removeEventListener(type, fn, o));
  };

  // ---- environment probes (all feature-detected for jsdom safety) --------
  const mq =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  const reduced = () => !!(mq && mq.matches);

  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;
  const perf =
    typeof window !== 'undefined' && window.performance && window.performance.now
      ? window.performance
      : null;
  const nowMs = () => (perf ? perf.now() : Date.now());

  const isRTL = () => {
    try {
      if (getComputedStyle(root).direction === 'rtl') return true;
    } catch {
      /* jsdom / detached node */
    }
    const dirEl = root.closest && root.closest('[dir]');
    const dir = (dirEl && dirEl.getAttribute('dir')) || (document && document.dir) || '';
    return dir.toLowerCase() === 'rtl';
  };

  // ---- advance (native, RTL-safe) ----------------------------------------
  // Bring slide `i` to the track start via scrollIntoView. inline:'start' aligns
  // horizontally with no scrollLeft-sign math (correct in LTR and RTL);
  // block:'nearest' never scrolls the page vertically. Smooth unless reduced
  // motion is on (then it jumps instantly).
  function advanceTo(i, smooth) {
    const slide = slides[i];
    if (!slide || typeof slide.scrollIntoView !== 'function') return;
    const behavior = smooth && !reduced() ? 'smooth' : 'auto';
    try {
      slide.scrollIntoView({ behavior, inline: 'start', block: 'nearest' });
    } catch {
      // Older engines reject the options object — fall back to the boolean form.
      try {
        slide.scrollIntoView(false);
      } catch {
        /* jsdom / unsupported — index state still tracks the logical slide */
      }
    }
  }

  // The card whose center is nearest the track center — the visually-dominant
  // card, used to keep dots / index in sync with a native scroll. Geometry is
  // guarded: with no layout (jsdom) it holds the current index.
  function nearestIndex() {
    try {
      const rr = root.getBoundingClientRect();
      const railCenter = rr.left + rr.width / 2;
      const centers = slides.map((s) => {
        const r = s.getBoundingClientRect();
        return r.left + r.width / 2;
      });
      // All-zero rects (jsdom / detached) → every center is 0; keep index.
      if (rr.width === 0) return index;
      return nearestByCenter(centers, railCenter);
    } catch {
      return index;
    }
  }

  // ---- controls (dots + arrows) ------------------------------------------
  let dotsWrap = null;
  const dotBtns = [];
  let prevBtn = null;
  let nextBtn = null;

  function placeControl(el, into) {
    if (into) {
      into.appendChild(el);
    } else if (root.parentNode) {
      root.parentNode.insertBefore(el, root.nextSibling);
    }
  }

  if (showDots) {
    dotsWrap = document.createElement('div');
    dotsWrap.className = 'carousel-dots';
    dotsWrap.setAttribute('role', 'group');
    dotsWrap.setAttribute('aria-label', 'ניווט בין שקופיות');
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'carousel-dot';
      b.setAttribute('aria-label', `מעבר לשקופית ${i + 1}`);
      on(b, 'click', () => goTo(i));
      dotsWrap.appendChild(b);
      dotBtns.push(b);
    }
    placeControl(dotsWrap, opts.dotsInto);
    cleanups.push(() => dotsWrap.remove());
  }

  if (showArrows) {
    const arrowsWrap = opts.arrowsInto || null;
    const makeArrow = (dir, label, glyph) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `carousel-arrow carousel-arrow--${dir}`;
      b.setAttribute('aria-label', label);
      b.innerHTML = `<span aria-hidden="true">${glyph}</span>`;
      placeControl(b, arrowsWrap);
      cleanups.push(() => b.remove());
      return b;
    };
    prevBtn = makeArrow('prev', 'הקודם', '›'); // visual: prev points toward start (RTL: right)
    nextBtn = makeArrow('next', 'הבא', '‹');
    on(prevBtn, 'click', prev);
    on(nextBtn, 'click', next);
  }

  function updateControls() {
    for (let i = 0; i < dotBtns.length; i++) {
      const active = i === index;
      dotBtns[i].classList.toggle('is-active', active);
      if (active) dotBtns[i].setAttribute('aria-current', 'true');
      else dotBtns[i].removeAttribute('aria-current');
    }
    if (!loop) {
      if (prevBtn) prevBtn.disabled = index <= 0;
      if (nextBtn) nextBtn.disabled = index >= n - 1;
    }
  }

  // ---- imperative API ----------------------------------------------------
  function goTo(i, smooth = true) {
    if (n === 0) return;
    index = loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    updateControls();
    advanceTo(index, smooth);
  }
  function next() {
    goTo(index + 1);
  }
  function prev() {
    goTo(index - 1);
  }
  function current() {
    return index;
  }

  // ---- slideshow auto-advance -------------------------------------------
  let timer = null;
  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  function play() {
    if (mode !== 'slideshow' || !autoplay || reduced() || n < 2) return;
    stopTimer();
    timer = setInterval(next, interval);
  }
  function pause() {
    stopTimer();
  }
  cleanups.push(stopTimer);

  // ---- turbo momentum extender (scroller only) ---------------------------
  // After the finger lifts, add decaying scrollLeft ON TOP of the native fling so
  // the rail travels faster / further. Passive throughout — never preventDefault,
  // never capture — so the native touch scroll is never fought. Direction-agnostic
  // (relative scrollLeft deltas → correct in RTL). No-op under reduced motion.
  if (mode === 'scroller') {
    let last = root.scrollLeft;
    let lastT = nowMs();
    let vel = 0; // px/ms, signed
    let down = false;
    let boostRaf = 0;

    const stopBoost = () => {
      if (boostRaf && caf) caf(boostRaf);
      boostRaf = 0;
    };
    const onTurboScroll = () => {
      const t = nowMs();
      const dt = t - lastT;
      if (dt > 0) vel = (root.scrollLeft - last) / dt;
      last = root.scrollLeft;
      lastT = t;
    };
    const onTurboDown = () => {
      down = true;
      stopBoost(); // touch-down kills any in-flight boost so the finger owns it
    };
    const onTurboCancel = () => {
      down = false;
    };
    const onTurboUp = () => {
      down = false;
      if (reduced() || !raf) return; // no boost under reduced motion / no rAF
      let px = turboBoostPx(vel);
      if (px === 0) return; // tap / slow drag → no boost
      const friction = 0.955;
      const step = () => {
        if (down || Math.abs(px) < 0.4) {
          boostRaf = 0;
          return;
        }
        root.scrollLeft += px;
        px *= friction;
        boostRaf = raf(step);
      };
      step();
    };

    on(root, 'scroll', onTurboScroll, { passive: true });
    on(root, 'pointerdown', onTurboDown, { passive: true });
    on(root, 'pointercancel', onTurboCancel, { passive: true });
    on(root, 'pointerup', onTurboUp, { passive: true });
    cleanups.push(stopBoost);
  }

  // ---- native scroll → keep dots / index in sync -------------------------
  // rAF-throttled, passive: recompute the nearest-by-center card and move the
  // active dot. Never touches scrollLeft, so it can't fight the native scroll.
  let scrollRaf = 0;
  function onScroll() {
    if (scrollRaf && caf) caf(scrollRaf);
    const commit = () => {
      scrollRaf = 0;
      const i = nearestIndex();
      if (i !== index) {
        index = i;
        updateControls();
      }
    };
    scrollRaf = raf ? raf(commit) : (commit(), 0);
  }
  on(root, 'scroll', onScroll, { passive: true });

  // ---- keyboard (visual mapping, RTL-aware) ------------------------------
  function onKey(e) {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      isRTL() ? prev() : next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      isRTL() ? next() : prev();
    }
  }
  on(root, 'keydown', onKey);

  // Make the scroll region keyboard-focusable if the page didn't already.
  let addedTabindex = false;
  if (!root.hasAttribute('tabindex')) {
    root.setAttribute('tabindex', '0');
    addedTabindex = true;
  }

  // ---- slideshow: pause on hover / focus, resume on leave ----------------
  if (mode === 'slideshow') {
    on(root, 'mouseenter', pause);
    on(root, 'mouseleave', play);
    on(root, 'focusin', pause);
    on(root, 'focusout', play);
  }

  // React to a live reduced-motion toggle.
  const onMotion = () => {
    if (mode !== 'slideshow') return;
    if (reduced()) pause();
    else play();
  };
  if (mq && mq.addEventListener) {
    mq.addEventListener('change', onMotion);
    cleanups.push(() => mq.removeEventListener('change', onMotion));
  }

  // ---- ARIA + base classes ----------------------------------------------
  root.setAttribute('role', 'group');
  root.setAttribute('aria-roledescription', 'carousel');
  if (!root.classList.contains('carousel-track')) root.classList.add('carousel-track');
  // Mode class lets the CSS pick the right feel: a slideshow snaps hard (one slide
  // at a time, scroll-snap x mandatory); a scroller free-glides (scroll-snap none)
  // and gets the JS turbo momentum on top.
  const modeClass = mode === 'slideshow' ? 'carousel--slideshow' : 'carousel--scroller';
  root.classList.add(modeClass);
  const slideClass = mode === 'scroller' ? 'carousel-card' : 'carousel-slide';
  slides.forEach((s, i) => {
    s.setAttribute('role', 'group');
    s.setAttribute('aria-roledescription', 'slide');
    const label = (s.dataset && s.dataset.label) || `שקופית ${i + 1} מתוך ${n}`;
    s.setAttribute('aria-label', label);
    if (!s.classList.contains('carousel-slide') && !s.classList.contains('carousel-card')) {
      s.classList.add(slideClass);
    }
  });

  // ---- go live -----------------------------------------------------------
  updateControls();
  if (mode === 'slideshow') play();

  function destroy() {
    pause();
    if (scrollRaf && caf) caf(scrollRaf);
    while (cleanups.length) {
      try {
        cleanups.pop()();
      } catch {
        /* keep tearing down */
      }
    }
    if (addedTabindex) root.removeAttribute('tabindex');
    root.classList.remove(modeClass);
    delete root.__carousel;
  }

  const api = { next, prev, goTo, current, pause, play, destroy };
  root.__carousel = api;
  return api;
}
