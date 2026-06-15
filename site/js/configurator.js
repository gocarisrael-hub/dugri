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
 * Index of the most-saturated anchor — the design's "main" slot.
 * Ties resolve to the first (lowest index).
 */
export function mostSaturatedIndex(anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    throw new Error('anchors must be a non-empty array');
  }
  let bestIdx = 0;
  let bestS = -Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const { s } = hexToHsl(anchors[i]);
    if (s > bestS) {
      bestS = s;
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

// ---------------------------------------------------------------------------
// Order building
// ---------------------------------------------------------------------------

const PLAN_LABELS = {
  base: 'בסיס',
  premium: 'פרימיום',
};

const PLAN_PRICES = {
  base: 79,
  premium: 139,
};

/**
 * Build a WhatsApp order message + deep link.
 * @param {object} opts
 * @param {'base'|'premium'} opts.plan
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
      if (!Array.isArray(d.anchors) || d.anchors.length === 0) {
        errors.push(`design ${id}: missing anchors`);
      } else {
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
        ['front', 'back', 'board'].forEach((slot) => {
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
