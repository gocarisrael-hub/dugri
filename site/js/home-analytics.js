// GA4 events for how far down the homepage people get, and whether they swipe
// the designs rail. Everything goes through analytics.js track(), so it takes
// the same consent path (gtag consent mode) as every other event. No visitor
// data is sent: a section name, and nothing at all for the swipe.

import { track } from './analytics.js';

// The section's name in GA. Stable on purpose: a report grouped by `section`
// must not split in two because an id or a heading was edited. Only these are
// counted; a new section is added here deliberately rather than leaking in.
export const SECTION_KEYS = {
  top: 'hero',
  about: 'about',
  products: 'designs',
  reviews: 'reviews',
  story: 'story',
  faq: 'faq',
  order: 'order',
  business: 'business',
  footer: 'footer',
};

export function sectionKey(el) {
  if (!el) return null;
  if (el.tagName === 'FOOTER') return SECTION_KEYS.footer;
  return Object.prototype.hasOwnProperty.call(SECTION_KEYS, el.id) ? SECTION_KEYS[el.id] : null;
}

// "Half seen": half of the section is on screen, or, for a section taller than
// two screens (which can never be half on screen), half the SCREEN is that
// section. Without the second rule the tallest sections would never count.
export function isHalfSeen(entry) {
  if (!entry || !entry.isIntersecting) return false;
  const seen = entry.intersectionRect ? entry.intersectionRect.height : 0;
  const own = entry.boundingClientRect ? entry.boundingClientRect.height : 0;
  const screen = entry.rootBounds ? entry.rootBounds.height : 0;
  if (own > 0 && seen >= own * 0.5) return true;
  return screen > 0 && seen >= screen * 0.5;
}

// section_view { section }, once per section per page view.
export function initSectionViews(
  doc = document,
  send = track,
  IO = globalThis.IntersectionObserver
) {
  if (typeof IO !== 'function') return null;
  const targets = Array.from(doc.querySelectorAll('section[id], footer')).filter((el) =>
    sectionKey(el)
  );
  const sent = new Set();
  const io = new IO(
    (entries) => {
      for (const entry of entries) {
        if (!isHalfSeen(entry)) continue;
        const key = sectionKey(entry.target);
        io.unobserve(entry.target);
        if (!key || sent.has(key)) continue;
        sent.add(key);
        send('section_view', { section: key });
      }
    },
    { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] }
  );
  for (const el of targets) io.observe(el);
  return io;
}

// design_swipe, once per page view, on the first time SHE moves the designs
// rail. A scroll alone is not enough: the carousel scrolls itself (the endless
// loop parks on its clones, the rail is rebuilt when the designs load). So a
// scroll counts only within a moment of her own input on the section: a touch,
// a press (which covers the arrows), a wheel or a key.
export function initFirstSwipe(rail, zone, send = track, now = () => Date.now()) {
  if (!rail || !zone) return;
  let armedAt = -Infinity;
  let done = false;
  const arm = () => {
    armedAt = now();
  };
  for (const type of ['pointerdown', 'touchstart', 'wheel', 'keydown']) {
    zone.addEventListener(type, arm, { passive: true });
  }
  const onScroll = () => {
    if (done || now() - armedAt > 1500) return;
    done = true;
    rail.removeEventListener('scroll', onScroll);
    send('design_swipe', {});
  };
  rail.addEventListener('scroll', onScroll, { passive: true });
}
