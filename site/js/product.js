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
// The per-design NAME, ABOUT text, PHOTO carousel AND the fixed section copy (the
// "about" heading, the "what's inside" list, the buy CTA + note, the related-rail
// headings — tagged data-edit-pd in product.html) are OWNER-EDITABLE: each is
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

import { PUBLIC_DESIGNS, fetchDesignNames, designShipsBoard } from './designs.js';
import { initCarousel } from './carousel.js';
import { fetchPricing } from './pricing.js';
import { loadDesignImages, overrideFor } from './design-images.js';

// Owner-editable store price. Seeded with the launch defaults so first paint is
// correct even before /api/pricing answers (boot re-stamps these once the
// timeout-bounded fetch resolves; a failure keeps the defaults).
let PRICE = 199;
let WAS = 239;

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
export function fieldKey(id, field) {
  return `product-${id}-${field}`;
}
export function overrideKeys(id) {
  return {
    name: fieldKey(id, 'name'),
    about: fieldKey(id, 'about'),
    photos: fieldKey(id, 'photos'),
  };
}

// product.html's fixed section copy (the "about" heading, the "what's inside"
// list, the buy CTA + note, the related-rail headings) USED to ship as a single
// design-agnostic data-edit="product-<field>" key, so an edit the owner already
// saved shows on EVERY product page. Those fields are now namespaced PER DESIGN
// (each is tagged data-edit-pd in the HTML). To lose nothing, every design reads
// this legacy key as a FALLBACK when it has no per-design override yet — so the
// previously-shared edit keeps showing on all pages until the owner re-edits that
// design (which saves it under the per-design key). Design-independent on purpose.
export function legacyFieldKey(field) {
  return `product-${field}`;
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

/** Whether the board gallery slide should appear for this design: true when the
 *  design SHIPS a board render (thumbs.board) OR the owner has uploaded a board
 *  override for it. A boardless design (e.g. kids) that gains a board override
 *  surfaces the slide from the override alone — no shipped gallery-board.webp
 *  exists for it, so nothing must depend on that static file. */
export function shouldShowBoard(d, designImages) {
  // Ships a board? Uses the SHARED designShipsBoard(d) (thumbs.board) so this and
  // the admin image manager (admin-images.html shipsSlot) agree on the one field.
  if (designShipsBoard(d)) return true;
  return !!overrideFor(designImages, d && d.id, 'board');
}

/** The design's DEFAULT gallery photos: front/back/board. The board slide is
 *  omitted only when the design ships no board AND has no board override
 *  (shouldShowBoard); a boardless design the owner uploaded a board for still
 *  shows it. Each is a {src, label}. Sources the crisp hi-res renders
 *  (assets/designs/<id>/gallery-*.webp) rather than the tiny picker thumbs
 *  (thumb-*.webp), which upscale blurry full-width.
 *
 *  `designImages` is the owner's per-design override map (js/design-images.js):
 *  a per-slot uploaded picture wins over the shipped static render, falling back
 *  to the static asset whenever no valid override is set for that slot. */
function defaultShots(d, designImages) {
  const thumbs = d.thumbs || {};
  const KIND = { front: 'קלף', back: 'גב הקלף', board: 'לוח המשחק' };
  const shots = ['front', 'back', 'board']
    .filter((k) => (k === 'board' ? shouldShowBoard(d, designImages) : !!thumbs[k]))
    .map((k) => {
      const staticSrc = `assets/designs/${d.id}/gallery-${k}.webp`;
      const override = overrideFor(designImages, d.id, k);
      // Does the design SHIP a static render for this slot? A boardless design has
      // no gallery-board.webp, so its board slide (present only via an override)
      // must NOT carry that non-existent file as a fallback — that would 404.
      const ships = !!thumbs[k];
      if (override) {
        // When a shipped render exists, carry it as `fallback` so a missing/broken
        // override file degrades to it (fillTrack wires the onerror). With no
        // shipped render (a boardless board), the override is the SOLE source: it
        // gets no fallback and is tagged `droppable` so fillTrack removes the whole
        // slide (and its dot) on error instead of showing a broken image.
        return ships
          ? { src: override, label: `${d.name} · ${KIND[k]}`, fallback: staticSrc }
          : { src: override, label: `${d.name} · ${KIND[k]}`, droppable: true };
      }
      return { src: staticSrc, label: `${d.name} · ${KIND[k]}` };
    });
  // Never render an empty gallery: fall back to the single picker thumb.
  if (!shots.length && d.thumb) shots.push({ src: d.thumb, label: d.name });
  return shots;
}

/** The gallery photos to show: the owner's CUSTOM photos when present, otherwise
 *  the design's default renders (with per-slot overrides). Fail-soft fallback. */
export function galleryShots(d, overrides, designImages) {
  const custom = photosFromOverride(overrides, d.id);
  if (custom.length) {
    return custom.map((src, i) => ({ src, label: `${d.name} · תמונה ${i + 1}` }));
  }
  return defaultShots(d, designImages);
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
let currentDesignImages = {}; // owner's per-design store/gallery image overrides
let galleryApi = null;
let zoomApi = null;
// True once a boardless design's OVERRIDE-ONLY board slide (no shipped render to
// fall back to) failed to load and was dropped, so we don't drop/rebuild twice
// (the gallery and zoom tracks each render — and error on — that image). Reset
// whenever the gallery is rebuilt from a fresh source (a new override may load).
let boardOverrideDropped = false;

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
    // A shot sourced from an owner OVERRIDE carries the shipped static render as
    // `fallback`. If the override file is missing/broken, swap to the static asset
    // once (so a broken upload never shows a broken slide). Guarded by `once` so a
    // failing fallback can't loop.
    if (shot.fallback && shot.fallback !== shot.src) {
      img.addEventListener(
        'error',
        () => {
          img.src = shot.fallback;
        },
        { once: true }
      );
    } else if (shot.droppable) {
      // A `droppable` shot is a boardless design's override-only board slide: there
      // is NO shipped render to fall back to. If the uploaded file is missing/broken
      // (e.g. the entry exists in design-images.json but the upload isn't present on
      // this instance), DROP the whole slide + its dot rather than show a broken
      // image — removing it is the only non-404 degradation. `once` + the module
      // guard keep it to a single rebuild across both tracks.
      img.addEventListener('error', dropBoardSlide, { once: true });
    }
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

// A boardless design's override-only board slide failed to load (no shipped render
// to degrade to). Drop that slide entirely and rebuild both carousels from the
// remaining shots, so the gallery's dots + the fullscreen zoom stay consistent (no
// broken image, no phantom navigable dot). Guarded so the twin gallery/zoom image
// errors only trigger ONE rebuild.
function dropBoardSlide() {
  if (boardOverrideDropped || !currentDesign) return;
  boardOverrideDropped = true;
  const shots = galleryShots(currentDesign, currentOverrides, currentDesignImages).filter(
    (s) => !s.droppable
  );
  rebuildCarousels(shots);
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
  boardOverrideDropped = false; // fresh source: re-attempt any override-only board
  rebuildCarousels(galleryShots(currentDesign, currentOverrides, currentDesignImages));
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

// Namespace product.html's FIXED text sections. Each such element is tagged in the
// HTML with data-edit-pd="<field>" (design-agnostic). Here we stamp its per-design
// override key onto data-edit ("product-<id>-<field>") so the editor binds + saves
// it under a key unique to THIS design, then overlay the text with this precedence:
//   per-design override → legacy shared override (pre-namespacing) → shipped default
// The legacy fallback applies to EVERY design (not only the default), so an edit
// made before per-design namespacing keeps showing on ALL product pages until the
// owner re-edits that specific design — nothing silently vanishes. When no design
// resolves (d == null) the field keeps its legacy shared key, exactly matching the
// pre-namespacing behavior. Idempotent — safe to call to TAG and again to APPLY.
function applyPerDesignFields(d, overrides) {
  document.querySelectorAll('[data-edit-pd]').forEach((elm) => {
    const field = elm.getAttribute('data-edit-pd');
    if (!field) return;
    const key = d ? fieldKey(d.id, field) : legacyFieldKey(field);
    elm.setAttribute('data-edit', key);
    let ov = overrideText(overrides, key);
    // Every design falls back to the surviving legacy shared override until it has
    // its own per-design value (d == null already uses the legacy key above).
    if (ov == null && d) ov = overrideText(overrides, legacyFieldKey(field));
    if (ov != null) elm.textContent = ov;
  });
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
  applyPerDesignFields(d, currentOverrides);
  if (photosFromOverride(currentOverrides, d.id).length) {
    boardOverrideDropped = false; // fresh source: re-attempt any override-only board
    rebuildCarousels(galleryShots(d, currentOverrides, currentDesignImages));
  }
  if (window.dugriEditor && typeof window.dugriEditor.notifyInjected === 'function') {
    window.dugriEditor.notifyInjected();
  }
}

// Overlay the owner's per-design image overrides once the map resolves. Custom
// curated photos (content editor) still win; otherwise rebuild the gallery so any
// per-slot override picture replaces its static render. Fail-soft: a missing map
// just leaves the static assets in place. Skipped when custom photos are present.
function applyDesignImagesToPage(d, imagesMap) {
  currentDesignImages = imagesMap || {};
  if (photosFromOverride(currentOverrides, d.id).length) return; // curated photos win
  const hasOverride = ['front', 'back', 'board'].some((k) =>
    overrideFor(currentDesignImages, d.id, k)
  );
  if (hasOverride) {
    boardOverrideDropped = false; // fresh source: re-attempt any override-only board
    rebuildCarousels(galleryShots(d, currentOverrides, currentDesignImages));
  }
}

// Deliver this page's content overrides to `apply`. Preferred path REUSES the
// editor's single /api/content fetch (window.dugriEditor.onReady) so the hottest
// endpoint isn't hit twice per load — and CRUCIALLY runs `apply` SYNCHRONOUSLY the
// moment the editor marks ready, which is BEFORE the editor enables edit mode and
// captures each field's "last saved" baseline. That ordering is what lets a
// legacy-migrated value be applied to the DOM before the baseline is read, so an
// untouched, legacy-inherited field is never falsely dirty on entry. Only when the
// editor engine isn't present do we fetch directly. Fail-soft: any error yields {}
// so the shipped defaults stand.
function loadOverrides(apply) {
  const ed = typeof window !== 'undefined' ? window.dugriEditor : null;
  if (ed && typeof ed.onReady === 'function') {
    ed.onReady((ov) => apply(ov || {}));
    return;
  }
  fetch('/api/content?page=product.html')
    .then((r) => (r.ok ? r.json() : { overrides: {} }))
    .then((data) => apply((data && data.overrides) || {}))
    .catch(() => apply({}));
}

// ---- boot ---------------------------------------------------------------
function boot() {
  const d = resolveDesign();
  if (!d) {
    // No public design resolved (empty catalog / build error). Preserve the
    // pre-namespacing behavior for the fixed fields: stamp them with their legacy
    // SHARED key so editor.js still overlays any saved override for every visitor
    // and binds them in edit mode. Done synchronously so the editor's own scan
    // sees the data-edit before it runs.
    applyPerDesignFields(null, {});
    return;
  }
  currentDesign = d;
  currentOverrides = {};

  // FIRST PAINT must never block on the network: render the core PDP (gallery,
  // title, price, buy CTA, related) SYNCHRONOUSLY from the bundled catalog. A
  // slow / failed /api/content then only affects the per-design overrides, never
  // the shopper's ability to see the product and buy.
  const shots = galleryShots(d, currentOverrides, currentDesignImages); // defaults (no overrides yet)
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
  // applyOverridesToPage runs SYNCHRONOUSLY when the editor marks ready (see
  // loadOverrides), i.e. before edit mode captures per-field baselines — so a
  // legacy-inherited value is in the DOM first and never reads as unsaved.
  loadOverrides((ov) => applyOverridesToPage(d, ov));

  // Overlay the owner-editable store price when it resolves (timeout-bounded,
  // fail-safe). First paint already showed the launch default, so a slow/failed
  // fetch simply leaves that in place.
  fetchPricing().then((p) => {
    PRICE = p.store.now;
    WAS = p.store.was;
    restampPrices();
  });

  // Overlay the owner-editable design names (independent, fail-soft) — see the
  // note above; a name override applied here defers to a content name override.
  fetchDesignNames().then((names) => applyDesignNames(d, names));

  // Independently overlay the owner's per-design image overrides (store/gallery
  // pictures). Timeout-bounded + fail-safe: a slow/failed fetch never blocks the
  // first paint and just leaves the static gallery renders in place.
  loadDesignImages().then((map) => applyDesignImagesToPage(d, map));
}

// Re-stamp every rendered store price (the PDP now/was + each related card) from
// the current PRICE/WAS. Safe to call before or after related renders.
function restampPrices() {
  const now = document.getElementById('pdpPriceNow');
  if (now) now.textContent = `מ-${PRICE} ₪`;
  const was = document.getElementById('pdpPriceWas');
  if (was) was.textContent = `${WAS} ₪`;
  for (const el of document.querySelectorAll('.pdp-rel-price')) {
    el.textContent = `מ-${PRICE} ₪`;
  }
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
