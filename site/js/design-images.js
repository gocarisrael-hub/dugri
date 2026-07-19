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

// Base (shipped-render) slots in their default display order.
const DEFAULT_ORDER = ['store', 'front', 'back', 'board'];

/** The shipped asset path for a design's base slot (the fallback picture). */
export function baseSrc(designId, slot) {
  return slot === 'store'
    ? `assets/designs/${designId}/store.webp`
    : `assets/designs/${designId}/gallery-${slot}.webp`;
}

/** Whether a design SHIPS a static render for a base slot. store/front/back always
 *  ship; a board render ships only when the design has a board thumb (the canonical
 *  board-render indicator — matches designs.js designShipsBoard). A boardless
 *  design can still CARRY a board OVERRIDE (#159), but has no shipped board file to
 *  fall back to. */
function shipsRender(design, slot) {
  if (slot === 'board') return !!(design && design.thumbs && design.thumbs.board);
  return slot === 'store' || slot === 'front' || slot === 'back';
}

/** The base slots to consider for a design, in default order: store/front/back
 *  always; board when the design ships one OR the owner uploaded a board override
 *  for it (so a boardless design that gains a board picture surfaces it — #159). */
function baseSlots(design, baseCfg) {
  const hasBoardOverride = !!(baseCfg && baseCfg.board && validImg(baseCfg.board.img));
  return DEFAULT_ORDER.filter((s) => s !== 'board' || shipsRender(design, s) || hasBoardOverride);
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
      const ships = shipsRender(design, key);
      // A shipped slot falls back to its static render on a broken override; a
      // slot with NO shipped render (a boardless board via override only) has no
      // fallback — it's DROPPABLE, so a broken upload removes the slide, not 404s.
      const fallback = ships ? baseSrc(id, key) : '';
      const src = validImg(bc.img) ? bc.img : ships ? baseSrc(id, key) : null;
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

  // Never blank: if the owner hid everything for this surface, fall back to the
  // shipped renders visible by default on it (so the shopper always sees the
  // product, and the detail page still won't lead with the shop cover). Only
  // slots that actually ship a static render qualify (never a phantom board).
  if (items.length === 0) {
    for (const key of avail) {
      if (!baseDefault(key, flag) || !shipsRender(design, key)) continue;
      const fallback = baseSrc(id, key);
      items.push({ key, src: fallback, fallback, name: '', droppable: false });
    }
  }
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
