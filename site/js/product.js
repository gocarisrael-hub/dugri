// product.js — drives the per-product detail page (product.html?design=<id>).
//
// Reads the `design` query param, resolves it against PUBLIC_DESIGNS (the same
// single source of truth the rest of the site uses), and renders top→bottom:
//   1. a swipeable photo carousel (initCarousel, dots) — the owner's custom
//      photos when present, else the design's default renders
//   2. the title + price
//   3. an "about this design" blurb (per-design placeholder copy)
//   4. a related-products rail (initCarousel scroller, peek of next card)
//
// The per-design NAME, ABOUT text and PHOTO carousel are OWNER-EDITABLE: each is
// tagged with a per-design override key so the inline editor (js/editor.js) can
// overlay a saved value for every visitor and, in edit mode, let the owner change
// it. Because these nodes are injected here — AFTER the editor's initial scan — we
// apply any saved override ourselves (so the public view is correct regardless of
// load order) and then call window.dugriEditor.notifyInjected() so edit mode binds
// the freshly-injected nodes.
//
// Everything is defensive: a missing/invalid ?design falls back to the first
// public design and never throws. Private designs aren't in PUBLIC_DESIGNS so
// they can't be deep-linked here.

import { PUBLIC_DESIGNS, fetchDesignNames } from './designs.js';
import { initCarousel } from './carousel.js';

const PRICE = 79;
const WAS = 129;

// ---- per-design "about" copy --------------------------------------------
// Placeholder Hebrew descriptions, keyed by design id. Generic-but-on-brand;
// the owner will refine each one (in edit mode). Any id missing here falls back
// to GENERIC. These are the DEFAULTS; a saved per-design override wins.
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

// A stored photo path must be one this server produced (16-hex content hash +
// raster ext). Defense in depth on the client too — never render an arbitrary URL.
const UPLOAD_PATH_RE = /^\/content-uploads\/[a-f0-9]{16}\.(webp|jpe?g|png)$/;

// ---- per-design override keys (shared with the editor + server) ----------
// All product pages share page="product.html", so the DESIGN id is encoded into
// the key. Keep in sync with editor.js/content.js key validation (kebab, ≤61).
export function overrideKeys(id) {
  return {
    name: `product-${id}-name`,
    about: `product-${id}-about`,
    photos: `product-${id}-photos`,
  };
}

/** The saved text override for `key`, or null when none. */
export function overrideText(overrides, key) {
  const e = overrides && overrides[key];
  return e && e.text != null ? e.text : null;
}

/** The owner's custom photo paths for a design (validated), or [] when none. */
export function photosFromOverride(overrides, id) {
  const k = overrideKeys(id).photos;
  const e = overrides && overrides[k];
  const imgs = e && Array.isArray(e.imgs) ? e.imgs : [];
  return imgs.filter((p) => UPLOAD_PATH_RE.test(String(p || '')));
}

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

/** The design's DEFAULT gallery photos: front/back/board, board skipped when the
 *  design ships without one (e.g. kids). Each is a {src, label}. Sources the crisp
 *  hi-res renders (assets/designs/<id>/gallery-*.webp) rather than the tiny picker
 *  thumbs (thumb-*.webp), which upscale blurry full-width. */
function defaultShots(d) {
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

/** The gallery photos to show: the owner's CUSTOM photos when present, otherwise
 *  the design's default renders (fail-soft fallback). */
export function galleryShots(d, overrides) {
  const custom = photosFromOverride(overrides, d.id);
  if (custom.length) {
    return custom.map((src, i) => ({ src, label: `${d.name} · תמונה ${i + 1}` }));
  }
  return defaultShots(d);
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

// Module state so the photo-manager (edit mode) can rebuild the live carousels
// when the owner adds / removes / reorders photos.
let currentDesign = null;
let currentOverrides = {};
let galleryApi = null;
let zoomApi = null;

// Fill a track with slides. Shared by the inline gallery and the fullscreen zoom
// overlay (same shots, different presentation). Returns the track (or null).
function fillTrack(trackId, slideClass, shots) {
  const track = document.getElementById(trackId);
  if (!track) return null;
  track.textContent = '';
  for (const shot of shots) {
    const slide = el('div', slideClass, { 'data-label': shot.label });
    const img = el('img', null, {
      src: shot.src,
      alt: shot.label,
      loading: 'lazy',
      decoding: 'async',
    });
    slide.appendChild(img);
    track.appendChild(slide);
  }
  return track;
}

function renderGallery(shots) {
  const track = fillTrack('galleryTrack', 'pdp-gallery-slide', shots);
  if (!track) return;
  // Slideshow feel WITH dots (like the other site carousels); swipe/keys drive it.
  // No auto-advance so the shopper controls it.
  galleryApi = initCarousel(track, {
    mode: 'slideshow',
    autoplay: false,
    loop: false,
    dots: true,
    arrows: false,
    dotsInto: document.getElementById('galleryDots'),
  });
}

function renderZoomSlides(shots) {
  const track = fillTrack('pdpZoomTrack', 'pdp-zoom-slide', shots);
  if (!track) return;
  zoomApi = initCarousel(track, {
    mode: 'slideshow',
    dots: false,
    loop: true,
    arrows: false,
    autoplay: false,
    dotsInto: document.getElementById('pdpZoomDots'),
  });
}

// Fullscreen zoom overlay wiring (open/close/keyboard). Bound ONCE; the slides are
// (re)built by renderZoomSlides so a photo change can rebuild them without
// re-binding these listeners. Esc closes, body scroll is locked while open.
function wireZoom() {
  const overlay = document.getElementById('pdpZoom');
  const openBtn = document.getElementById('galleryZoomOpen');
  const closeBtn = document.getElementById('pdpZoomClose');
  if (!overlay || !openBtn || !closeBtn) return;

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

// Rebuild both carousels from a fresh shot list (owner added/removed/reordered a
// photo). Tears down the old instances first so initCarousel re-wires cleanly.
function rebuildCarousels(shots) {
  if (galleryApi) {
    galleryApi.destroy();
    galleryApi = null;
  }
  if (zoomApi) {
    zoomApi.destroy();
    zoomApi = null;
  }
  renderGallery(shots);
  renderZoomSlides(shots);
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

function renderInfo(d, overrides) {
  const keys = overrideKeys(d.id);

  // Title: tag it editable per-design and show the saved override if any.
  const title = document.getElementById('pdpTitle');
  const nameOv = overrideText(overrides, keys.name);
  const name = nameOv != null ? nameOv : d.name;
  if (title) {
    title.setAttribute('data-edit', keys.name);
    title.textContent = name;
  }
  document.title = `${name} · דוגרי`;

  const now = document.getElementById('pdpPriceNow');
  if (now) now.textContent = `מ-${PRICE} ₪`;
  const was = document.getElementById('pdpPriceWas');
  if (was) was.textContent = `${WAS} ₪`;

  // About: tag it editable per-design and show the saved override if any.
  const about = document.getElementById('pdpAbout');
  if (about) {
    about.setAttribute('data-edit', keys.about);
    const aboutOv = overrideText(overrides, keys.about);
    about.textContent = aboutOv != null ? aboutOv : ABOUT[d.id] || GENERIC;
  }

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
      'data-design-id': d.id,
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
    price.textContent = `מ-${PRICE} ₪`;

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

// Tag the gallery as an owner-editable photo array so the editor renders its
// add/remove/reorder manager in edit mode (product-<id>-photos).
function markPhotosEditable(d) {
  const gallery = document.querySelector('[data-testid="pdp-gallery"]');
  if (gallery) gallery.setAttribute('data-edit-photos', overrideKeys(d.id).photos);
}

// The editor fires this after the owner adds/removes/reorders a photo (it owns the
// server write + the key). Rebuild the live carousels from the new list — or the
// design defaults when the array is emptied (fail-soft fallback).
function onPhotosChanged(e) {
  if (!e.detail || !currentDesign) return;
  if (e.detail.key !== overrideKeys(currentDesign.id).photos) return;
  currentOverrides[e.detail.key] = Object.assign({}, currentOverrides[e.detail.key], {
    imgs: e.detail.imgs,
  });
  rebuildCarousels(galleryShots(currentDesign, currentOverrides));
}

// Apply the per-design NAME/ABOUT text overrides onto the already-rendered nodes
// (the core render used the defaults). Idempotent; safe to call with {}.
function applyTextOverrides(d, overrides) {
  const keys = overrideKeys(d.id);
  const title = document.getElementById('pdpTitle');
  const nameOv = overrideText(overrides, keys.name);
  if (title && nameOv != null) {
    title.textContent = nameOv;
    document.title = `${nameOv} · דוגרי`;
  }
  const about = document.getElementById('pdpAbout');
  const aboutOv = overrideText(overrides, keys.about);
  if (about && aboutOv != null) about.textContent = aboutOv;
}

// Overlay the owner-editable display names (GET /api/design-names — an admin
// template rename → themes.json display_he) as the BASE name layer: the main
// title, the browser tab, and every related-rail card. Runs INDEPENDENTLY of the
// content-override fetch (so a slow /api/design-names never delays content
// overrides / the editor), yet the per-design inline content override
// (product-<id>-name) still WINS: the main title is only set here when NO content
// name override is currently applied, and applyTextOverrides (content) overrides
// this base whenever it runs with an override present — so the outcome is the same
// regardless of which fetch resolves first. Fail-soft: an empty map leaves every
// built-in catalog name untouched.
function applyDesignNames(d, names) {
  const map = names || {};
  const main = map[d.id];
  // Respect an already-applied inline content name override (it wins over the
  // admin rename); currentOverrides is {} until /api/content resolves, so when
  // this runs first the title takes the rename and applyTextOverrides later
  // re-asserts the content override on top.
  const contentName = overrideText(currentOverrides, overrideKeys(d.id).name);
  if (main && contentName == null) {
    const title = document.getElementById('pdpTitle');
    if (title) title.textContent = main;
    document.title = `${main} · דוגרי`;
  }
  // Related rail: upgrade each card's visible name AND its data-label (the hover
  // caption) so they stay consistent; built-in stands for any id the map omits.
  for (const card of document.querySelectorAll('.pdp-rel-card[data-design-id]')) {
    const nm = map[card.getAttribute('data-design-id')];
    if (!nm) continue;
    card.setAttribute('data-label', nm);
    const nameEl = card.querySelector('.pdp-rel-name');
    if (nameEl) nameEl.textContent = nm;
  }
}

// Overlay the per-design overrides once they resolve: swap in saved name/about
// text and, if the owner curated custom photos, rebuild the carousels. Then hand
// off to the editor so edit mode binds the freshly-injected nodes. Runs even with
// {} so edit affordances still attach when there are no overrides.
function applyOverridesToPage(d, overrides) {
  currentOverrides = overrides || {};
  applyTextOverrides(d, currentOverrides);
  if (photosFromOverride(currentOverrides, d.id).length) {
    rebuildCarousels(galleryShots(d, currentOverrides));
  }
  if (window.dugriEditor && typeof window.dugriEditor.notifyInjected === 'function') {
    window.dugriEditor.notifyInjected();
  }
}

// Get this page's content overrides. Preferred path REUSES the editor's single
// /api/content fetch (window.dugriEditor.onReady) so the hottest endpoint isn't
// hit twice per load. Only when the editor engine isn't present do we fetch
// directly. Fail-soft: any error yields {} so the shipped defaults stand.
function loadOverrides() {
  const ed = typeof window !== 'undefined' ? window.dugriEditor : null;
  if (ed && typeof ed.onReady === 'function') {
    return new Promise((resolve) => ed.onReady((ov) => resolve(ov || {})));
  }
  return fetch('/api/content?page=product.html')
    .then((r) => (r.ok ? r.json() : { overrides: {} }))
    .then((data) => (data && data.overrides) || {})
    .catch(() => ({}));
}

// ---- boot ---------------------------------------------------------------
function boot() {
  const d = resolveDesign();
  if (!d) return; // no public designs at all — leave the static shell as-is
  currentDesign = d;
  currentOverrides = {};

  // FIRST PAINT must never block on the network: render the core PDP (gallery,
  // title, price, buy CTA, related) SYNCHRONOUSLY from the bundled catalog. A
  // slow / failed /api/content then only affects the per-design overrides, never
  // the shopper's ability to see the product and buy.
  const shots = galleryShots(d, currentOverrides); // defaults (no overrides yet)
  renderInfo(d, currentOverrides); // tags nodes + default name/about + price + buy
  renderGallery(shots);
  renderZoomSlides(shots);
  wireZoom();
  renderRelated(d);
  wireBack();
  markPhotosEditable(d);
  document.addEventListener('dugri:photos-changed', onPhotosChanged);

  // THEN overlay the per-design content overrides + the owner-editable names as
  // TWO INDEPENDENT, fail-soft fetches — never chained. The content-override path
  // (name/about text, curated photos, and the editor binding via notifyInjected)
  // applies the instant /api/content resolves, exactly as before this feature, so
  // a slow/down /api/design-names can NEVER delay it. The design-name overlay
  // applies whenever fetchDesignNames resolves (capped ~2.5s, {} on timeout/error);
  // it defers to a content name override so precedence holds either resolve order.
  loadOverrides().then((ov) => applyOverridesToPage(d, ov));
  fetchDesignNames().then((names) => applyDesignNames(d, names));
}

// Auto-boot only on the real page (a #galleryTrack exists). A bare test import of
// this module for the pure helpers must NOT boot / touch the network.
if (typeof document !== 'undefined' && document.getElementById('galleryTrack')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
