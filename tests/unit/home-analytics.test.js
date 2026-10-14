// The homepage's GA events (site/js/home-analytics.js): section_view once per
// section per page view at "half seen", and design_swipe once, only for a
// scroll she started.
import { describe, it, expect, vi } from 'vitest';
import {
  sectionKey,
  isHalfSeen,
  initSectionViews,
  initFirstSwipe,
} from '../../site/js/home-analytics.js';

function page() {
  document.body.innerHTML = `
    <section id="top"></section>
    <section id="products"><div id="productsTrack"></div></section>
    <section id="reviews"></section>
    <section id="unlisted"></section>
    <footer></footer>`;
}

// A hand-driven IntersectionObserver: the test decides what is on screen.
function fakeIO() {
  const made = [];
  class IO {
    constructor(cb) {
      this.cb = cb;
      this.observed = new Set();
      made.push(this);
    }
    observe(el) {
      this.observed.add(el);
    }
    unobserve(el) {
      this.observed.delete(el);
    }
    fire(el, { seen, own, screen = 800 }) {
      this.cb([
        {
          target: el,
          isIntersecting: seen > 0,
          intersectionRect: { height: seen },
          boundingClientRect: { height: own },
          rootBounds: { height: screen },
        },
      ]);
    }
  }
  return { IO, made };
}

const entry = (seen, own, screen = 800) => ({
  isIntersecting: seen > 0,
  intersectionRect: { height: seen },
  boundingClientRect: { height: own },
  rootBounds: { height: screen },
});

describe('section names', () => {
  it('are the stable GA names, and unlisted sections have none', () => {
    page();
    expect(sectionKey(document.getElementById('top'))).toBe('hero');
    expect(sectionKey(document.getElementById('products'))).toBe('designs');
    expect(sectionKey(document.querySelector('footer'))).toBe('footer');
    expect(sectionKey(document.getElementById('unlisted'))).toBe(null);
  });
});

describe('half seen', () => {
  it('is half the section on screen', () => {
    expect(isHalfSeen(entry(199, 400))).toBe(false);
    expect(isHalfSeen(entry(200, 400))).toBe(true);
  });
  it('is half the screen for a section too tall ever to be half on screen', () => {
    expect(isHalfSeen(entry(399, 3000))).toBe(false);
    expect(isHalfSeen(entry(400, 3000))).toBe(true);
  });
  it('is never true off screen', () => {
    expect(isHalfSeen(entry(0, 400))).toBe(false);
  });
});

describe('section_view', () => {
  it('fires once per section, at half seen, and only for named sections', () => {
    page();
    const send = vi.fn();
    const { IO, made } = fakeIO();
    initSectionViews(document, send, IO);
    const io = made[0];
    expect(io.observed.size).toBe(4); // top, products, reviews, footer
    const reviews = document.getElementById('reviews');
    io.fire(reviews, { seen: 100, own: 400 });
    expect(send).not.toHaveBeenCalled();
    io.fire(reviews, { seen: 300, own: 400 });
    io.fire(reviews, { seen: 400, own: 400 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('section_view', { section: 'reviews' });
    expect(io.observed.has(reviews)).toBe(false);
    io.fire(document.querySelector('footer'), { seen: 120, own: 200 });
    expect(send).toHaveBeenLastCalledWith('section_view', { section: 'footer' });
  });

  it('does nothing without IntersectionObserver', () => {
    page();
    expect(initSectionViews(document, vi.fn(), undefined)).toBe(null);
  });
});

describe('design_swipe', () => {
  function rig() {
    page();
    const send = vi.fn();
    let t = 1000;
    const rail = document.getElementById('productsTrack');
    const zone = document.getElementById('products');
    initFirstSwipe(rail, zone, send, () => t);
    return { send, rail, zone, at: (v) => (t = v) };
  }

  it('fires once, on the first scroll she started', () => {
    const { send, rail, zone } = rig();
    zone.dispatchEvent(new Event('pointerdown'));
    rail.dispatchEvent(new Event('scroll'));
    rail.dispatchEvent(new Event('scroll'));
    zone.dispatchEvent(new Event('touchstart'));
    rail.dispatchEvent(new Event('scroll'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('design_swipe', {});
  });

  it('ignores the carousel scrolling itself', () => {
    const { send, rail } = rig();
    rail.dispatchEvent(new Event('scroll'));
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a scroll long after her last input', () => {
    const { send, rail, zone, at } = rig();
    zone.dispatchEvent(new Event('wheel'));
    at(1000 + 5000);
    rail.dispatchEvent(new Event('scroll'));
    expect(send).not.toHaveBeenCalled();
  });
});
