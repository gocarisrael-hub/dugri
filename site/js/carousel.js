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

// Real slide index behind a cloned-carousel child. For the seamless loop the real
// set is cloned on both sides, so DOM children run [prepend clones][real][append
// clones]; `prepend` is how many clone slides precede the real set. This maps any
// child's position back to its 0..n-1 real index, so a clone lights the SAME dot
// as its original. Guards a non-positive count → 0.
export function realIndexFromClonedIndex(childIndex, n, prepend) {
  const count = Math.trunc(n);
  if (!(count > 0)) return 0;
  const p = Math.trunc(prepend) || 0;
  return (((Math.trunc(childIndex) - p) % count) + count) % count;
}

// How many whole "periods" the track must silently jump so a drifting offset `d`
// (the first real slide's physical distance from the track start) returns to the
// home band (−period, period). The loop scrolls by k·period onto pixel-identical
// clones, so the jump is invisible. Direction-agnostic: it works on a relative
// physical offset, so it is correct for either RTL scrollLeft-sign convention.
export function loopJumpCount(d, period) {
  if (!(period > 0) || !Number.isFinite(d)) return 0;
  return -Math.trunc(d / period) || 0; // `|| 0` normalises −0 → 0
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

  let index = 0; // current logical slide (real 0..n-1)
  const cleanups = []; // teardown thunks

  // ---- endless-loop state (clones; activated only once real layout exists) ---
  // Endless-loop clones only when the caller opted in (loop:true) AND there are ≥2
  // slides. A loop:false carousel (e.g. the PDP photo gallery) must NEVER be cloned:
  // cloning it into a looped-but-clamped state on a snap track makes the image
  // flicker. Honor the flag.
  const canLoop = loop && n >= 2;
  let loopActive = false; // true once clones are in place
  const cloneNodes = []; // every injected clone (removed on destroy)
  let appendRef = null; // first append clone (copy of slide 0) — the period anchor
  let recenterTimer = null; // debounce for the slideshow's idle recenter
  const shiftAdjusters = []; // notified of a programmatic scrollLeft jump (turbo baseline)
  const pinnedBg = []; // [node, priorInlineBg] — restored on destroy
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

  // ---- advance (PASSIVE, horizontal-only, RTL-safe, loop-aware) -----------
  // Scroll only the TRACK, horizontally, so the DOM node for real slide `i` aligns
  // to the track start. Uses a relative delta (node.left − track.left) fed to
  // root.scrollBy({left}) — the page's VERTICAL scroll is never touched. (The old
  // scrollIntoView pulled the whole window back up to the hero when autoplay fired
  // after the user had scrolled down.) The delta is RTL-safe: scrollBy({left:delta})
  // shifts every child's physical .left by −delta in both LTR and RTL, so no
  // scrollLeft-sign math is needed. With the loop on, the copy of slide `i` nearest
  // the viewport is chosen, so last→first hops FORWARD into a clone (seamless)
  // instead of rewinding across every slide. jsdom (no layout) no-ops but keeps the
  // index state.
  function advanceTo(i, smooth) {
    let rootRect;
    try {
      rootRect = root.getBoundingClientRect();
    } catch {
      return; // detached — index state still tracks the logical slide
    }
    if (!rootRect || rootRect.width === 0) return; // jsdom / no layout
    const node = pickNode(i);
    if (!node || typeof node.getBoundingClientRect !== 'function') return;
    let nodeRect;
    try {
      nodeRect = node.getBoundingClientRect();
    } catch {
      return;
    }
    const delta = nodeRect.left - rootRect.left;
    const behavior = smooth && !reduced() ? 'smooth' : 'auto';
    try {
      root.scrollBy({ left: delta, behavior });
    } catch {
      // Older engines reject the options object — fall back to a direct horizontal
      // set (still horizontal-only, so it never scrolls the page vertically).
      try {
        root.scrollLeft += delta;
      } catch {
        /* jsdom / unsupported — index state still tracks the logical slide */
      }
    }
  }

  // The DOM node for real slide `i` whose start is nearest the track start —
  // the original or (with the loop on) whichever clone is closest, so every
  // advance is a short seamless hop. Without clones this is just slides[i]; in
  // jsdom every rect is 0 so the first match (the original) wins.
  function pickNode(i) {
    let rootLeft = 0;
    try {
      rootLeft = root.getBoundingClientRect().left;
    } catch {
      /* jsdom */
    }
    let best = null;
    let bestD = Infinity;
    for (const node of root.children) {
      if (node.__carouselIndex !== i) continue;
      let l = 0;
      try {
        l = node.getBoundingClientRect().left;
      } catch {
        /* jsdom */
      }
      const d = Math.abs(l - rootLeft);
      if (best === null || d < bestD) {
        bestD = d;
        best = node;
      }
    }
    return best || slides[i] || null;
  }

  // The card whose center is nearest the track center — the visually-dominant
  // card, used to keep dots / index in sync with a native scroll. Geometry is
  // guarded: with no layout (jsdom) it holds the current index.
  function nearestIndex() {
    try {
      const rr = root.getBoundingClientRect();
      // All-zero rects (jsdom / detached) → keep index.
      if (rr.width === 0) return index;
      const railCenter = rr.left + rr.width / 2;
      // Scan ALL children (real + clones): a centered clone must light its
      // original's dot, so we map the nearest node back to its real index.
      const centers = [];
      const realOf = [];
      for (const node of root.children) {
        const r = node.getBoundingClientRect();
        centers.push(r.left + r.width / 2);
        realOf.push(node.__carouselIndex != null ? node.__carouselIndex : 0);
      }
      if (centers.length === 0) return index;
      const pos = nearestByCenter(centers, railCenter);
      return realOf[pos] != null ? realOf[pos] : index;
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

    // A seamless-loop recenter jump moves scrollLeft by a whole period. Fold that
    // jump into `last` so the velocity sample doesn't read it as a giant fling.
    shiftAdjusters.push((deltaScrollLeft) => {
      last += deltaScrollLeft;
    });

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
    if (loopActive) {
      // Scroller: recenter immediately so a free drag / fling wraps seamlessly with
      // no edge. Slideshow: debounce to an idle moment so we never cut a smooth
      // advance or a snap mid-animation (the jump lands on identical pixels anyway).
      if (mode === 'scroller') maybeRecenter();
      else scheduleRecenter();
    }
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
    s.__carouselIndex = i; // real index — clones copy this so dots stay mapped
    s.setAttribute('role', 'group');
    s.setAttribute('aria-roledescription', 'slide');
    const label = (s.dataset && s.dataset.label) || `שקופית ${i + 1} מתוך ${n}`;
    s.setAttribute('aria-label', label);
    if (!s.classList.contains('carousel-slide') && !s.classList.contains('carousel-card')) {
      s.classList.add(slideClass);
    }
  });

  // ---- endless loop (seamless clones, both modes) ------------------------
  // Clone the whole real set enough times to fill the viewport on each side, park
  // on the first real slide, and on scroll silently jump by one real-set "period"
  // whenever the position drifts a full set into a clone region. Because the jump
  // lands on pixel-identical clones, there is no visible rewind/flash — the wrap
  // from last→first (or first→last) is seamless in BOTH modes and BOTH directions
  // (so a free drag/fling on a scroller keeps going instead of hitting a wall).
  // Needs real layout, so it stays dormant in jsdom and retries via ResizeObserver
  // until the track has a width (mounted / images loaded).
  function setupLoop() {
    if (loopActive || !canLoop) return;
    let rr;
    try {
      rr = root.getBoundingClientRect();
    } catch {
      return;
    }
    const viewport = rr.width;
    if (!(viewport > 0)) return; // no layout yet — caller retries
    // Physical span of the real set via min-left / max-right, so it is correct
    // regardless of direction (in RTL slide n-1 sits physically LEFT of slide 0,
    // which would make a naive last−first span negative).
    let minLeft = Infinity;
    let maxRight = -Infinity;
    try {
      for (const s of slides) {
        const r = s.getBoundingClientRect();
        if (r.left < minLeft) minLeft = r.left;
        if (r.left + r.width > maxRight) maxRight = r.left + r.width;
      }
    } catch {
      return;
    }
    const setWidth = maxRight - minLeft;
    if (!(setWidth > 0)) return; // no layout yet — caller retries
    // Enough whole sets on each side to always fill the viewport, plus one extra so
    // the viewport stays fully covered right up to the recenter boundary (where the
    // offset reaches a full period) with no edge gap.
    const copies = Math.ceil(viewport / setWidth) + 1;

    // Pin each real slide's positional background-color inline BEFORE cloning, so a
    // slide styled by position (e.g. .review:nth-of-type(n) shades) keeps its colour
    // once the prepend clones shift its nth-of-type index — and clones inherit the
    // pinned colour via cloneNode, so the whole loop stays visually correct. Only
    // background-color is touched (no carousel slide animates it), and it is restored
    // on destroy. Guarded for jsdom (no getComputedStyle layout).
    try {
      if (typeof getComputedStyle === 'function') {
        for (const s of slides) {
          const bg = getComputedStyle(s).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            pinnedBg.push([s, s.style.backgroundColor]);
            s.style.backgroundColor = bg;
          }
        }
      }
    } catch {
      /* jsdom / unsupported — no positional pinning needed there */
    }

    const mkClone = (node, realIndex) => {
      const c = node.cloneNode(true);
      c.__carouselIndex = realIndex;
      c.setAttribute('aria-hidden', 'true'); // a clone must not double-announce
      c.setAttribute('data-carousel-clone', '');
      c.removeAttribute('id');
      if (c.querySelectorAll) {
        for (const kid of c.querySelectorAll('[id]')) kid.removeAttribute('id');
        // Demote headings so a clone never adds a second <h1> etc. Styling rides on
        // the class, so a <p> with the same class looks identical.
        for (const h of c.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
          const p = document.createElement('p');
          for (const a of h.attributes) p.setAttribute(a.name, a.value);
          p.innerHTML = h.innerHTML;
          h.replaceWith(p);
        }
      }
      cloneNodes.push(c);
      return c;
    };

    const after = document.createDocumentFragment();
    const before = document.createDocumentFragment();
    for (let s = 0; s < copies; s++) {
      for (let i = 0; i < n; i++) {
        const c = mkClone(slides[i], i);
        if (s === 0 && i === 0) appendRef = c; // first append clone → the period anchor
        after.appendChild(c);
      }
    }
    for (let s = 0; s < copies; s++) {
      for (let i = 0; i < n; i++) before.appendChild(mkClone(slides[i], i));
    }
    root.appendChild(after);
    root.insertBefore(before, slides[0]);
    loopActive = true;

    // Park on the first real slide so the prepend clones sit scrolled off the
    // START edge (physical left in LTR, physical right in RTL). Without this the
    // browser's default position would show the prepend clones, not slide 0.
    try {
      const rootRect = root.getBoundingClientRect();
      const r0 = slides[0].getBoundingClientRect();
      const delta = isRTL()
        ? r0.left + r0.width - (rootRect.left + rootRect.width) // align right edges
        : r0.left - rootRect.left; // align left edges
      root.scrollBy({ left: delta, behavior: 'auto' });
    } catch {
      /* ignore */
    }
    updateControls();
  }

  // Shift the content so the first real slide's physical left moves by
  // `deltaPhysical` (scrollBy({left:−delta}) ⇒ content moves right by delta). Since
  // every position sits exactly one real-set apart from a pixel-identical clone, a
  // jump of one period is invisible. Broadcast the applied scrollLeft delta so the
  // turbo velocity baseline stays sane.
  function shiftContent(deltaPhysical) {
    let applied = 0;
    let before = 0;
    try {
      before = root.scrollLeft;
      root.scrollBy({ left: -deltaPhysical, behavior: 'auto' });
      applied = root.scrollLeft - before;
    } catch {
      try {
        root.scrollLeft = before - deltaPhysical;
        applied = root.scrollLeft - before;
      } catch {
        applied = 0;
      }
    }
    for (const fn of shiftAdjusters) {
      try {
        fn(applied);
      } catch {
        /* keep going */
      }
    }
  }

  // If the first real slide has drifted a whole set (or more) off the home band,
  // silently jump back by that many periods. Uses fixed references (slides[0] and
  // the first append clone) and a relative physical offset, so it can't ping-pong
  // and is RTL-safe.
  function maybeRecenter() {
    if (!loopActive || !appendRef) return;
    let rr, r0, ar;
    try {
      rr = root.getBoundingClientRect();
      r0 = slides[0].getBoundingClientRect();
      ar = appendRef.getBoundingClientRect();
    } catch {
      return;
    }
    // Magnitude of the physical distance to the identical clone one set away. Use
    // abs so it is correct in RTL (there the append clone sits physically LEFT of
    // slide 0, so a signed difference would be negative). Content is periodic with
    // this magnitude in BOTH physical directions (clones on both sides).
    const period = Math.abs(ar.left - r0.left);
    if (!(period > 0)) return;
    const d = r0.left - rr.left; // first real slide's offset from the track's left edge
    const k = loopJumpCount(d, period);
    if (k !== 0) shiftContent(k * period);
  }

  function scheduleRecenter() {
    if (recenterTimer) clearTimeout(recenterTimer);
    recenterTimer = setTimeout(() => {
      recenterTimer = null;
      maybeRecenter();
    }, 120);
  }

  // Bring the loop up once the track has a real width. jsdom has no layout (and
  // usually no ResizeObserver), so this simply never activates there.
  if (canLoop && raf) {
    raf(() => {
      if (loopActive) return;
      setupLoop();
      const RO = typeof window !== 'undefined' ? window.ResizeObserver : undefined;
      if (!loopActive && typeof RO === 'function') {
        const ro = new RO(() => {
          setupLoop();
          if (loopActive) ro.disconnect();
        });
        ro.observe(root);
        cleanups.push(() => ro.disconnect());
      }
    });
  }
  cleanups.push(() => {
    if (recenterTimer) {
      clearTimeout(recenterTimer);
      recenterTimer = null;
    }
    for (const c of cloneNodes) {
      try {
        c.remove();
      } catch {
        /* ignore */
      }
    }
    cloneNodes.length = 0;
    for (const [node, prev] of pinnedBg) {
      try {
        node.style.backgroundColor = prev;
      } catch {
        /* ignore */
      }
    }
    pinnedBg.length = 0;
    appendRef = null;
    loopActive = false;
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
