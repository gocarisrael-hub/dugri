// carousel.js — one dependency-free, RTL-aware carousel engine for the dugri
// homepage. It powers three surfaces from the same code:
//   • 'slideshow' — full-bleed hero, one slide at a time, auto-advances.
//   • 'scroller'  — free-swipe product / reviews rail that shows a peek of the
//                   next card (card width is the PAGE's job via CSS, never ours).
//
// Both modes are built on a native horizontal scroll-snap track, so wheel /
// trackpad / native momentum come for free; on top we add pointer-drag with
// inertia + snap, keyboard, dots and optional arrows. The module NEVER sets a
// card width and NEVER restyles anything global — it only wires behaviour and
// renders its own controls. Import it anywhere: a missing / empty root no-ops.
//
// Public API (returned by initCarousel):
//   { next(), prev(), goTo(i), current(), pause(), play(), destroy() }
//
// RTL: the site is dir="rtl". "next" always means the *later* slide (index+1);
// the physical scroll direction is derived from live geometry
// (getBoundingClientRect deltas), so it is correct in both LTR and RTL and
// across every browser's scrollLeft sign convention. Keyboard arrows are mapped
// visually (in RTL, ArrowLeft advances, ArrowRight goes back).

// ---- release-target math (pure, exported, unit-tested) -------------------
// Decide which card a released drag should settle on, in ONE decision: the
// nearest card PLUS a light velocity nudge capped to at most one card beyond it.
// Coordinates are position-space: `scrollLeft`/`cardWidth` describe the current
// position (their ratio is the fractional index) and `velocity` is signed so
// that positive means motion toward a HIGHER index. The fling is projected a
// short fixed time (PROJECT_MS) and the nudge is clamped to ±1 so a flick never
// overshoots. Returns a clamped integer index in [0, count-1].
const PROJECT_MS = 90; // how far a flick is "thrown" before it must settle
export function releaseTargetIndex({ scrollLeft, cardWidth, count, velocity }) {
  const c = Number.isFinite(count) ? Math.floor(count) : 0;
  if (c < 1) return 0;
  const cw = Number.isFinite(cardWidth) && cardWidth > 0 ? cardWidth : 1;
  const nearest = Math.round((Number(scrollLeft) || 0) / cw);
  const projectedCards = ((Number(velocity) || 0) * PROJECT_MS) / cw;
  let nudge = Math.round(projectedCards);
  if (nudge > 1) nudge = 1;
  else if (nudge < -1) nudge = -1;
  const target = nearest + nudge;
  return Math.max(0, Math.min(c - 1, target));
}

// A `cubic-bezier(p1x,p1y,p2x,p2y)` easing evaluator (Newton-Raphson on x→t,
// then bezier y). Mirrors the CSS `--ease` token so JS glides feel identical to
// the CSS transitions. Returns fn(x∈[0,1]) → eased y.
function cubicBezier(p1x, p1y, p2x, p2y) {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const fx = (t) => ((ax * t + bx) * t + cx) * t;
  const fy = (t) => ((ay * t + by) * t + cy) * t;
  const dfx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 5; i++) {
      const err = fx(t) - x;
      if (Math.abs(err) < 1e-4) break;
      const d = dfx(t) || 1e-6;
      t -= err / d;
    }
    return fy(t);
  };
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

  // ---- JS-animated scroll (replaces native scroll-behavior:smooth) -------
  // Every advance / release runs through ONE rAF tween of scrollLeft with a
  // fixed ~260ms duration and the site's --ease curve. No native smooth scroll,
  // no friction-coast; a single motion into the target card.
  const GLIDE_MS = 260;
  const ease = cubicBezier(0.2, 0.7, 0.2, 1);
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;
  const perf =
    typeof window !== 'undefined' && window.performance && window.performance.now
      ? window.performance
      : null;
  const nowMs = () => (perf ? perf.now() : Date.now());

  let animRaf = 0;
  let animating = false;
  function cancelAnim() {
    if (animRaf && caf) caf(animRaf);
    animRaf = 0;
    animating = false;
  }

  // Tween root.scrollLeft to an absolute target. Cancels any in-flight tween.
  // duration<=0 / reduced-motion / no rAF / negligible distance → jump instantly.
  // Always calls onDone once the position has settled.
  function animateScrollTo(el, targetLeft, duration, onDone) {
    cancelAnim();
    const start = el.scrollLeft;
    const dist = targetLeft - start;
    if (!raf || duration <= 0 || reduced() || Math.abs(dist) < 0.5) {
      el.scrollLeft = targetLeft;
      if (onDone) onDone();
      return;
    }
    animating = true;
    const t0 = nowMs();
    const frame = (now) => {
      const elapsed = (now || nowMs()) - t0;
      const t = Math.min(1, elapsed / duration);
      el.scrollLeft = start + dist * ease(t);
      if (t < 1) {
        animRaf = raf(frame);
      } else {
        animRaf = 0;
        animating = false;
        if (onDone) onDone();
      }
    };
    animRaf = raf(frame);
  }

  // ---- geometry helpers --------------------------------------------------
  // Scroll so slide `i` aligns to the track start. Uses a relative delta so it
  // is direction-agnostic (works in LTR and RTL regardless of scrollLeft sign),
  // resolved to an absolute target and glided via animateScrollTo.
  function scrollToIndex(i, smooth, onDone) {
    const slide = slides[i];
    if (!slide) {
      if (onDone) onDone();
      return;
    }
    let delta = 0;
    try {
      delta = slide.getBoundingClientRect().left - root.getBoundingClientRect().left;
    } catch {
      delta = 0;
    }
    if (!delta) {
      // nothing to do (or no layout, e.g. jsdom) — still settle any release.
      if (onDone) onDone();
      return;
    }
    const duration = smooth && !reduced() ? GLIDE_MS : 0;
    animateScrollTo(root, root.scrollLeft + delta, duration, onDone);
  }

  // The slide whose start is nearest the track start — the "snapped" card.
  function nearestIndex() {
    let best = index;
    let bestD = Infinity;
    let trLeft = 0;
    try {
      trLeft = root.getBoundingClientRect().left;
    } catch {
      return index;
    }
    slides.forEach((s, i) => {
      const d = Math.abs(s.getBoundingClientRect().left - trLeft);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
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
    scrollToIndex(index, smooth);
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

  // ---- pointer drag with inertia + snap ----------------------------------
  // A press only becomes a drag once the pointer moves past DRAG_THRESHOLD px.
  // Until then it stays a tap: we do NOT capture the pointer, so a click on a
  // child link/button inside the track still fires and navigates. (Capturing on
  // pointerdown retargets the synthesized click to the track and swallows it.)
  const DRAG_THRESHOLD = 6;
  let pressed = false; // pointer is down inside the track
  let captured = false; // we've taken pointer capture for an active drag
  let dragging = false; // the press has been promoted to a drag
  let startX = 0;
  let startScroll = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0; // pointer px / ms

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // primary button only
    pressed = true;
    dragging = false; // stays a tap until the pointer moves past the threshold
    captured = false;
    startX = lastX = e.clientX;
    lastT = e.timeStamp || Date.now();
    startScroll = root.scrollLeft;
    velocity = 0;
    cancelAnim(); // touch-down kills any in-flight glide so the finger owns it
  }
  function onPointerMove(e) {
    if (!pressed) return;
    const x = e.clientX;
    if (!dragging) {
      // Not a drag yet — ignore tiny jitter so a tap can still click through.
      if (Math.abs(x - startX) < DRAG_THRESHOLD) return;
      // Promote to a real drag: now it's safe to pause + capture the pointer.
      dragging = true;
      if (mode === 'slideshow') pause();
      root.classList.add('is-dragging');
      try {
        if (root.setPointerCapture) {
          root.setPointerCapture(e.pointerId);
          captured = true;
        }
      } catch {
        /* not supported */
      }
    }
    // 1:1 drag: moving the pointer right reveals the previous card.
    root.scrollLeft = startScroll - (x - startX);
    const now = e.timeStamp || Date.now();
    const dt = now - lastT || 16;
    velocity = (x - lastX) / dt;
    lastX = x;
    lastT = now;
  }
  function onPointerUp(e) {
    if (!pressed) return;
    pressed = false;
    const wasDragging = dragging;
    dragging = false;
    if (captured) {
      captured = false;
      try {
        root.releasePointerCapture && root.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    // A plain tap never scrolled or paused — leave it alone so the click lands.
    if (!wasDragging) {
      root.classList.remove('is-dragging');
      return;
    }
    // Keep 'is-dragging' on through the glide: it holds CSS scroll-snap OFF so
    // the browser's snap engine can't fight our JS tween. endDrag() (fired when
    // the single glide settles) clears it once we've aligned to the target card.
    releaseGlide();
    if (mode === 'slideshow') play();
  }

  function endDrag() {
    root.classList.remove('is-dragging');
  }

  // ONE decision on release: pick the target card (nearest + a capped velocity
  // nudge) via the pure releaseTargetIndex(), then a single glide into it. No
  // friction coast, no second smooth-scroll — one motion, light momentum.
  function computeReleaseTarget() {
    // Geometry-based fractional position at the track start: RTL-agnostic and
    // monotonically increasing with index, so it feeds the pure math cleanly.
    let frac = index;
    let stepDelta = 0;
    try {
      const trLeft = root.getBoundingClientRect().left;
      const l0 = slides[0].getBoundingClientRect().left;
      const l1 = slides[1] ? slides[1].getBoundingClientRect().left : null;
      stepDelta = l1 != null ? l1 - l0 : 0;
      if (!stepDelta) return nearestIndex(); // 1 slide / no layout → no nudge
      frac = -(l0 - trLeft) / stepDelta;
    } catch {
      return nearestIndex();
    }
    // Pointer px/ms → index units/ms, signed so positive = toward higher index.
    // Drag maps scrollLeft = startScroll-(x-startX) ⇒ d(frac)/dt = -velocity/stepDelta.
    const vIndex = -velocity / stepDelta;
    return releaseTargetIndex({ scrollLeft: frac, cardWidth: 1, count: n, velocity: vIndex });
  }

  function releaseGlide() {
    const target = computeReleaseTarget();
    index = loop ? ((target % n) + n) % n : Math.max(0, Math.min(n - 1, target));
    updateControls();
    scrollToIndex(index, true, endDrag);
  }
  cleanups.push(cancelAnim);

  on(root, 'pointerdown', onPointerDown);
  on(root, 'pointermove', onPointerMove);
  on(root, 'pointerup', onPointerUp);
  on(root, 'pointercancel', onPointerUp);

  // ---- native scroll → keep dots / index in sync -------------------------
  let scrollRaf = 0;
  function onScroll() {
    if (dragging || animating) return; // drag / JS glide drive index themselves
    if (scrollRaf && caf) caf(scrollRaf);
    const commit = () => {
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
  // Mode class lets the CSS pick the right snap feel: a slideshow snaps hard
  // (one slide at a time), a scroller snaps loosely so a fling can glide across
  // several cards before settling.
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
    cancelAnim();
    if (scrollRaf && caf) caf(scrollRaf);
    while (cleanups.length) {
      try {
        cleanups.pop()();
      } catch {
        /* keep tearing down */
      }
    }
    if (addedTabindex) root.removeAttribute('tabindex');
    root.classList.remove('is-dragging');
    root.classList.remove(modeClass);
    delete root.__carousel;
  }

  const api = { next, prev, goTo, current, pause, play, destroy };
  root.__carousel = api;
  return api;
}
