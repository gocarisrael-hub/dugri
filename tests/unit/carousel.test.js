import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initCarousel,
  nearestByCenter,
  turboBoostPx,
  realIndexFromClonedIndex,
  loopJumpCount,
  TURBO_THRESHOLD,
  TURBO_GAIN,
} from '../../site/js/carousel.js';

// jsdom has no layout/scroll metrics, so these tests exercise the IMPERATIVE
// API and DOM wiring (dots, aria-current, teardown) — never pixel scroll. The
// native-scroll motion (turbo boost, snap) needs a real device and isn't
// asserted here; the pure helpers below cover the decision math instead.

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

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('nearestByCenter — pure dot-sync math', () => {
  it('picks the card whose center is closest to the rail center', () => {
    const centers = [0, 100, 200, 300, 400];
    expect(nearestByCenter(centers, 190)).toBe(2); // 190 nearest 200
    expect(nearestByCenter(centers, 140)).toBe(1); // 140 nearest 100 (dist 40 < 60)
    expect(nearestByCenter(centers, 0)).toBe(0);
    expect(nearestByCenter(centers, 400)).toBe(4);
  });

  it('is direction-agnostic — works with negative (RTL-style) coordinates', () => {
    // In RTL the physical order runs the other way; only relative distance matters.
    const centers = [400, 300, 200, 100, 0];
    expect(nearestByCenter(centers, 190)).toBe(2);
    expect(nearestByCenter(centers, -50)).toBe(4);
  });

  it('ties resolve to the earlier (lower) index', () => {
    expect(nearestByCenter([0, 100], 50)).toBe(0);
  });

  it('guards an empty / invalid list → index 0', () => {
    expect(nearestByCenter([], 123)).toBe(0);
    expect(nearestByCenter(null, 123)).toBe(0);
  });
});

describe('turboBoostPx — velocity → initial momentum boost', () => {
  it('returns no boost for a tap / slow drag below the threshold', () => {
    expect(turboBoostPx(0)).toBe(0);
    expect(turboBoostPx(0.24)).toBe(0);
    expect(turboBoostPx(-0.24)).toBe(0);
  });

  it('scales velocity by the gain above the threshold', () => {
    expect(turboBoostPx(1)).toBeCloseTo(TURBO_GAIN, 6); // 1 * gain
    expect(turboBoostPx(2)).toBeCloseTo(2 * TURBO_GAIN, 6);
  });

  it('preserves direction (sign) so it works in RTL too', () => {
    expect(turboBoostPx(1)).toBeGreaterThan(0);
    expect(turboBoostPx(-1)).toBeLessThan(0);
    expect(turboBoostPx(-1)).toBeCloseTo(-TURBO_GAIN, 6);
  });

  it('kicks in right at the threshold boundary', () => {
    expect(turboBoostPx(TURBO_THRESHOLD)).toBeCloseTo(TURBO_THRESHOLD * TURBO_GAIN, 6);
  });

  it('guards non-finite input → 0', () => {
    expect(turboBoostPx(NaN)).toBe(0);
    expect(turboBoostPx(undefined)).toBe(0);
  });
});

describe('realIndexFromClonedIndex — clone → real dot mapping', () => {
  it('maps the real set (no prepend) to itself', () => {
    for (let i = 0; i < 3; i++) expect(realIndexFromClonedIndex(i, 3, 0)).toBe(i);
  });

  it('maps append clones back to their original real index', () => {
    // Layout with prepend=3: [P0 P1 P2][R0 R1 R2][A0 A1 A2] at child indices 0..8.
    expect(realIndexFromClonedIndex(3, 3, 3)).toBe(0); // R0
    expect(realIndexFromClonedIndex(5, 3, 3)).toBe(2); // R2
    expect(realIndexFromClonedIndex(6, 3, 3)).toBe(0); // A0 → dot 0
    expect(realIndexFromClonedIndex(8, 3, 3)).toBe(2); // A2 → dot 2
  });

  it('maps prepend clones back too (negative offset wraps positively)', () => {
    expect(realIndexFromClonedIndex(0, 3, 3)).toBe(0); // P0 → dot 0
    expect(realIndexFromClonedIndex(2, 3, 3)).toBe(2); // P2 → dot 2
  });

  it('handles multiple clone sets on each side', () => {
    // prepend=6 (two sets of 3): child 12 is A0 of the first append set.
    expect(realIndexFromClonedIndex(12, 3, 6)).toBe(0);
    expect(realIndexFromClonedIndex(13, 3, 6)).toBe(1);
  });

  it('guards a non-positive count → 0', () => {
    expect(realIndexFromClonedIndex(5, 0, 0)).toBe(0);
    expect(realIndexFromClonedIndex(5, -2, 0)).toBe(0);
  });
});

describe('loopJumpCount — seamless recenter math', () => {
  it('no jump while inside the home band (|d| < period)', () => {
    expect(loopJumpCount(0, 100)).toBe(0);
    expect(loopJumpCount(99, 100)).toBe(0);
    expect(loopJumpCount(-99, 100)).toBe(0);
  });

  it('jumps back one period once a full set has been scrolled forward', () => {
    // d reaches −period at the end of a full loop → jump +1 period to recenter.
    expect(loopJumpCount(-100, 100)).toBe(1);
    expect(loopJumpCount(-150, 100)).toBe(1);
  });

  it('jumps the other way when scrolled a full set backward', () => {
    expect(loopJumpCount(100, 100)).toBe(-1);
    expect(loopJumpCount(150, 100)).toBe(-1);
  });

  it('handles multi-period overshoot (fast fling) in one correction', () => {
    expect(loopJumpCount(-260, 100)).toBe(2);
    expect(loopJumpCount(310, 100)).toBe(-3);
  });

  it('applying the jump lands the offset back inside the band', () => {
    const period = 100;
    for (const d of [-260, -100, -1, 0, 1, 100, 310]) {
      const settled = d + loopJumpCount(d, period) * period;
      expect(Math.abs(settled)).toBeLessThan(period);
    }
  });

  it('guards a non-positive period or non-finite offset → 0', () => {
    expect(loopJumpCount(500, 0)).toBe(0);
    expect(loopJumpCount(500, -100)).toBe(0);
    expect(loopJumpCount(NaN, 100)).toBe(0);
    expect(loopJumpCount(Infinity, 100)).toBe(0);
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

describe('initCarousel — native scroll leaves clicks free', () => {
  it('never intercepts the pointer, so a click inside a card still lands', () => {
    // No pointer-drag interception any more: a tap on a child link fires natively.
    const root = buildTrack(3);
    initCarousel(root, { mode: 'scroller' });

    const link = document.createElement('a');
    link.href = '#x';
    let clicked = false;
    link.addEventListener('click', () => {
      clicked = true;
    });
    root.children[0].appendChild(link);

    link.click();
    expect(clicked).toBe(true);
  });

  it('the turbo listeners are passive (no is-dragging class, ever)', () => {
    const root = buildTrack(3);
    initCarousel(root, { mode: 'scroller' });
    const down = new Event('pointerdown', { bubbles: true });
    const up = new Event('pointerup', { bubbles: true });
    expect(() => {
      root.dispatchEvent(down);
      root.dispatchEvent(up);
    }).not.toThrow();
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
