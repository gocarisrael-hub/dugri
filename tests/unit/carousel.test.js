import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initCarousel, releaseTargetIndex } from '../../site/js/carousel.js';

// jsdom has no layout/scroll metrics, so these tests exercise the IMPERATIVE
// API and DOM wiring (dots, aria-current, teardown) — never pixel scroll.

/** Build a track with `n` child slides and return the root element. */
function buildTrack(n, { dir = 'rtl' } = {}) {
  document.documentElement.setAttribute('dir', dir);
  const root = document.createElement('div');
  root.className = 'track';
  for (let i = 0; i < n; i++) {
    const card = document.createElement('div');
    card.textContent = `slide ${i}`;
    root.appendChild(card);
  }
  document.body.appendChild(root);
  return root;
}

// jsdom lacks a PointerEvent constructor, so synthesize a plain event and hang
// the pointer props the engine reads (clientX, button, pointerId, pointerType)
// on it. That's enough to exercise the tap-vs-drag decision without layout.
function firePointer(el, type, x) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.clientX = x;
  e.clientY = 0;
  e.button = 0;
  e.pointerId = 1;
  e.pointerType = 'mouse';
  el.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('releaseTargetIndex — pure release-target math', () => {
  const CW = 100; // card width; scrollLeft/CW is the fractional index
  const COUNT = 5; // valid indices 0..4

  it('picks the nearest card when velocity is zero', () => {
    // 2.6 → 3, 2.4 → 2, exact-half 2.5 → 3 (round-half-up)
    expect(releaseTargetIndex({ scrollLeft: 260, cardWidth: CW, count: COUNT, velocity: 0 })).toBe(
      3
    );
    expect(releaseTargetIndex({ scrollLeft: 240, cardWidth: CW, count: COUNT, velocity: 0 })).toBe(
      2
    );
    expect(releaseTargetIndex({ scrollLeft: 250, cardWidth: CW, count: COUNT, velocity: 0 })).toBe(
      3
    );
  });

  it('adds at most +1 card for a forward flick (nudge clamped)', () => {
    // Nearest is 2; a hard positive flick may not push past 3.
    expect(
      releaseTargetIndex({ scrollLeft: 200, cardWidth: CW, count: COUNT, velocity: 1000 })
    ).toBe(3);
  });

  it('subtracts at most 1 card for a backward flick (nudge clamped)', () => {
    // Nearest is 2; a hard negative flick may not push below 1.
    expect(
      releaseTargetIndex({ scrollLeft: 200, cardWidth: CW, count: COUNT, velocity: -1000 })
    ).toBe(1);
  });

  it('clamps at index 0 (cannot flick before the first card)', () => {
    expect(
      releaseTargetIndex({ scrollLeft: 0, cardWidth: CW, count: COUNT, velocity: -1000 })
    ).toBe(0);
  });

  it('clamps at count-1 (cannot flick past the last card)', () => {
    expect(
      releaseTargetIndex({ scrollLeft: 400, cardWidth: CW, count: COUNT, velocity: 1000 })
    ).toBe(4);
  });

  it('guards degenerate inputs (count<1 → 0, count 1 → 0)', () => {
    expect(releaseTargetIndex({ scrollLeft: 999, cardWidth: CW, count: 0, velocity: 5 })).toBe(0);
    expect(releaseTargetIndex({ scrollLeft: 999, cardWidth: CW, count: 1, velocity: 5 })).toBe(0);
  });
});

describe('initCarousel — defensive guards', () => {
  it('no-ops on a null root', () => {
    const api = initCarousel(null);
    expect(() => api.next()).not.toThrow();
    expect(api.current()).toBe(-1);
  });

  it('no-ops on a 0-child root (no dots created)', () => {
    const root = buildTrack(0);
    const api = initCarousel(root, { dots: true });
    expect(() => {
      api.next();
      api.prev();
      api.goTo(2);
    }).not.toThrow();
    expect(api.current()).toBe(-1);
    expect(document.querySelectorAll('.carousel-dot').length).toBe(0);
  });

  it('is idempotent — a second init returns the same instance', () => {
    const root = buildTrack(3);
    const a = initCarousel(root);
    const b = initCarousel(root);
    expect(a).toBe(b);
    // Only one set of dots was rendered.
    expect(document.querySelectorAll('.carousel-dot').length).toBe(3);
  });
});

describe('initCarousel — dots + ARIA wiring', () => {
  it('renders one dot per slide when dots:true', () => {
    const root = buildTrack(4);
    initCarousel(root, { dots: true });
    expect(document.querySelectorAll('.carousel-dot').length).toBe(4);
    // Dots are real buttons with an aria-label.
    const dot = document.querySelector('.carousel-dot');
    expect(dot.tagName).toBe('BUTTON');
    expect(dot.getAttribute('aria-label')).toBeTruthy();
  });

  it('renders no dots when dots:false', () => {
    const root = buildTrack(4);
    initCarousel(root, { dots: false });
    expect(document.querySelectorAll('.carousel-dot').length).toBe(0);
  });

  it('renders dots into dotsInto when provided', () => {
    const root = buildTrack(3);
    const host = document.createElement('div');
    document.body.appendChild(host);
    initCarousel(root, { dots: true, dotsInto: host });
    expect(host.querySelectorAll('.carousel-dot').length).toBe(3);
  });

  it('sets carousel role + roledescription on root and slides', () => {
    const root = buildTrack(2);
    initCarousel(root);
    expect(root.getAttribute('role')).toBe('group');
    expect(root.getAttribute('aria-roledescription')).toBe('carousel');
    for (const s of root.children) {
      expect(s.getAttribute('aria-roledescription')).toBe('slide');
      expect(s.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('uses data-label for a slide aria-label when present', () => {
    const root = buildTrack(2);
    root.children[1].dataset.label = 'ביקורת של דנה';
    initCarousel(root);
    expect(root.children[1].getAttribute('aria-label')).toBe('ביקורת של דנה');
  });

  it('renders arrows when arrows:true and none by default in scroller mode', () => {
    const a = buildTrack(3);
    initCarousel(a, { arrows: true });
    expect(document.querySelectorAll('.carousel-arrow').length).toBe(2);

    document.body.innerHTML = '';
    const b = buildTrack(3);
    initCarousel(b); // scroller default → no arrows
    expect(document.querySelectorAll('.carousel-arrow').length).toBe(0);
  });
});

describe('initCarousel — imperative navigation', () => {
  it('current() starts at 0 and aria-current sits on the first dot', () => {
    const root = buildTrack(3);
    const api = initCarousel(root);
    expect(api.current()).toBe(0);
    const dots = document.querySelectorAll('.carousel-dot');
    expect(dots[0].getAttribute('aria-current')).toBe('true');
    expect(dots[1].hasAttribute('aria-current')).toBe(false);
  });

  it('next()/prev() move current() and move aria-current to the right dot', () => {
    const root = buildTrack(3);
    const api = initCarousel(root);
    const dots = document.querySelectorAll('.carousel-dot');

    api.next();
    expect(api.current()).toBe(1);
    expect(dots[1].getAttribute('aria-current')).toBe('true');
    expect(dots[0].hasAttribute('aria-current')).toBe(false);

    api.prev();
    expect(api.current()).toBe(0);
    expect(dots[0].getAttribute('aria-current')).toBe('true');
  });

  it('goTo(i) jumps to i and updates aria-current', () => {
    const root = buildTrack(4);
    const api = initCarousel(root);
    api.goTo(2);
    expect(api.current()).toBe(2);
    expect(document.querySelectorAll('.carousel-dot')[2].getAttribute('aria-current')).toBe('true');
  });

  it('clamps at the ends when loop:false (scroller default)', () => {
    const root = buildTrack(3);
    const api = initCarousel(root, { mode: 'scroller', loop: false });
    api.prev(); // already at 0
    expect(api.current()).toBe(0);
    api.goTo(99);
    expect(api.current()).toBe(2);
    api.next();
    expect(api.current()).toBe(2);
  });

  it('wraps around when loop:true', () => {
    const root = buildTrack(3);
    const api = initCarousel(root, { mode: 'scroller', loop: true });
    api.prev(); // 0 → wrap to last
    expect(api.current()).toBe(2);
    api.next(); // last → wrap to 0
    expect(api.current()).toBe(0);
  });

  it('clicking a dot navigates to that slide', () => {
    const root = buildTrack(4);
    const api = initCarousel(root);
    document.querySelectorAll('.carousel-dot')[3].click();
    expect(api.current()).toBe(3);
  });
});

describe('initCarousel — slideshow auto-advance', () => {
  it('advances current() on each interval tick and wraps (loop default)', () => {
    vi.useFakeTimers();
    const root = buildTrack(3);
    const api = initCarousel(root, { mode: 'slideshow', interval: 1000 });
    expect(api.current()).toBe(0);

    vi.advanceTimersByTime(1000);
    expect(api.current()).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(api.current()).toBe(2);

    vi.advanceTimersByTime(1000);
    expect(api.current()).toBe(0); // wrapped
  });

  it('autoplay:false keeps a slideshow manual — the timer never advances it', () => {
    vi.useFakeTimers();
    const root = buildTrack(3);
    const api = initCarousel(root, { mode: 'slideshow', autoplay: false, interval: 1000 });
    expect(api.current()).toBe(0);

    // No auto-advance, even after several intervals...
    vi.advanceTimersByTime(5000);
    expect(api.current()).toBe(0);

    // ...and an explicit play() must not sneak a timer back in.
    api.play();
    vi.advanceTimersByTime(5000);
    expect(api.current()).toBe(0);

    // Manual navigation still works.
    api.next();
    expect(api.current()).toBe(1);
  });

  it('pause() stops auto-advance and play() resumes it', () => {
    vi.useFakeTimers();
    const root = buildTrack(3);
    const api = initCarousel(root, { mode: 'slideshow', interval: 1000 });

    api.pause();
    vi.advanceTimersByTime(3000);
    expect(api.current()).toBe(0); // no movement while paused

    api.play();
    vi.advanceTimersByTime(1000);
    expect(api.current()).toBe(1);
  });

  it('scroller mode does not auto-advance', () => {
    vi.useFakeTimers();
    const root = buildTrack(3);
    const api = initCarousel(root, { mode: 'scroller', interval: 500 });
    vi.advanceTimersByTime(5000);
    expect(api.current()).toBe(0);
  });
});

describe('initCarousel — mode class', () => {
  it('tags a scroller root with carousel--scroller and removes it on destroy', () => {
    const root = buildTrack(3);
    const api = initCarousel(root, { mode: 'scroller' });
    expect(root.classList.contains('carousel--scroller')).toBe(true);
    expect(root.classList.contains('carousel--slideshow')).toBe(false);
    api.destroy();
    expect(root.classList.contains('carousel--scroller')).toBe(false);
  });

  it('tags a slideshow root with carousel--slideshow', () => {
    const root = buildTrack(3);
    initCarousel(root, { mode: 'slideshow' });
    expect(root.classList.contains('carousel--slideshow')).toBe(true);
    expect(root.classList.contains('carousel--scroller')).toBe(false);
  });
});

describe('initCarousel — pointer drag vs tap', () => {
  it('a press that moves under the threshold stays a tap (never .is-dragging)', () => {
    const root = buildTrack(3);
    initCarousel(root, { mode: 'scroller' });

    firePointer(root, 'pointerdown', 100);
    firePointer(root, 'pointermove', 103); // 3px < 6px threshold
    expect(root.classList.contains('is-dragging')).toBe(false);

    firePointer(root, 'pointerup', 103);
    expect(root.classList.contains('is-dragging')).toBe(false);
  });

  it('a press dragged past the threshold promotes to a drag (.is-dragging)', () => {
    const root = buildTrack(3);
    initCarousel(root, { mode: 'scroller' });

    firePointer(root, 'pointerdown', 100);
    firePointer(root, 'pointermove', 130); // 30px > 6px threshold → drag
    expect(root.classList.contains('is-dragging')).toBe(true);
  });

  it('a pointerdown with no move at all leaves the click free to land', () => {
    const root = buildTrack(3);
    initCarousel(root, { mode: 'scroller' });

    const link = document.createElement('a');
    link.href = '#x';
    let clicked = false;
    link.addEventListener('click', () => {
      clicked = true;
    });
    root.children[0].appendChild(link);

    firePointer(root, 'pointerdown', 50);
    firePointer(root, 'pointerup', 50);
    link.click(); // the synthesized click a real tap would produce

    expect(clicked).toBe(true);
    expect(root.classList.contains('is-dragging')).toBe(false);
  });
});

describe('initCarousel — destroy()', () => {
  it('removes dots, arrows and stops the timer', () => {
    vi.useFakeTimers();
    const root = buildTrack(3);
    const api = initCarousel(root, { mode: 'slideshow', interval: 1000, arrows: true });
    expect(document.querySelectorAll('.carousel-dot').length).toBe(3);
    expect(document.querySelectorAll('.carousel-arrow').length).toBe(2);

    api.destroy();
    expect(document.querySelectorAll('.carousel-dot').length).toBe(0);
    expect(document.querySelectorAll('.carousel-arrow').length).toBe(0);

    // Auto-advance no longer fires after teardown.
    vi.advanceTimersByTime(5000);
    expect(api.current()).toBe(0);
  });

  it('clears the instance so the root can be re-initialised', () => {
    const root = buildTrack(3);
    const a = initCarousel(root);
    a.destroy();
    const b = initCarousel(root);
    expect(b).not.toBe(a);
    expect(document.querySelectorAll('.carousel-dot').length).toBe(3);
  });

  it('removes a tabindex it added, but keeps a page-provided one', () => {
    const root1 = buildTrack(2);
    const api1 = initCarousel(root1);
    expect(root1.getAttribute('tabindex')).toBe('0');
    api1.destroy();
    expect(root1.hasAttribute('tabindex')).toBe(false);

    const root2 = buildTrack(2);
    root2.setAttribute('tabindex', '-1');
    const api2 = initCarousel(root2);
    api2.destroy();
    expect(root2.getAttribute('tabindex')).toBe('-1');
  });
});
