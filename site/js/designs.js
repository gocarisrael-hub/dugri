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
};

/** Resolve a design id to its generator theme key, or null when unknown. */
export function themeForDesign(id) {
  return THEME_BY_DESIGN[id] || null;
}

/** The extra fields a design's theme requires (via themeForDesign); [] if none. */
export function extraFieldsForDesign(id) {
  const theme = themeForDesign(id);
  return (theme && THEME_EXTRA_FIELDS[theme]) || [];
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
  // is the per-product raster map {front,back[,board]} the templates gallery
  // carousel flips through. board is omitted for boardless designs (kids).
  thumb: g.thumb || null,
  thumbs: g.thumbs || null,
  products: g.products,
}));
