// design-images.js — buyer-facing reader for the owner's per-design GALLERY
// (server/design-images.js + GET /api/design-images).
//
// The owner curates each design's gallery: replace a base render, add named extra
// photos, and choose per picture whether it shows on the products grid and/or the
// product detail page, in an order they control. This module fetches that config
// and resolves, per surface, the ORDERED list of pictures to render.
//
// EVERYTHING here is fail-safe: the shopper must always see a product and be able
// to buy, so a slow, failed, or malformed config fetch must never block or break a
// page — it just falls back to the shipped renders. The fetch is timeout-bounded
// (AbortController) and every override path is validated to an our-own upload path.

// A stored path must be one the server produced (16-hex content hash + raster
// ext) — identical to the server's UPLOAD_PATH_RE. Defense in depth on the client
// too: never render an arbitrary URL a config map might somehow contain.
export const UPLOAD_PATH_RE = /^\/content-uploads\/[a-f0-9]{16}\.(webp|jpe?g|png)$/;

// How long to wait for the config before giving up and using the shipped renders.
const FETCH_TIMEOUT_MS = 3000;

// Base (shipped-render) slots in their default display order. `photo` is the
// deck's PHOTO CARD (the 104th front, which carries the buyer's four pawn photos
// — the storefront render always uses the GENERIC Dugri fallback art). It sits
// with the other card renders, ahead of the board.
const DEFAULT_ORDER = ['store', 'front', 'back', 'photo', 'board'];

// Slots a design may or may not ship. `board`: a design can have no board at all
// (kids). `photo`: only a PORTRAIT card-structure design renders a photo card,
// and only once the generic fallback art exists. Both are surfaced from
// `thumbs.<slot>` — the canonical "this design ships that render" indicator — and
// both can still be surfaced by an owner override alone (see baseSlots).
const OPTIONAL_SLOTS = new Set(['photo', 'board']);

/** The shipped asset path for a BUILT-IN design's base slot (the fallback picture). */
export function baseSrc(designId, slot) {
  return slot === 'store'
    ? `assets/designs/${designId}/store.webp`
    : `assets/designs/${designId}/gallery-${slot}.webp`;
}

/**
 * The SHIPPED render for a design's base slot — the picture the gallery shows when
 * the owner set no override, and the one a broken override falls back to. Null when
 * the design ships nothing for that slot.
 *
 * TWO layouts, ONE resolver, so a slot can never count as shipped on one surface
 * and missing on another:
 *   • BUILT-IN — committed rasters under site/assets/designs/<id>/. store/front/back
 *     always ship; an OPTIONAL slot (board, photo) ships only when the design has
 *     that thumb (the canonical per-slot indicator — matches designs.js
 *     designShipsBoard). A design without one can still CARRY an override (#159).
 *   • CUSTOM (an uploaded template) — no committed rasters at all: its shipped
 *     renders ARE the template's own SVGs, already resolved onto `design.img` by
 *     loadCustomDesigns (/api/template-image/<slug>/<slot>). It has no store cover
 *     and no photo card, so those slots ship nothing and surface only from an
 *     owner upload — which is exactly how an unshipped board behaves for a
 *     built-in design.
 */
export function shippedSrc(design, slot) {
  if (design && design.custom) {
    const img = design.img || {};
    return typeof img[slot] === 'string' && img[slot] ? img[slot] : null;
  }
  const id = design && design.id;
  if (!id) return null;
  if (OPTIONAL_SLOTS.has(slot)) {
    return design.thumbs && design.thumbs[slot] ? baseSrc(id, slot) : null;
  }
  return slot === 'store' || slot === 'front' || slot === 'back' ? baseSrc(id, slot) : null;
}

/** Whether a design SHIPS a render for a base slot (see shippedSrc). */
function shipsRender(design, slot) {
  return !!shippedSrc(design, slot);
}

/** The base slots to consider for a design, in default order: store/front/back
 *  always; an optional slot (board, photo) when the design ships one OR the owner
 *  uploaded an override for it (so a boardless design that gains a board picture
 *  surfaces it — #159, and the same now holds for a photo card). */
function baseSlots(design, baseCfg) {
  return DEFAULT_ORDER.filter((s) => {
    if (!OPTIONAL_SLOTS.has(s) || shipsRender(design, s)) return true;
    const cfg = baseCfg && baseCfg[s];
    return !!(cfg && validImg(cfg.img));
  });
}

function validImg(p) {
  return typeof p === 'string' && UPLOAD_PATH_RE.test(p);
}

// Default per-surface visibility of a BASE slot when the owner set no explicit
// flag. Everything shows EXCEPT the store cover on the product-detail page (that
// gallery leads with the card renders, not the shop cover). MUST match the same
// rule in server/design-images.js (baseDefault).
function baseDefault(slot, flag) {
  return !(slot === 'store' && flag === 'onProduct');
}

/**
 * The ordered pictures to show for `design` on `surface` ('products' | 'product').
 * Each item: { key, src, fallback, name }. `src` is the picture to render (owner
 * override when set, else the shipped render); `fallback` is the shipped render an
 * <img> onerror should swap back to; `name` is an optional caption (extra photos).
 * Tolerates any shape of `map` (missing / garbage → shipped defaults).
 */
export function galleryFor(map, design, surface) {
  const flag = surface === 'product' ? 'onProduct' : 'onProducts';
  const id = design && design.id;
  if (!id) return [];
  const cfg = (map && typeof map === 'object' && map[id]) || {};
  const baseCfg = cfg.base && typeof cfg.base === 'object' ? cfg.base : {};
  const photos = Array.isArray(cfg.photos) ? cfg.photos : [];
  const avail = baseSlots(design, baseCfg);
  const availSet = new Set(avail);
  const photoById = {};
  for (const p of photos) if (p && typeof p.id === 'string') photoById[p.id] = p;

  // Canonical key order: the owner's stored order first (existing keys only), then
  // any known key not yet placed (base in default order, then photos as stored) so
  // a newly added picture never vanishes just because `order` predates it.
  const known = [...avail, ...photos.map((p) => p && p.id).filter(Boolean)];
  const knownSet = new Set(known);
  const order = [];
  const seen = new Set();
  const place = (k) => {
    if (knownSet.has(k) && !seen.has(k)) {
      seen.add(k);
      order.push(k);
    }
  };
  if (Array.isArray(cfg.order)) for (const k of cfg.order) place(k);
  for (const k of known) place(k);

  const items = [];
  for (const key of order) {
    if (availSet.has(key)) {
      const bc = baseCfg[key] || {};
      // Explicit owner flag wins; otherwise the slot's per-surface default decides.
      const visible = typeof bc[flag] === 'boolean' ? bc[flag] : baseDefault(key, flag);
      if (!visible) continue;
      // A shipped slot falls back to its shipped render on a broken override; a
      // slot with NO shipped render (an override-only board or photo card) has no
      // fallback — it's DROPPABLE, so a broken upload removes the slide, not 404s.
      const shipped = shippedSrc(design, key);
      const ships = !!shipped;
      const fallback = shipped || '';
      const src = validImg(bc.img) ? bc.img : shipped;
      if (!src) continue; // nothing to show (no override + no shipped render)
      items.push({ key, src, fallback, name: '', droppable: !ships });
    } else {
      const p = photoById[key];
      if (!p || p[flag] === false || !validImg(p.img)) continue;
      // Extra photos have no shipped render → DROPPABLE on a broken upload.
      items.push({
        key,
        src: p.img,
        fallback: '',
        name: typeof p.name === 'string' ? p.name : '',
        droppable: true,
      });
    }
  }

  // An EMPTY gallery is an answer, not an accident. This used to end with a
  // "never blank" rescue: when the owner had hidden everything for this surface,
  // the shipped renders were pushed back in so a shopper always saw something.
  // That rescue is itself a mandatory-picture rule — it made "remove them all"
  // impossible — and the owner asked for no picture to be mandatory, having
  // confirmed the consequence (a design with nothing left shows no picture).
  // Her explicit choice now outranks the default.
  //
  // It can only be reached deliberately: with no config every slot is visible, so
  // an empty result means each one was turned off by hand. Both surfaces degrade
  // rather than break — products.html still renders the tile's name, price and
  // link and wires no carousel below two slides; product.html falls back to the
  // design's picker thumb. Nothing 404s and no layout collapses.
  return items;
}

/** Fetch the whole gallery-config map { designId: config }. NEVER rejects: a
 *  network error, non-OK status, timeout, or non-JSON body all resolve to {} so
 *  callers keep the shipped renders. */
export function loadDesignImages() {
  if (typeof fetch !== 'function') return Promise.resolve({});
  let timer = null;
  const opts = {};
  try {
    if (typeof AbortController === 'function') {
      const ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    }
  } catch {
    /* no AbortController — proceed without a hard timeout */
  }
  return fetch('/api/design-images', opts)
    .then((r) => (r && r.ok ? r.json() : { images: {} }))
    .then((data) => (data && data.images && typeof data.images === 'object' ? data.images : {}))
    .catch(() => ({}))
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}
