// configurator.js — pure logic for the static site configurator.
// No top-level DOM access. All DOM interaction is via an explicit element argument.

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

/** Clamp n into [min, max]. */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

/**
 * Parse a #rrggbb (or #rgb) hex string into {r,g,b} ints (0..255).
 * Throws on malformed input.
 */
function parseHex(hex) {
  if (typeof hex !== 'string') throw new Error('hex must be a string: ' + hex);
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error('invalid hex color: ' + hex);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** True iff value is a syntactically valid #rrggbb (6-digit) color string. */
export function isValidHex(hex) {
  return typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex.trim());
}

/**
 * Convert a hex color to HSL.
 * @returns {{h:number,s:number,l:number}} h in 0..360, s/l in 0..100.
 */
export function hexToHsl(hex) {
  const { r, g, b } = parseHex(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case rn:
        h = ((gn - bn) / d) % 6;
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return {
    h: Math.round(h * 1000) / 1000,
    s: Math.round(s * 100 * 1000) / 1000,
    l: Math.round(l * 100 * 1000) / 1000,
  };
}

/**
 * Convert HSL ({h:0..360, s:0..100, l:0..100}) to a #rrggbb hex string.
 * Round-trip-stable with hexToHsl within rounding tolerance.
 */
export function hslToHex({ h, s, l }) {
  const hn = ((h % 360) + 360) % 360;
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;

  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;

  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hn < 60) {
    rp = c;
    gp = x;
  } else if (hn < 120) {
    rp = x;
    gp = c;
  } else if (hn < 180) {
    gp = c;
    bp = x;
  } else if (hn < 240) {
    gp = x;
    bp = c;
  } else if (hn < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }

  const toByte = (v) => {
    const n = Math.round((v + m) * 255);
    return clamp(n, 0, 255).toString(16).padStart(2, '0');
  };

  return '#' + toByte(rp) + toByte(gp) + toByte(bp);
}

// ---------------------------------------------------------------------------
// Palette derivation
// ---------------------------------------------------------------------------

/**
 * Index of the design's "main" slot: the most vivid anchor that also reads as
 * a true brand colour rather than a near-black or near-white tint.
 *
 * We take the highest-saturation anchors, then break ties toward mid-lightness
 * (closest to ~50). Picking max-saturation alone broke ties to the lowest
 * index, landing "main" on the darkest slot (e.g. birthday -> dark purple
 * instead of brand magenta). Closest-to-50 lightness keeps the vivid, readable
 * colour as the main.
 *
 * @returns {number} index into `anchors`.
 */
export function mostSaturatedIndex(anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    throw new Error('anchors must be a non-empty array');
  }
  // Highest saturation first.
  let bestS = -Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const { s } = hexToHsl(anchors[i]);
    if (s > bestS) bestS = s;
  }
  // Among the (near-)highest-saturation anchors, pick the one with lightness
  // closest to 50 (most vivid AND mid-lightness). A small epsilon treats
  // rounding-equal saturations as ties.
  const EPS = 0.5;
  let bestIdx = 0;
  let bestLDist = Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const { s, l } = hexToHsl(anchors[i]);
    if (s < bestS - EPS) continue;
    const lDist = Math.abs(l - 50);
    if (lDist < bestLDist) {
      bestLDist = lDist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Derive a palette aligned to `anchors` from a chosen main color.
 *
 * Let m = anchors[mostSaturatedIndex(anchors)]. For every anchor a:
 *   result = hslToHex({
 *     h: (mainH + (aH - mH) + 360) % 360,
 *     s: clamp(mainS + (aS - mS), 0, 100),
 *     l: clamp(mainL + (aL - mL), 0, 100),
 *   })
 * So choosing a main color shifts each slot by the SAME delta the original
 * anchor had relative to the design's main anchor. The main slot ≈ mainHex.
 *
 * @returns {string[]} hex colors, same length/order as anchors.
 */
export function derivePalette(mainHex, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    throw new Error('anchors must be a non-empty array');
  }
  const mainIdx = mostSaturatedIndex(anchors);
  const main = hexToHsl(mainHex);
  const m = hexToHsl(anchors[mainIdx]);

  return anchors.map((a) => {
    const ah = hexToHsl(a);
    return hslToHex({
      h: (((main.h + (ah.h - m.h)) % 360) + 360) % 360,
      s: clamp(main.s + (ah.s - m.s), 0, 100),
      l: clamp(main.l + (ah.l - m.l), 0, 100),
    });
  });
}

/**
 * Derive the palette and apply it to a root element's CSS custom properties:
 * --c0..--cN. Returns the derived palette array.
 */
export function applyPalette(rootEl, mainHex, anchors) {
  const derived = derivePalette(mainHex, anchors);
  derived.forEach((c, i) => rootEl.style.setProperty('--c' + i, c));
  return derived;
}

/**
 * Apply the design's ORIGINAL anchor colors directly to --c0..--cN
 * (no derivation). Used to show a design in its own original colors.
 * @returns {string[]} the anchors applied.
 */
export function applyOriginal(rootEl, anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    throw new Error('anchors must be a non-empty array');
  }
  anchors.forEach((c, i) => rootEl.style.setProperty('--c' + i, c));
  return anchors.slice();
}

/** The design's "main" original color (its most-saturated anchor). */
export function mainAnchor(anchors) {
  return anchors[mostSaturatedIndex(anchors)];
}

/**
 * Resolve the page-theme tint (accent + light background) for the configurator.
 * Priority: an explicitly chosen slider colour, then the design's representative
 * accent, then its most-saturated anchor, then a guaranteed fallback — so the
 * page theme NEVER keeps a previous design's stale tint, even for a fixed design
 * shipped without an accent and without anchors.
 * @param {?string} colorHex chosen slider colour, or null/'' for the original
 * @param {?string} accent   the design's representative accent (d.accent)
 * @param {string[]} [anchors=[]] the design's anchor colours
 * @param {string} fallback  brand default tint (never falls through to null)
 * @returns {string}
 */
export function pageTint(colorHex, accent, anchors = [], fallback) {
  const anch = anchors && anchors.length ? mainAnchor(anchors) : null;
  return colorHex || accent || anch || fallback;
}

/**
 * A soft, very light tint of a color — for theming a page/stage background
 * to the chosen color without overpowering it.
 * @param {string} hex
 * @param {number} [l=95] target lightness (0..100)
 * @param {number} [maxS=55] cap on saturation (0..100)
 */
export function lightTint(hex, l = 95, maxS = 55) {
  const { h, s } = hexToHsl(hex);
  return hslToHex({ h, s: Math.min(s, maxS), l });
}

// ---------------------------------------------------------------------------
// Order building
// ---------------------------------------------------------------------------

export const PLAN_LABELS = {
  base: 'החבילה המלאה',
};

export const PLAN_PRICES = {
  base: 79,
};

/**
 * Build a WhatsApp order message + deep link.
 * @param {object} opts
 * @param {'base'} opts.plan
 * @param {string} opts.designId
 * @param {string} opts.designName
 * @param {string} opts.colorName
 * @param {string} opts.mainHex
 * @param {string} [opts.whatsapp='972546577715']
 * @returns {{summary:string, whatsappUrl:string, price:number, planLabel:string}}
 */
export function buildOrder({
  plan,
  designId,
  designName,
  colorName,
  mainHex,
  whatsapp = '972546577715',
}) {
  const planLabel = PLAN_LABELS[plan];
  const price = PLAN_PRICES[plan];
  if (planLabel === undefined || price === undefined) {
    throw new Error('unknown plan: ' + plan);
  }

  const summary = `הזמנה: ${planLabel} · עיצוב ${designName} · צבע ${colorName} (${mainHex}) · ${price} ש"ח`;

  const msg =
    `היי! אשמח להזמין משחק דוגרי.\n` +
    `חבילה: ${planLabel} (${price} ש"ח)\n` +
    `עיצוב: ${designName}\n` +
    `צבע: ${colorName} (${mainHex})`;

  const whatsappUrl = `https://wa.me/${whatsapp}?text=${encodeURIComponent(msg)}`;

  return { summary, whatsappUrl, price, planLabel, designId };
}

/**
 * Translate the raw English ids that options.html writes into the URL
 * (design=<id>, color=<id>|original, plan=<id>) into Hebrew display names.
 *
 * Pure: takes the lookups explicitly so it's testable without DOM/imports.
 * Unknown ids fall back to the raw value rather than throwing.
 *
 * @param {{design?:string,color?:string,plan?:string}} ids
 * @param {Array<{id:string,name:string}>} designs   DESIGNS catalog
 * @param {Array<{id:string,name:string}>} mainColors MAIN_COLORS catalog
 * @param {Record<string,string>} planLabels         plan id -> Hebrew label
 * @returns {{designName:string, colorName:string, plan:string, planLabel:string}}
 */
export function selectionNamesFromIds(ids, designs, mainColors, planLabels) {
  const { design = '', color = '', plan = '' } = ids || {};

  let designName = design;
  if (design) {
    const d = (designs || []).find((x) => x && x.id === design);
    if (d && d.name) designName = d.name;
  }

  let colorName = color;
  if (color === 'original') {
    colorName = 'מקורי';
  } else if (color) {
    const c = (mainColors || []).find((x) => x && x.id === color);
    if (c && c.name) colorName = c.name;
  }

  const planLabel = (planLabels && planLabels[plan]) || plan;

  return { designName, colorName, plan, planLabel };
}

// ---------------------------------------------------------------------------
// Phone (Israeli mobile) normalization + validation
// ---------------------------------------------------------------------------

/**
 * Normalize a raw phone string into the canonical Israeli local mobile form
 * (0XXXXXXXXX, 10 digits). Handles the shapes iPhone/browser autofill produces:
 *   - spaces, dashes, dots, parentheses, non-breaking spaces (stripped)
 *   - a leading + and/or the 972 country code (converted to a local 0)
 *   - a bare mobile with no leading 0 (e.g. 546577715 -> 0546577715)
 * The result is NOT guaranteed valid — callers validate with isValidIlMobile.
 * Non-mobile / garbage input is returned digit-normalized so validation fails.
 * @param {string} v
 * @returns {string}
 */
export function normalizeIlPhone(v) {
  let s = String(v == null ? '' : v)
    // strip spaces (incl. NBSP/thin space), dashes, dots, parentheses, slashes
    .replace(/[\s().\-/]/g, '')
    .replace(/^\+/, ''); // a leading + (kept only at the very start)
  // Country code: 972 -> local 0. Tolerate the autofilled "+972 0..." variant
  // (972 followed by a redundant leading 0) by not doubling the 0.
  if (s.startsWith('972')) {
    s = s.slice(3).replace(/^0+/, '');
    s = '0' + s;
  } else if (/^5\d{8}$/.test(s)) {
    // bare mobile without the leading 0 (e.g. 546577715)
    s = '0' + s;
  }
  return s;
}

/**
 * True iff `v` is (or normalizes to) a valid Israeli mobile number: 05X plus 7
 * more digits — 10 digits total, e.g. 0546577715. Accepts every autofill shape
 * normalizeIlPhone handles (+972…, 972…, spaced/dashed, no leading 0).
 * @param {string} v
 * @returns {boolean}
 */
export function isValidIlMobile(v) {
  return /^05\d{8}$/.test(normalizeIlPhone(v));
}

// ---------------------------------------------------------------------------
// Honoree name validation
// ---------------------------------------------------------------------------

// Allowed characters in a honoree name: Hebrew letters (the whole Hebrew block
// ֐-׿), English letters, spaces, hyphen and apostrophe. Digits and any
// other symbol are rejected.
const HONOREE_ALLOWED_RE = /^[֐-׿A-Za-z '-]+$/;
// Must contain at least one actual letter (Hebrew or English) — a value made of
// only spaces/hyphens/apostrophes is not a real name.
const HONOREE_LETTER_RE = /[֐-׿A-Za-z]/;

/**
 * True iff `v` is an acceptable honoree name: non-empty once trimmed, made up
 * ONLY of letters (Hebrew or English) plus spaces, hyphens and apostrophes, and
 * containing at least one letter. Any digit or other symbol makes it invalid.
 * @param {string} v
 * @returns {boolean}
 */
export function isValidHonoreeName(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return false;
  if (!HONOREE_ALLOWED_RE.test(s)) return false;
  return HONOREE_LETTER_RE.test(s);
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

/**
 * Validate a designs manifest and the list of selectable main colors.
 *
 * @param {Array<{id?:string,name?:string,anchors?:string[],products?:object}>} designs
 * @param {Array<{id?:string,name?:string,hex?:string}>} mainColors
 * @returns {string[]} array of human-readable error strings (empty = valid).
 */
export function validateManifest(designs, mainColors) {
  const errors = [];

  if (!Array.isArray(designs) || designs.length === 0) {
    errors.push('designs must be a non-empty array');
  } else {
    designs.forEach((d, i) => {
      const id = (d && d.id) || `#${i}`;
      if (!d || typeof d !== 'object') {
        errors.push(`design ${id}: not an object`);
        return;
      }
      if (!Array.isArray(d.anchors)) {
        errors.push(`design ${id}: missing anchors`);
      } else {
        // A 'fixed' design (never recoloured) legitimately has NO anchors; a
        // slider design needs at least one anchor to recolour.
        if (d.anchors.length === 0 && d.recolor !== 'fixed') {
          errors.push(`design ${id}: missing anchors`);
        }
        d.anchors.forEach((a, ai) => {
          if (!isValidHex(a)) {
            errors.push(`design ${id}: anchor[${ai}] is not a valid #rrggbb: ${a}`);
          }
        });
      }
      const p = d.products;
      if (!p || typeof p !== 'object') {
        errors.push(`design ${id}: missing products`);
      } else {
        // front + back are required; board is OPTIONAL (a design may ship without
        // one — e.g. kids, whose board template is still pending).
        ['front', 'back'].forEach((slot) => {
          if (!p[slot]) errors.push(`design ${id}: missing product "${slot}"`);
        });
      }
    });
  }

  if (!Array.isArray(mainColors) || mainColors.length === 0) {
    errors.push('mainColors must be a non-empty array');
  } else {
    mainColors.forEach((c, i) => {
      const id = (c && c.id) || `#${i}`;
      if (!c || !isValidHex(c.hex)) {
        errors.push(`main color ${id}: invalid hex: ${c && c.hex}`);
      }
    });
  }

  return errors;
}

/**
 * Like validateManifest but throws if the manifest is invalid.
 * @returns {true} when valid.
 */
export function assertManifest(designs, mainColors) {
  const errors = validateManifest(designs, mainColors);
  if (errors.length) {
    throw new Error('Invalid manifest:\n' + errors.join('\n'));
  }
  return true;
}
