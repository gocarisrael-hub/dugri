// product.js — drives the per-product detail page (product.html?design=<id>).
//
// Reads the `design` query param, resolves it against PUBLIC_DESIGNS (the same
// single source of truth the rest of the site uses), and renders top→bottom:
//   1. a swipeable photo gallery (initCarousel, dots)
//   2. the title + price
//   3. an "about this design" blurb (per-design placeholder copy)
//   4. a related-products rail (initCarousel scroller, peek of next card)
//
// Everything is defensive: a missing/invalid ?design falls back to the first
// public design and never throws. Private designs aren't in PUBLIC_DESIGNS so
// they can't be deep-linked here.

import { PUBLIC_DESIGNS } from './designs.js';
import { initCarousel } from './carousel.js';

const PRICE = 79;
const WAS = 129;

// ---- per-design "about" copy --------------------------------------------
// Placeholder Hebrew descriptions, keyed by design id. Generic-but-on-brand;
// the owner will refine each one. Any id missing here falls back to GENERIC.
const ABOUT = {
  bachelorette:
    'עיצוב נועז ומלא הומור שנבנה בול למסיבת רווקות — צבעוני, חצוף ומזמין לצחוק. הקלפים והלוח מתלבשים על הבדיחות הפנימיות של הכלה והבנות.',
  marriage:
    'עיצוב חמים ואלגנטי ליום נישואין — שנות הזוגיות, הרגעים והשמות שלכם הופכים למשחק שמחזיר את כל הזיכרונות לשולחן.',
  birthday:
    'עיצוב חוגג ושמח ליום הולדת — צבעים עליזים שמכניסים את בעל או בעלת היום למרכז ומסתובבים סביב הסיפורים שכולם מכירים.',
  japanese:
    'עיצוב נקי בהשראה יפנית — קווים מינימליסטיים וטון מרוכז שנותנים למילים ולבדיחות הפנימיות לככב בלי רעש מסביב.',
  posttrip:
    'עיצוב הרפתקני לחזרה מטיול — כרטיס טיסה, חותמות ומפות שממסגרים את כל הרגעים מהמסלול לתוך משחק אחד.',
  neon: 'עיצוב ניאון זוהר לערב מסיבה — צבעים חשמליים על רקע כהה שמפוצצים את החדר ברגע שמדליקים את האורות הנמוכים.',
  kids: 'עיצוב שובב וצבעוני ליום הולדת של ילדים — איורים גדולים וברורים שמתאימים לגיל, לצחוקים ולמשחק קבוצתי.',
};
const GENERIC =
  'אותו משחק דוגרי בעיצוב ייחודי — חפיסת קלפים ולוח מותאמים אישית מהמילים, הבדיחות והרגעים שרק אתם מכירים.';

// ---- helpers ------------------------------------------------------------

/** Read `?design=<id>` and resolve it to a public design; default = first. */
function resolveDesign() {
  const list = PUBLIC_DESIGNS;
  const first = list[0] || null;
  let id = '';
  try {
    id = new URLSearchParams(window.location.search).get('design') || '';
  } catch {
    id = '';
  }
  const match = list.find((d) => d.id === id);
  return match || first;
}

/** The filler gallery photos for a design: front/back/board, board skipped when
 *  the design ships without one (e.g. kids). Each is a {src, label}. The gallery
 *  is shown full-width, so it sources the crisp hi-res renders
 *  (assets/designs/<id>/gallery-front|back|board.webp, ~1100px from the vector
 *  SVGs) rather than the tiny picker thumbs (thumb-*.webp), which upscale blurry.
 *  The OWNER can later replace these with real product photos at
 *  assets/products/<id>/1.jpg, 2.jpg, 3.jpg… (see product.html gallery comment). */
function galleryPhotos(d) {
  // A design's available product kinds; board is absent for boardless designs.
  const thumbs = d.thumbs || {};
  const KIND = { front: 'קלף', back: 'גב הקלף', board: 'לוח המשחק' };
  const shots = ['front', 'back', 'board']
    .filter((k) => thumbs[k])
    .map((k) => ({
      src: `assets/designs/${d.id}/gallery-${k}.webp`,
      label: `${d.name} · ${KIND[k]}`,
    }));
  // Never render an empty gallery: fall back to the single picker thumb.
  if (!shots.length && d.thumb) shots.push({ src: d.thumb, label: d.name });
  return shots;
}

function el(tag, cls, attrs) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  }
  return node;
}

// ---- renderers ----------------------------------------------------------

// The live carousel instances, kept so the zoom overlay can open on whichever
// image the inline gallery is currently showing (galleryApi.current()).
let galleryApi = null;
let zoomApi = null;

function renderGallery(d) {
  const track = document.getElementById('galleryTrack');
  if (!track) return;
  track.textContent = '';
  for (const shot of galleryPhotos(d)) {
    const slide = el('div', 'pdp-gallery-slide', { 'data-label': shot.label });
    const img = el('img', null, {
      src: shot.src,
      alt: shot.label,
      loading: 'lazy',
      decoding: 'async',
    });
    slide.appendChild(img);
    track.appendChild(slide);
  }
  // Slideshow feel, no dots (owner-swappable photo carousel). No auto-advance
  // so the shopper controls it; swipe/keys drive navigation.
  galleryApi = initCarousel(track, {
    mode: 'slideshow',
    autoplay: false,
    loop: false,
    dots: false,
    arrows: false,
    dotsInto: document.getElementById('galleryDots'),
  });
}

// Fullscreen zoom overlay: a swipeable track of the SAME gallery images so the
// shopper can enlarge a photo and finger-drag between front / back / board
// exactly like the site carousels. Mirrors the wizard's overlay (options.html)
// but is self-contained here. Esc closes, body scroll is locked while open, and
// the overlay sits above the fixed header (z-index in product.html CSS).
function renderZoom(d) {
  const track = document.getElementById('pdpZoomTrack');
  const overlay = document.getElementById('pdpZoom');
  const openBtn = document.getElementById('galleryZoomOpen');
  const closeBtn = document.getElementById('pdpZoomClose');
  if (!track || !overlay || !openBtn || !closeBtn) return;

  track.textContent = '';
  for (const shot of galleryPhotos(d)) {
    const slide = el('div', 'pdp-zoom-slide', { 'data-label': shot.label });
    const img = el('img', null, {
      src: shot.src,
      alt: shot.label,
      loading: 'lazy',
      decoding: 'async',
    });
    slide.appendChild(img);
    track.appendChild(slide);
  }
  // Same shared engine as the site carousels → native, reliable finger-swipe.
  zoomApi = initCarousel(track, {
    mode: 'slideshow',
    dots: false,
    loop: true,
    arrows: false,
    autoplay: false,
    dotsInto: document.getElementById('pdpZoomDots'),
  });

  let opener = null;
  function open() {
    if (!overlay.hidden) return;
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    // Open on whichever image the inline gallery is showing (no smooth jump).
    if (galleryApi && zoomApi) zoomApi.goTo(galleryApi.current(), false);
    opener = document.activeElement;
    closeBtn.focus();
  }
  function close() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    if (opener && typeof opener.focus === 'function') opener.focus();
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  // Tap the dim backdrop (anything but the image, dots or close) to dismiss.
  overlay.addEventListener('click', (e) => {
    if (e.target.closest('img, .pdp-zoom-dots, .pdp-zoom-close')) return;
    close();
  });
  // Keyboard while open: Esc closes; arrows swipe (RTL-mapped, matching carousel).
  document.addEventListener('keydown', (e) => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (zoomApi) zoomApi.next();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (zoomApi) zoomApi.prev();
    }
  });
}

// Back-to-store: prefer a real history.back() when the shopper arrived from
// within the site (returns them to their place in the store); otherwise let the
// anchor's href (products.html) handle a fresh tab / deep link.
function wireBack() {
  const back = document.querySelector('.pdp-back');
  if (!back) return;
  back.addEventListener('click', (e) => {
    let sameOrigin = false;
    try {
      const ref = document.referrer || '';
      sameOrigin = !!ref && new URL(ref).origin === window.location.origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin && window.history.length > 1) {
      e.preventDefault();
      window.history.back();
    }
  });
}

function renderInfo(d) {
  const title = document.getElementById('pdpTitle');
  if (title) title.textContent = d.name;
  document.title = `${d.name} · דוגרי`;

  const now = document.getElementById('pdpPriceNow');
  if (now) now.textContent = `${PRICE} ₪`;
  const was = document.getElementById('pdpPriceWas');
  if (was) was.textContent = `${WAS} ₪`;

  const about = document.getElementById('pdpAbout');
  if (about) about.textContent = ABOUT[d.id] || GENERIC;

  // Buy now jumps straight into the order flow for this design. It skips the
  // wizard's design-picker (step 1) and lands on the colour + add-ons step
  // (step 2). Fixed-colour designs (e.g. neon) share the same step — the colour
  // swatches just show a "background is fixed" note there. Team D's wizard
  // honours the step param and preselects the design.
  const buy = document.getElementById('pdpBuy');
  if (buy) {
    buy.href = `options.html?design=${encodeURIComponent(d.id)}&step=2`;
  }
}

function renderRelated(current) {
  const track = document.getElementById('relatedTrack');
  if (!track) return;
  track.textContent = '';
  for (const d of PUBLIC_DESIGNS) {
    const card = el('a', 'pdp-rel-card', {
      href: `product.html?design=${encodeURIComponent(d.id)}`,
      'data-label': d.name,
    });
    if (d.id === current.id) card.setAttribute('aria-current', 'true');

    const thumb = el('div', 'pdp-rel-thumb');
    const img = el('img', null, {
      src: (d.thumbs && d.thumbs.front) || d.thumb || '',
      alt: d.name,
      loading: 'lazy',
      decoding: 'async',
    });
    thumb.appendChild(img);

    const name = el('span', 'pdp-rel-name');
    name.textContent = d.name;
    const price = el('span', 'pdp-rel-price');
    price.textContent = `${PRICE} ₪`;

    card.append(thumb, name, price);
    track.appendChild(card);
  }
  // Free-swipe rail; card width (peek of next) is owned by the page CSS.
  initCarousel(track, {
    mode: 'scroller',
    dots: false,
    arrows: false,
  });
}

// ---- boot ---------------------------------------------------------------
function boot() {
  const d = resolveDesign();
  if (!d) return; // no public designs at all — leave the static shell as-is
  renderGallery(d);
  renderZoom(d);
  renderInfo(d);
  renderRelated(d);
  wireBack();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
