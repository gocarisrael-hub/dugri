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

// The DECK pictures, in the order the wizard shows them: all eight fronts, all
// eight backs, the board. Owner-uploaded only — nothing renders them — so a
// design has one only once she uploads it, and a design with none shows no row
// at all rather than a gap or a placeholder.
//
// They are stored beside the gallery slots (server/design-images.js keeps both
// under `base`) but are deliberately absent from DEFAULT_ORDER, so they can never
// appear on the shop grid or the product page. MUST match DECK_SLOTS in
// server/design-images.js.
const DECK_SLOTS = ['deckFronts', 'deckBacks', 'deckBoard'];

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

/** Whether a BASE slot is visible on this surface. Every base picture shows on
 *  BOTH surfaces unless the owner explicitly hid it (a stored `false`) — so the
 *  ONE arrangement she makes in the gallery editor is the one both surfaces
 *  render, first picture included.
 *
 *  This used to carry an exception: the store cover was hidden on the product
 *  page by default ("that gallery leads with the card renders"). It silently
 *  dropped picture #1 on every design she hadn't hand-ticked, so the shop tile
 *  showed one picture and clicking it opened the product page on the NEXT one.
 *  Ordering and per-surface visibility are hers to set now, so a slot-specific
 *  default can only surprise. MUST match the same rule in server/design-images.js
 *  and the gallery editor's checkboxes (site/admin-images.html baseFlag).
 */
function baseVisible(cfg, flag) {
  return !(cfg && cfg[flag] === false);
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
      // Visible unless the owner explicitly hid this picture on this surface.
      if (!baseVisible(bc, flag)) continue;
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

/**
 * The DECK pictures for `design`, in wizard order — `[{ key, src }]`.
 *
 * Only the ones the owner actually uploaded, so the result is 0..3 long. There is
 * no shipped fallback and no placeholder: nothing generates these pictures, so a
 * missing one means "not photographed yet", and inventing a stand-in would show
 * the buyer a promise the deck does not keep. A design with none returns `[]` and
 * the wizard renders no row at all.
 *
 * Same fail-soft contract as `galleryFor`: any shape of `map` (missing, garbage,
 * a slot holding a non-object or an off-origin path) yields fewer pictures, never
 * a throw and never an unvalidated src.
 */
export function deckFor(map, design) {
  const id = design && design.id;
  if (!id) return [];
  const cfg = (map && typeof map === 'object' && map[id]) || {};
  const baseCfg = cfg.base && typeof cfg.base === 'object' ? cfg.base : {};
  const out = [];
  for (const key of DECK_SLOTS) {
    const c = baseCfg[key];
    if (c && typeof c === 'object' && validImg(c.img)) out.push({ key, src: c.img });
  }
  return out;
}

/**
 * The SMALL-derivative URL for one of our own uploads, or null when the path
 * isn't one (see server/image-thumbs.js + GET /design-thumb/<name>).
 *
 * The gallery uploads are full-size photographs (180 KB–1 MB each) because the
 * product page shows them big. A surface that shows one at THUMBNAIL size asks
 * for it through here instead and gets ~15 KB. Validated on the way through, so
 * this can never turn a garbage config value into a request for an off-origin URL.
 */
export function thumbSrc(src) {
  const p = String(src || '');
  return UPLOAD_PATH_RE.test(p) ? p.replace('/content-uploads/', '/design-thumb/') : null;
}

/**
 * The picture for a design's PICKER TILE — the first of the owner's deck
 * pictures ("תמונות החפיסה": normally the eight fronts, else the eight backs,
 * else the board), downscaled.
 *
 * Null when she has uploaded none for this design, which is the majority case
 * and means "use the shipped build-time thumb". Deliberately the FIRST deck
 * picture rather than specifically `deckFronts`: the owner's uploads are the
 * order she chose, and a design photographed board-first should show its board
 * rather than nothing.
 */
export function deckPickerSrc(map, design) {
  const first = deckFor(map, design)[0];
  return first ? thumbSrc(first.src) : null;
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
