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

  const scrollBehavior = (smooth) => (smooth && !reduced() ? 'smooth' : 'auto');

  // ---- geometry helpers --------------------------------------------------
  // Scroll so slide `i` aligns to the track start. Uses a relative delta so it
  // is direction-agnostic (works in LTR and RTL regardless of scrollLeft sign).
  function scrollToIndex(i, smooth) {
    const slide = slides[i];
    if (!slide) return;
    let delta = 0;
    try {
      delta = slide.getBoundingClientRect().left - root.getBoundingClientRect().left;
    } catch {
      delta = 0;
    }
    if (!delta) return; // nothing to do (or no layout, e.g. jsdom)
    if (typeof root.scrollBy === 'function') {
      root.scrollBy({ left: delta, behavior: scrollBehavior(smooth) });
    } else {
      root.scrollLeft += delta;
    }
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
  let momentumRaf = 0;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;

  function cancelMomentum() {
    if (momentumRaf && caf) caf(momentumRaf);
    momentumRaf = 0;
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // primary button only
    pressed = true;
    dragging = false; // stays a tap until the pointer moves past the threshold
    captured = false;
    startX = lastX = e.clientX;
    lastT = e.timeStamp || Date.now();
    startScroll = root.scrollLeft;
    velocity = 0;
    cancelMomentum();
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
    root.classList.remove('is-dragging');
    if (captured) {
      captured = false;
      try {
        root.releasePointerCapture && root.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    // A plain tap never scrolled or paused — leave it alone so the click lands.
    if (!wasDragging) return;
    applyMomentum();
    if (mode === 'slideshow') play();
  }

  function snapToNearest() {
    goTo(nearestIndex(), true);
  }

  // Glide the scroll position with decaying velocity, then snap to the nearest
  // card. Scroll velocity is the inverse of the pointer velocity.
  function applyMomentum() {
    if (!raf) {
      snapToNearest();
      return;
    }
    let v = -velocity * 16; // px / frame
    const friction = 0.92;
    const step = () => {
      if (Math.abs(v) < 0.5) {
        cancelMomentum();
        snapToNearest();
        return;
      }
      root.scrollLeft += v;
      v *= friction;
      momentumRaf = raf(step);
    };
    if (Math.abs(v) < 0.5) snapToNearest();
    else momentumRaf = raf(step);
  }
  cleanups.push(cancelMomentum);

  on(root, 'pointerdown', onPointerDown);
  on(root, 'pointermove', onPointerMove);
  on(root, 'pointerup', onPointerUp);
  on(root, 'pointercancel', onPointerUp);

  // ---- native scroll → keep dots / index in sync -------------------------
  let scrollRaf = 0;
  function onScroll() {
    if (dragging) return; // drag drives index itself on release
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
    cancelMomentum();
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
    delete root.__carousel;
  }

  const api = { next, prev, goTo, current, pause, play, destroy };
  root.__carousel = api;
  return api;
}
