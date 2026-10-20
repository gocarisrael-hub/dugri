// Pure data helpers for the redesigned homepage (new.html): which designs it shows and with what pictures and colours, how a
// price reads, and the business-lead form's rules and server replies. No DOM here, so every rule is unit-tested
// (tests/unit/home-data.test.js). The page itself is js/home-new.js.

// The single cards and boards the owner approved in the redesign (DESIGN.md, "Shapes"): cut from the live deck sheets and
// print templates, each card's frame evened to 10.78% of its width. The cards that must match the print exactly (football-boys,
// daniel-amit, posttrip, and grapefruit's back) are cut whole from the template card or the print render instead, outline and
// frame as printed. They live in assets/home/, keyed by the live design id.
// `color` is the design's main colour, sampled from its real card; the panel and the tapped view derive from it.
// `sharp`: the widths of each card's sharper twin, <name>@2x.webp, as [fronts, back] (the 400 px card stays the src). Each twin is
// as wide as its source really holds: 800 from a print template, ~576 from a 2000 px deck sheet (8 cards a sheet), never upscaled.
// A design that is public but missing here still shows, from its own live pictures (a custom design's template card).
export const DESIGN_ART = {
  bachelorette: {
    color: '#fc789c',
    fronts: 8,
    back: true,
    board: true,
    board2x: true,
    sharp: [576, 800],
  },
  birthday: {
    color: '#9ce4fc',
    fronts: 1,
    back: true,
    board: true,
    board2x: true,
    sharp: [800, 800],
  },
  grapefruit: {
    color: '#f07848',
    fronts: 1,
    back: true,
    board: true,
    board2x: true,
    sharp: [800, 576],
  },
  marriage: {
    color: '#0048a8',
    fronts: 1,
    back: true,
    board: true,
    board2x: true,
    sharp: [800, 800],
  },
  // one front, from the template card that prints; the old cuts of fronts 2-8 had a heavier outline and older lettering
  'daniel-amit': {
    color: '#f5d98f',
    fronts: 1,
    back: true,
    board: true,
    board2x: true,
    sharp: [576, 576],
  },
  // the koi red of its art, so its panel and tapped view are a pastel red and not grey
  japanese: {
    color: '#b03a3a',
    fronts: 1,
    back: true,
    board: true,
    board2x: true,
    sharp: [800, 636],
  },
  // one front, from the print render (its template card is not public); the old cuts had a heavier outline and frame colour
  posttrip: {
    color: '#90d8e4',
    fronts: 1,
    back: true,
    board: true,
    board2x: true,
    sharp: [576, 576],
  },
  // one front: cut from the template card that prints (thin red line, patterned frame); fronts 2-8 exist only on the volume
  'football-boys': {
    color: '#2a52be',
    fronts: 1,
    back: true,
    board: true,
    board2x: true,
    sharp: [576, 576],
  },
  tarifa: {
    color: '#3d6b2c',
    fronts: 1,
    back: true,
    board: true,
    board2x: true,
    sharp: [800, 800],
  },
  kids: { color: '#1878fc', fronts: 1, back: true, board: true, board2x: false, sharp: [800, 576] }, // its board has no 2000 px source
};
// The approved order on the strip; designs the admin adds later follow, in the shop's order.
export const DESIGN_ORDER = [
  'bachelorette',
  'birthday',
  'grapefruit',
  'marriage',
  'daniel-amit',
  'japanese',
  'posttrip',
  'football-boys',
  'tarifa',
  'kids',
];
// The hero deck deals every design with a back except ברוקלין (an NBA-like logo on its back).
export const NOT_DEALT = new Set(['kids']);
const ART = 'assets/home/';
const FALLBACK_COLOR = '#a4e9ff';
const HEX_RE = /^#[0-9a-f]{6}$/i;

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (v) => '#' + v.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
const mix = (h, f, to) => hex(rgb(h).map((v, i) => v + (to[i] - v) * f));
const GROUND = [255, 241, 222];
const WHITE = [255, 255, 255];
const greyish = (h) => {
  const v = rgb(h);
  return Math.max(...v) - Math.min(...v) < 40;
};
export const luminance = (h) => {
  const c = rgb(h).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
/** The tapped view's colour: the design's colour lifted 62% toward white (toward the page when it is near-grey). */
export function floodColor(h) {
  return mix(h, 0.62, greyish(h) ? GROUND : WHITE);
}
/** The designs panel's two colours: lifted until black text reads at about 9:1 (luminance .42), then 62% further. */
export function panelColors(h) {
  const to = greyish(h) ? GROUND : WHITE;
  let f = 0.12;
  while (f < 0.9 && luminance(mix(h, f, to)) < 0.42) f += 0.03;
  return [mix(h, f, to), mix(h, f + (1 - f) * 0.62, to)];
}

const CARD_W = 400;
/** The srcset for one of the page's own card pictures, '' for any other picture (a custom design's template card). */
export function cardSrcset(src) {
  const m = /^assets\/home\/cards\/(.+)-(f\d+|b1)\.webp$/.exec(src || '');
  const art = m && DESIGN_ART[m[1]];
  if (!art || !art.sharp) return '';
  const w = art.sharp[m[2] === 'b1' ? 1 : 0];
  return `${src} ${CARD_W}w, ${src.replace(/\.webp$/, '@2x.webp')} ${w}w`;
}

/**
 * What the homepage shows for each public design, in the approved order.
 * @param {object[]} designs PUBLIC_DESIGNS plus loadCustomDesigns(), names already synced from /api/design-names
 * @returns {{id,name,color,fronts:string[],back:string|null,board:{src,srcset}|null,href,deal:boolean}[]}
 */
export function homeDesigns(designs) {
  const seen = new Set();
  const out = [];
  for (const d of designs || []) {
    if (!d || typeof d.id !== 'string' || seen.has(d.id) || d.public === false) continue;
    const art = DESIGN_ART[d.id];
    let fronts = [];
    let back = null;
    let board = null;
    if (art) {
      fronts = Array.from({ length: art.fronts }, (_, i) => `${ART}cards/${d.id}-f${i + 1}.webp`);
      back = art.back ? `${ART}cards/${d.id}-b1.webp` : null;
      // every approved design shows its board; the owner approved all ten (ברוקלין's and אואזיס's are her uploads, not shipped renders)
      if (art.board) {
        const src = `${ART}boards/${d.id}.webp`;
        board = {
          src,
          srcset: art.board2x ? `${src} 1200w, ${ART}boards/${d.id}@2x.webp 2000w` : '',
        };
      }
    } else if (d.custom && d.img && d.img.front) {
      // a design the admin made public after this page shipped: its own template card, which is one card already
      fronts = [d.img.front];
      back = d.img.back || null;
      if (d.img.board) board = { src: d.img.board, srcset: '' };
    } else continue; // a built-in design's live picture is a sheet of eight, not a card; it needs its art added here first
    seen.add(d.id);
    const color = (art && art.color) || (HEX_RE.test(d.accent || '') ? d.accent : FALLBACK_COLOR);
    out.push({
      id: d.id,
      name: typeof d.name === 'string' && d.name.trim() ? d.name : d.id,
      color,
      fronts,
      back,
      board,
      // the design view's order button skips the product page: straight into the wizard on this design, at its title
      // step, with the same params as the product page's own buy button (js/product.js)
      href: `options.html?design=${encodeURIComponent(d.id)}&step=2`,
      deal: !!back && !NOT_DEALT.has(d.id),
    });
  }
  const rank = (id) => {
    const i = DESIGN_ORDER.indexOf(id);
    return i < 0 ? DESIGN_ORDER.length : i;
  };
  return out
    .map((d, i) => [d, i])
    .sort((a, b) => rank(a[0].id) - rank(b[0].id) || a[1] - b[1])
    .map(([d]) => d);
}

/** How the price reads: "239 ₪", and the old price when a sale is on. */
export function priceText(pricing) {
  const store = (pricing && pricing.store) || {};
  const now = Number.isInteger(store.now) ? store.now : null;
  if (now == null) return null;
  const was =
    pricing.sale && pricing.sale.on && Number.isInteger(store.was) && store.was > now
      ? `${store.was} ₪`
      : null;
  return { now: `${now} ₪`, was };
}

// ---- the business-lead form ----
// The same rules as the server (server/business-leads.js), so a send the page lets through is one the server accepts.
const clean = (v) =>
  String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export function phoneOk(v) {
  const d = String(v || '').replace(/[\s\-.()[\]]/g, '');
  return /^0\d{8,9}$/.test(d) || /^(\+|00)9720?\d{8,9}$/.test(d);
}
// U+2066 … U+2069 keep the example number left-to-right inside the Hebrew line; U+2011 hyphens never break.
export const LEAD_MESSAGES = {
  name: {
    required: 'כתבו את השם שלכם',
    too_short: 'כתבו את השם שלכם',
    too_long: 'השם ארוך מדי',
    invalid: 'כתבו את השם שלכם',
  },
  company: {
    required: 'כתבו את שם החברה',
    too_short: 'כתבו את שם החברה',
    too_long: 'שם החברה ארוך מדי',
    invalid: 'כתבו את שם החברה',
  },
  phone: {
    required: 'כתבו מספר טלפון',
    too_short: 'מספר טלפון לא תקין, למשל ⁦054‑123‑4567⁩',
    too_long: 'מספר טלפון לא תקין, למשל ⁦054‑123‑4567⁩',
    invalid: 'מספר טלפון לא תקין, למשל ⁦054‑123‑4567⁩',
  },
};
/** The code for one field, or '' when it is fine. */
export function leadFieldError(field, value) {
  const v = clean(value);
  if (!v) return 'required';
  if (field === 'phone') return phoneOk(v) ? '' : 'invalid';
  if (v.length < 2) return 'too_short';
  if (v.length > 80) return 'too_long';
  return '';
}
/** Every field's code; an empty object when the form can be sent. */
export function validateLead(fields) {
  const out = {};
  for (const f of ['name', 'company', 'phone']) {
    const e = leadFieldError(f, fields && fields[f]);
    if (e) out[f] = e;
  }
  return out;
}
/**
 * What a reply from POST /api/business-lead means for the page.
 * @returns {{state:'ok'}|{state:'invalid',fields:object}|{state:'rate'}|{state:'error'}}
 */
export function leadOutcome(status, body) {
  if (status === 200 && body && body.ok === true) return { state: 'ok' };
  if (status === 400 && body && body.fields && typeof body.fields === 'object') {
    const fields = {};
    for (const f of ['name', 'company', 'phone'])
      if (LEAD_MESSAGES[f][body.fields[f]]) fields[f] = body.fields[f];
    if (Object.keys(fields).length) return { state: 'invalid', fields };
  }
  if (status === 429) return { state: 'rate' };
  return { state: 'error' };
}
/** Send the form. Never throws: a network failure is an 'error' outcome. */
export async function sendLead(
  fields,
  { fetchImpl = typeof fetch !== 'undefined' ? fetch : null, source = '' } = {}
) {
  try {
    const res = await fetchImpl('/api/business-lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: clean(fields.name),
        company: clean(fields.company),
        phone: clean(fields.phone),
        website: fields.website || '',
        source,
      }),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return leadOutcome(res.status, body);
  } catch {
    return { state: 'error' };
  }
}

/* ---------- the hero deck's auto-deal ---------- */
// How often the deck deals a card by itself, and how long after the visitor last touched the table it waits before it does.
export const AUTO_DEAL_MS = 8000;
/**
 * Whether the deck may deal a card by itself now: never under reduced motion, never while the page is in the background or
 * the hero is off screen, never while a dialog (a design, the reviews sheet, the menu) is open or a card is held, and not
 * until AUTO_DEAL_MS have passed since the visitor last touched the table.
 */
export function autoDealAllowed({
  reduce,
  pageHidden,
  heroOnScreen,
  dialogOpen,
  holding,
  sinceTouch,
}) {
  if (reduce || pageHidden || !heroOnScreen || dialogOpen || holding) return false;
  return !(sinceTouch < AUTO_DEAL_MS);
}
