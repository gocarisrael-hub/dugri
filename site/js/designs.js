// designs.js — design catalog assembled from the generated manifest.
// GENERATED is produced by another build step (designs.generated.js).

import { GENERATED } from './designs.generated.js';

/** Selectable "main" colors the user can pick to recolor a design. */
// Vivid, electric brights in the spirit of the original designs (magenta /
// purple / royal-blue / cyan). All high-saturation so the derive keeps the
// brand's "vivid main over a pastel ground" feel.
export const MAIN_COLORS = [
  { id: 'magenta', name: 'מגנטה', hex: '#ED2A9C' },
  { id: 'pink', name: 'ורוד', hex: '#FF4FA3' },
  { id: 'violet', name: 'סגול', hex: '#7A3FF2' },
  { id: 'blue', name: 'כחול', hex: '#2D7FF9' },
  { id: 'cyan', name: 'תכלת', hex: '#15B8E6' },
  { id: 'teal', name: 'טורקיז', hex: '#0FBFA8' },
  { id: 'green', name: 'ירוק', hex: '#1FAE72' },
  { id: 'coral', name: 'אלמוג', hex: '#FF6A3D' },
];

/** Human-friendly (Hebrew) names per design id. */
const META = {
  bachelorette: { name: 'מסיבת רווקות' },
  marriage: { name: 'יום נישואין' },
  birthday: { name: 'יום הולדת' },
  japanese: { name: 'יפני' },
  posttrip: { name: 'חזרה מטיול' },
  neon: { name: 'ניאון' },
  kids: { name: 'יום הולדת לילדים' },
};

/**
 * Maps each orderable design id to the generator theme (a `generator/themes.json`
 * key) that produces its cards. Resolving a chosen design to a theme is what the
 * order flow needs: the resolved theme is sent on POST /api/collections and
 * stored on the collection so production knows which template to run.
 */
export const THEME_BY_DESIGN = {
  bachelorette: 'bachelorette',
  marriage: 'anniversary',
  birthday: 'birthday-girls',
  japanese: 'japanese',
  posttrip: 'trip comeback',
  neon: 'birthday-girls-neon',
  kids: 'birthday-boys-basketball',
};

/**
 * Extra fields each generator theme requires, mirroring the `extra_fields` arrays
 * in `generator/themes.json`. Inlined here (rather than fetched) so the order
 * wizard can decide which extra inputs to collect without a round-trip. Keep in
 * sync with themes.json if a theme's extra_fields change.
 */
export const THEME_EXTRA_FIELDS = {
  'trip comeback': [],
  bachelorette: [],
  'birthday-girls': [],
  'birthday-girls-neon': [],
  'birthday-boys-basketball': ['AGE'],
  anniversary: ['YEARS', 'NAME1', 'NAME2'],
  japanese: ['AGE'],
  'football-boys': [],
  grapefruit: [],
};

/**
 * Visibility per generator theme, mirroring each theme's `visibility` field in
 * `generator/themes.json` ("public" | "private"). Inlined here (rather than
 * fetched) so the public design lists can filter without a round-trip. A private
 * theme's design is hidden from the public grid and only revealed with a valid
 * access code. Keep in sync with themes.json if a theme's visibility changes;
 * any theme absent here defaults to public.
 */
export const VISIBILITY_BY_THEME = {
  'trip comeback': 'public',
  bachelorette: 'public',
  'birthday-girls': 'public',
  'birthday-girls-neon': 'public',
  'birthday-boys-basketball': 'public',
  anniversary: 'public',
  japanese: 'public',
  'football-boys': 'public',
  // Calibrated and on sale. Note this map only governs BUILT-IN designs (those in
  // THEME_BY_DESIGN); grapefruit reaches the storefront through
  // /api/custom-designs, which reads visibility LIVE from themes.json. Kept in
  // step anyway so the mirror never states something false.
  grapefruit: 'public',
};

/**
 * Required name language per generator theme, mirroring each theme's `language`
 * field in `generator/themes.json` ("english" | "hebrew"). Inlined here (rather
 * than fetched) so the order wizard can enforce the honoree-name script for the
 * chosen design without a round-trip. Keep in sync with themes.json if a theme's
 * language changes; any theme absent here falls back via languageForDesign().
 */
export const LANGUAGE_BY_THEME = {
  'trip comeback': 'english',
  bachelorette: 'english',
  'birthday-girls': 'english',
  'birthday-girls-neon': 'english',
  'birthday-boys-basketball': 'hebrew',
  anniversary: 'hebrew',
  japanese: 'english',
  'football-boys': 'english',
  grapefruit: 'hebrew',
};

// The design resolvers below accept EITHER a design id or a whole design object.
// The static maps cover the built-in designs; a custom (owner-uploaded) design
// is absent from them and carries its own metadata from /api/custom-designs
// instead, so when an object is passed its own values win. Passing an id keeps
// the previous behaviour exactly, which is what every built-in call site does.
function ownMeta(design) {
  return design && typeof design === 'object' ? design : null;
}

function designId(design) {
  const own = ownMeta(design);
  return own ? own.id : design;
}

/**
 * Resolve a design to its generator theme key, or null when unknown.
 *
 * Accepts an id OR a whole design object, like languageForDesign /
 * extraFieldsForDesign. THEME_BY_DESIGN covers only the BUILT-IN designs, so a
 * CUSTOM design (an owner-uploaded template) resolved to null — and the buyer
 * wizard sends this value as the order's `theme`, i.e. the deck would have been
 * ordered with no template to render it from. A design object's own `theme` wins;
 * passing an id behaves exactly as before.
 */
export function themeForDesign(design) {
  const own = ownMeta(design);
  if (own && typeof own.theme === 'string' && own.theme) return own.theme;
  return THEME_BY_DESIGN[designId(design)] || null;
}

/**
 * A design's required name language ('english' | 'hebrew') via its theme's
 * `language` in themes.json (mirrored in LANGUAGE_BY_THEME). Unknown/unmapped
 * designs default to 'hebrew' — the product and its UI are Hebrew-first, so a
 * design that declares no language is treated as needing a Hebrew name. Accepts
 * a language map override for testability.
 */
export function languageForDesign(design, languageByTheme = LANGUAGE_BY_THEME) {
  const own = ownMeta(design);
  if (own && typeof own.language === 'string' && own.language) return own.language;
  const theme = themeForDesign(designId(design));
  return (theme && languageByTheme[theme]) || 'hebrew';
}

/**
 * The extra fields a design requires ({AGE}, {YEARS}, {NAME1}+{NAME2}); [] if none.
 *
 * A CUSTOM design (an owner-uploaded template) is not in THEME_BY_DESIGN, so the
 * static map resolves it to [] — the wizard would never ask for the fields, the
 * order would be created anyway, and the title would render with UNFILLED
 * PLACEHOLDERS on a paying customer's deck. So a design that carries its own
 * metadata is believed over the map.
 */
export function extraFieldsForDesign(design) {
  const own = ownMeta(design);
  if (own && Array.isArray(own.extra_fields)) return own.extra_fields;
  const theme = themeForDesign(designId(design));
  return (theme && THEME_EXTRA_FIELDS[theme]) || [];
}

/**
 * A design's visibility ('public' | 'private') via its theme's visibility in
 * themes.json (mirrored in VISIBILITY_BY_THEME). Unknown/unmapped designs
 * default to 'public'. Accepts a visibility map override for testability.
 */
export function visibilityForDesign(id, visibilityByTheme = VISIBILITY_BY_THEME) {
  const theme = themeForDesign(id);
  return (theme && visibilityByTheme[theme]) || 'public';
}

/** Whether a design should appear in the PUBLIC design lists (not private). */
export function isPublicDesign(id, visibilityByTheme = VISIBILITY_BY_THEME) {
  return visibilityForDesign(id, visibilityByTheme) !== 'private';
}

/**
 * Whether a design SHIPS a board render. `thumbs.board` (the per-product raster
 * the galleries flip through, and the picture the admin image manager previews)
 * is the SINGLE canonical board-render indicator: the product detail gallery
 * (js/product.js shouldShowBoard) and the admin board slot (admin-images.html
 * shipsSlot) both key off THIS helper, so they can never disagree about whether a
 * design ships a board. `products.board` is only the SVG generation source and is
 * deliberately NOT consulted here — nothing must render off it.
 */
export function designShipsBoard(d) {
  return !!(d && d.thumbs && d.thumbs.board);
}

/**
 * Full design list: id, display name, anchors, recolor mode, product SVGs.
 * `recolor` is 'slider' (the colour slider recolors it) or 'fixed' (locked to its
 * original colours — a baked-in raster glow can't be recoloured). `products.board`
 * is optional: a design may ship without a board (its board tab is omitted).
 */
export const DESIGNS = Object.entries(GENERATED).map(([id, g]) => ({
  id,
  name: (META[id] || {}).name || id,
  // Generator theme (themes.json key) this design maps to; null if unmapped.
  theme: themeForDesign(id),
  anchors: g.anchors,
  hasRaster: !!g.hasRaster,
  recolor: g.recolor === 'fixed' ? 'fixed' : 'slider',
  // representative page-accent colour (present for EVERY design, incl. fixed ones
  // that have no anchors) so the page tint can switch even when the SVG can't.
  accent: g.accent || null,
  // `thumb` is the small picker thumbnail (= front) used by options.html; `thumbs`
  // is the per-product raster map {front,back[,board][,photo]} the templates gallery
  // carousel flips through. board is omitted for boardless designs (kids); photo
  // only exists for portrait designs whose photo-card art has shipped.
  thumb: g.thumb || null,
  thumbs: g.thumbs || null,
  products: g.products,
  // True once this design's artwork has been re-exported into the PORTRAIT
  // single-card structure (docs/card-structure-schema.md): its front/back renders
  // are then ONE 223.92×312 card each instead of a landscape A4 sheet of 8. The
  // storefront uses it only to size the picture box (js/product.js galleryAspect,
  // products.html gridAspect) — nothing else branches on it.
  portrait: !!g.portrait,
  // Visibility from the mapped theme (themes.json). Private designs are hidden
  // from the public grid until unlocked with an access code; `public` is the
  // convenient boolean the public lists filter on.
  visibility: visibilityForDesign(id),
  public: isPublicDesign(id),
}));

/**
 * The PUBLIC subset of DESIGNS — private designs (theme visibility "private")
 * filtered out. This is what the public design lists (options.html grid,
 * products.html gallery) render. Admin/order code paths use the full DESIGNS.
 */
export const PUBLIC_DESIGNS = DESIGNS.filter((d) => d.public);

/**
 * Fetch the owner-editable display names (GET /api/design-names) — an admin
 * "rename template" edits themes.json display_he, which this endpoint maps onto
 * design ids. Returns a plain `{ <id>: name }` object of non-empty string names.
 *
 * BUYER-FACING, so it MUST never block or break a page: an AbortController caps
 * the request at `timeoutMs` (~2.5s) and EVERY failure path — no fetch, network
 * error, timeout/abort, non-OK status, or malformed/`{}` JSON — resolves to `{}`,
 * letting the caller keep the built-in catalog names. Never rejects. `fetchImpl`
 * is injectable for tests.
 */
/**
 * Write the admin's current display names onto the catalog objects themselves.
 *
 * `name` is baked into DESIGNS from the built-in META table at module load, and
 * an admin rename lands in themes.json long after that build — so every page that
 * reads `d.name` renders the OLD name until this runs. Calling it once, as soon
 * as fetchDesignNames resolves, makes the rename reach everything downstream that
 * reads the catalog rather than the DOM: analytics labels, the `designName` the
 * wizard stores on the order, any list built after the fetch. Pages that already
 * painted still have to re-stamp their own nodes (see the callers) — this fixes
 * the SOURCE, not the pixels already on screen.
 *
 * Only non-empty string names for ids that exist are applied, so a partial or
 * malformed map can never blank a design's name.
 *
 * @param {Record<string,string>} names  as returned by fetchDesignNames
 * @param {Array<object>} [list]         catalog to update (defaults to all designs)
 * @returns {string[]} the ids whose name actually changed
 */
export function applyDesignNames(names, list = DESIGNS) {
  const map = names && typeof names === 'object' ? names : {};
  const changed = [];
  for (const d of Array.isArray(list) ? list : []) {
    if (!d || typeof d.id !== 'string') continue;
    const next = map[d.id];
    if (typeof next !== 'string') continue;
    const trimmed = next.trim();
    if (!trimmed || trimmed === d.name) continue;
    d.name = trimmed;
    changed.push(d.id);
  }
  return changed;
}

export async function fetchDesignNames({ fetchImpl, timeoutMs = 2500 } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return {};
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await f(
      '/api/design-names',
      controller ? { signal: controller.signal } : undefined
    );
    if (!res || !res.ok) return {};
    const data = await res.json();
    const names = data && data.names;
    if (!names || typeof names !== 'object') return {};
    const out = {};
    for (const [id, name] of Object.entries(names)) {
      if (typeof id === 'string' && typeof name === 'string' && name.trim()) out[id] = name;
    }
    return out;
  } catch {
    return {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A stored template picture URL must be an our-own /api/template-image/<slug>/<slot>
// path — defense in depth so a custom-design payload can never inject an off-origin
// image URL into the storefront.
const TEMPLATE_IMAGE_RE = /^\/api\/template-image\/[a-z0-9]+(?:-[a-z0-9]+)*\/(front|back|board)$/;
// A safe design id / slug (lowercase kebab) — mirrors the server's isSafeSlug.
const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Buyer-facing fetch of the CUSTOM designs — uploaded templates that became
// storefront products (GET /api/custom-designs). Each is normalized into the same
// shape as a catalog design so products.html / product.html can render it beside
// the built-in ones. `custom:true` marks it; its pictures are the template's SVGs
// (img.{front,back,board}). Fully fail-safe + timeout-bounded: any error → [] so a
// slow/failed/malformed response just leaves the built-in catalog. Off-origin or
// malformed image URLs are dropped; a design with no usable picture is skipped.
export async function loadCustomDesigns({ fetchImpl, timeoutMs = 2500 } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return [];
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await f(
      '/api/custom-designs',
      controller ? { signal: controller.signal } : undefined
    );
    if (!res || !res.ok) return [];
    const data = await res.json();
    const list = data && Array.isArray(data.designs) ? data.designs : [];
    const out = [];
    for (const d of list) {
      if (!d || typeof d.id !== 'string' || !SAFE_SLUG_RE.test(d.id)) continue;
      const src = d.img && typeof d.img === 'object' ? d.img : {};
      const img = {};
      for (const slot of ['front', 'back', 'board']) {
        if (typeof src[slot] === 'string' && TEMPLATE_IMAGE_RE.test(src[slot]))
          img[slot] = src[slot];
      }
      if (!img.front && !img.back && !img.board) continue; // nothing to show
      const name = typeof d.name === 'string' && d.name.trim() ? d.name : d.id;
      out.push({
        id: d.id,
        name,
        theme: typeof d.theme === 'string' ? d.theme : d.id,
        custom: true,
        public: true,
        recolor: 'fixed',
        accent: null,
        // A custom design has no tokenized anchors (its SVG is baked at its own
        // colours). Declared as an EMPTY array rather than left undefined so it
        // satisfies validateManifest's shape and every `d.anchors` reader alike.
        anchors: [],
        // thumbs mirrors the catalog shape so designShipsBoard(d) works uniformly.
        thumb: img.front || img.back || img.board,
        thumbs: { front: img.front, back: img.back, board: img.board },
        // `products` is the catalog's SVG-source map — what the buyer wizard
        // inlines for its previews (options.html ensurePanel / ccViews /
        // designZoomViews / the name-preview teaser) and what the board tab keys
        // off. A custom design's SVG source IS its template picture, so mirror it
        // here: the wizard then reads one field for every design and needs no
        // custom/built-in branch. `img` is kept as the custom-only alias the
        // storefront gallery resolver (design-images.js) already reads.
        products: { ...img },
        img,
        // Theme metadata the buyer wizard MUST honour for a custom design:
        // extraFieldsForDesign / languageForDesign believe a design object's own
        // values over the built-in static maps (which know nothing about an
        // uploaded template), but only if they survive this normalization. Dropped
        // here, an english template would be asked for a Hebrew name and a
        // template needing {AGE} would never be asked for it.
        extra_fields: Array.isArray(d.extra_fields)
          ? d.extra_fields.filter((k) => typeof k === 'string')
          : [],
        language: d.language === 'english' ? 'english' : 'hebrew',
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
