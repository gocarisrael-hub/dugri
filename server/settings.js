// settings.js — owner-editable message templates + settings store. Same on-disk
// pattern as server/playbook.js and server/content.js: an in-memory object
// loaded at boot, mutated through helpers, written to disk atomically (temp file
// + rename) on every change. The file lives under DATA_DIR (a persistent Railway
// volume in production) so the owner's overrides survive redeploys.
//
// This store holds ONLY overrides. A single in-module REGISTRY is the source of
// truth: it enumerates every editable key with its default value, the tokens the
// value may interpolate, and a `kind` the admin UI uses to render an editor.
// `get(section, key)` returns the override (deep-merged over the default) or the
// default when there is no override, so the app always has a complete value.
//
// Two sections:
//   email.<name>  — the subject/body templates for the 7 transactional emails,
//                   plus the editable label maps (version labels, order-detail
//                   field labels, CTA button labels, the shared footer).
//   wa.trigger.<id> — the WhatsApp trigger catalog (Phase B). Defaults are
//                   defined now so the admin page can render/toggle them.
//
// notify.js requires this module (notify -> settings). This module must NEVER
// require notify.js — that would be a require cycle — so it carries its own copy
// of the HTML-escape helper rather than importing notify's.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'settings.json');

// Keys that resolve up the prototype chain — never treat them as own settings
// keys, and never copy them during a merge (prototype-pollution guard, same
// posture as server/templates.js ownTheme).
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Minimal HTML-escaping for values interpolated into an HTML context. Copied
// verbatim from notify.js escapeHtml (can't require notify from here — cycle).
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Replace {token} occurrences in `template` with values[token]. Unknown tokens
// (not an own key of `values`, or a null/undefined value) are LEFT AS-IS so a
// partial value set never blanks the text. When opts.html is true each
// substituted value is HTML-escaped (for interpolation into an HTML body).
function interpolate(template, values, opts) {
  const html = !!(opts && opts.html);
  const vals = values || {};
  return String(template == null ? '' : template).replace(
    /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,
    (match, token) => {
      if (!Object.prototype.hasOwnProperty.call(vals, token)) return match;
      const v = vals[token];
      if (v == null) return match;
      const s = String(v);
      return html ? escapeHtml(s) : s;
    }
  );
}

// --- The registry: every editable key with its default, tokens and kind -------
// `kind` tells the admin UI how to render the editor:
//   'email'  — a { subject, body } template pair (multiline body with {tokens}).
//   'map'    — a flat { key: label } object of short editable label strings.
//   'footer' — the shared two-line email sign-off.
//   'trigger'— a WhatsApp trigger { enabled, text, timing? }.
//   'price'  — a non-negative integer NIS amount (store price / per-version price).
//   'flag'   — a boolean on/off switch (a checkout version's enabled state).
const REGISTRY = {
  email: {
    order_paid: {
      kind: 'email',
      tokens: ['honoree', 'orderId', 'link', 'adminLink'],
      default: {
        subject: 'דוגרי · התקבלה הזמנה חדשה — {honoree}',
        body: 'התקבלה הזמנה חדשה עבור {honoree}.',
      },
    },
    custom_order_alert: {
      kind: 'email',
      tokens: ['honoree', 'orderId', 'link', 'adminLink'],
      default: {
        subject: 'דוגרי · הזמנה בהתאמה אישית — צריך עיצוב ידני · {honoree}',
        body:
          'התקבלה הזמנת עיצוב אישי (מותאם אישית) עבור {honoree}.\n' +
          'ההזמנה דורשת עיצוב ידני — אין תבנית מוכנה, יש להכין עיצוב בהתאמה מלאה.',
      },
    },
    buyer_confirmation: {
      kind: 'email',
      tokens: ['honoree', 'link'],
      default: {
        subject: 'דוגרי · ההזמנה שלכם התקבלה — {honoree}',
        body:
          'תודה רבה על ההזמנה!\n' +
          'קיבלנו את ההזמנה שלך למשחק של {honoree}.\n' +
          '\n' +
          'פרטי ההזמנה:',
      },
    },
    pdf_ready: {
      kind: 'email',
      tokens: ['honoree'],
      default: {
        subject: 'דוגרי · הקובץ שלכם מוכן — {honoree}',
        body: 'הקובץ המוכן להדפסה של המשחק עבור {honoree} מוכן!',
      },
    },
    order_finished: {
      kind: 'email',
      tokens: ['honoree'],
      default: {
        subject: 'דוגרי · הזמנה מוכנה להפקה — {honoree}',
        body: 'ההזמנה של {honoree} נסגרה ומוכנה להפקה.',
      },
    },
    production_error: {
      kind: 'email',
      tokens: ['honoree'],
      default: {
        subject: 'דוגרי · צריך תיקון לפני הפקה — {honoree}',
        body: 'לא הצלחנו להפיק את הקובץ של {honoree} — יש לתקן את הנקודות הבאות:',
      },
    },
    words_reminder: {
      kind: 'email',
      tokens: ['honoree'],
      default: {
        subject: 'דוגרי · עוד לא הוספתם מילים — {honoree}',
        body:
          'עוד לא קיבלנו את רשימת המילים עבור המשחק של {honoree}.\n' +
          '\n' +
          'ברגע שתוסיפו את המילים נתחיל להכין את הקובץ — זה לוקח כמה דקות בלבד.',
      },
    },
    // The Hebrew display label for each order version (used in every order-detail
    // block). An override of one key deep-merges, keeping the rest.
    version_labels: {
      kind: 'map',
      tokens: [],
      default: {
        pdf: 'דיגיטלי (PDF)',
        pickup: 'איסוף עצמי',
        delivery: 'משלוח עד הבית',
        custom: 'עיצוב אישי בהתאמה מלאה',
      },
    },
    // The short field labels used when listing order details in the email bodies.
    field_labels: {
      kind: 'map',
      tokens: [],
      default: {
        version: 'גרסה', // owner order-detail: "גרסה: <label>"
        amount: 'סכום', // owner order-detail: "סכום: <n> ₪"
        wordCount: 'מספר מילים', // "מספר מילים: <n>"
        ownerLink: 'קישור לניהול', // "קישור לניהול: <url>"
        currency: '₪', // amount unit
        freeCoupon: 'קופון 100%', // shown for a fully-free (0 ₪) order
        buyerPackage: '· חבילה', // buyer confirmation: "· חבילה: <label>"
        buyerPrice: '· מחיר', // buyer confirmation: "· מחיר: <n> ₪"
        buyerDesign: '· עיצוב', // buyer confirmation: "· עיצוב: <design>"
        buyerColor: '· צבע', // buyer confirmation: "· צבע: <color>"
        orderId: 'מספר הזמנה', // owner order-detail: "מספר הזמנה: <id>"
        adminOrder: 'ניהול ההזמנה', // owner order-detail: link to the admin orders panel
      },
    },
    // What the buyer bought — a one-line description per order version, shown in
    // the buyer's confirmation email under the package name. Owner-editable so the
    // wording can change without a deploy. Keys mirror the version codes.
    product_info: {
      kind: 'map',
      tokens: [],
      default: {
        pdf: 'קובץ דיגיטלי מוכן להדפסה — חפיסת קלפים, לוח משחק, דף חוקים והוראות הדפסה וגזירה.',
        pickup: 'משחק מודפס ומוכן — חפיסת קלפים, לוח משחק ודף חוקים, מוכן לאיסוף עצמי.',
        delivery: 'משחק מודפס ומוכן — חפיסת קלפים, לוח משחק ודף חוקים, שנשלח עד הבית.',
        custom: 'עיצוב אישי בהתאמה מלאה — נעצב עבורך משחק ייחודי מאפס.',
      },
    },
    // Delivery-order block in the buyer confirmation (shown only for a `delivery`
    // order). `eta` is the approximate delivery time; `address_label` labels the
    // shipping address, which is filled in automatically from the order.
    delivery_info: {
      kind: 'map',
      tokens: [],
      default: {
        eta: 'המשחק יישלח אליך בדרך כלל תוך 5–7 ימי עסקים מרגע שרשימת המילים מוכנה.',
        address_label: 'כתובת למשלוח',
      },
    },
    // Self-pickup block in the buyer confirmation (shown only for a `pickup`
    // order). `ready` reassures we email when it's ready; `eta` is the approximate
    // prep time; `address` is the print-house pickup address (owner fills the full
    // address); `address_label` labels it.
    pickup_info: {
      kind: 'map',
      tokens: [],
      default: {
        ready: 'נעדכן אותך במייל ברגע שהמשחק מוכן לאיסוף.',
        eta: 'המשחק מוכן בדרך כלל תוך 3–5 ימי עסקים מרגע שרשימת המילים מוכנה.',
        address: 'בית הדפוס גלאור — עדכנו כאן את הכתובת המלאה לאיסוף.',
        address_label: 'כתובת לאיסוף',
      },
    },
    // The CTA button labels on the branded HTML emails.
    cta_labels: {
      kind: 'map',
      tokens: [],
      default: {
        addWords: 'להוספת המילים', // buyer confirmation + words reminder
        downloadFile: 'להורדת הקובץ', // PDF ready
        updateOrder: 'לעדכון ההזמנה', // production error
      },
    },
    // The shared two-line plain-text sign-off. (The branded HTML shell keeps its
    // own hardcoded footer — renderEmailHtml is intentionally left untouched.)
    footer: {
      kind: 'footer',
      tokens: [],
      default: {
        line1: 'נתראה על הלוח,',
        line2: 'צוות דוגרי',
      },
    },
  },
  // --- WhatsApp trigger catalog (Phase B) -----------------------------------
  // Defaults defined now so the admin page can render/toggle them. Each is
  // { enabled, text, timing? }; EVENT triggers have no timing, TIME triggers do.
  wa: {
    'trigger.group_opened': {
      kind: 'trigger',
      tokens: ['honoree', 'link'],
      default: {
        enabled: true,
        text: 'שלום! פתחנו קבוצה לאיסוף מילים על {honoree} 🎉 הוסיפו כאן מילים: {link}',
      },
    },
    'trigger.member_joined': {
      kind: 'trigger',
      tokens: ['honoree', 'link'],
      default: {
        enabled: true,
        text: 'ברוכים הבאים! עוזרים לנו להכין משחק על {honoree}. הוסיפו מילים כאן: {link}',
      },
    },
    'trigger.word_added': {
      kind: 'trigger',
      tokens: ['honoree', 'count', 'link'],
      default: {
        enabled: false,
        text: 'מעולה! כבר יש {count} מילים על {honoree}. אפשר להמשיך להוסיף: {link}',
      },
    },
    'trigger.list_closed': {
      kind: 'trigger',
      tokens: ['honoree', 'wordCount'],
      default: {
        enabled: true,
        text: 'סגרנו את רשימת המילים של {honoree} עם {wordCount} מילים. מתחילים להכין את המשחק! 🎬',
      },
    },
    'trigger.daily_morning': {
      kind: 'trigger',
      tokens: ['honoree', 'link'],
      default: {
        enabled: true,
        text: 'בוקר טוב! יש עוד זמן להוסיף מילים על {honoree}: {link}',
        timing: { hour: 7 },
      },
    },
    'trigger.daily_evening': {
      kind: 'trigger',
      tokens: ['honoree', 'link'],
      default: {
        enabled: true,
        text: 'ערב טוב! אל תשכחו להוסיף עוד מילים על {honoree}: {link}',
        timing: { hour: 19 },
      },
    },
    'trigger.quiet_reminder': {
      kind: 'trigger',
      tokens: ['honoree', 'link'],
      default: {
        enabled: true,
        text: 'עדיין אפשר להוסיף מילים על {honoree} 🙂 {link}',
        timing: { idle_hours: 24, max: 3, window: [9, 21] },
      },
    },
  },
  // --- Buyer-wizard feature flags -------------------------------------------
  // Owner-controlled on/off switches for four buyer-facing wizard features that
  // aren't polished enough to ship. Each is a bare boolean (kind: 'flag') that
  // defaults OFF (the feature is hidden entirely); the owner flips it on from
  // the admin panel when it's ready — no code deploy. When a flag is off the
  // wizard falls back to the built-in default (color "מקורי", chasers false,
  // word_font null, no live name preview), so no server order-logic changes.
  features: {
    color_picking: { kind: 'flag', tokens: [], default: false },
    chasers_choice: { kind: 'flag', tokens: [], default: false },
    font_choice: { kind: 'flag', tokens: [], default: false },
    name_preview: { kind: 'flag', tokens: [], default: false },
  },
  // --- Pricing (owner-editable, no deploy) -----------------------------------
  // The storefront display price (`store_now` shown, `store_was` struck through)
  // and, per checkout version, an `<v>_enabled` flag + an `<v>_price` (NIS). The
  // DEFAULTS below ARE the launch state: the store shows 199 (struck 239) and
  // checkout offers ONLY self-pickup (pickup) at 199 — every other version is
  // disabled until the owner turns it on from the admin page. server/db.js reads
  // these as the authoritative charge (fail-safe fallback to the same numbers).
  // A per-version `<v>_price` carries `min: 1` — a CHARGED amount can never be 0
  // (the pay path treats a 0 total as a free/already-paid order, so a 0 base price
  // would mark every order for that version paid at ₪0). The store display prices
  // may be 0 (default min 0) since they are never charged.
  pricing: {
    store_now: { kind: 'price', tokens: [], default: 199 },
    store_was: { kind: 'price', tokens: [], default: 239 },
    pdf_enabled: { kind: 'flag', tokens: [], default: false },
    pdf_price: { kind: 'price', min: 1, tokens: [], default: 79 },
    pickup_enabled: { kind: 'flag', tokens: [], default: true },
    pickup_price: { kind: 'price', min: 1, tokens: [], default: 199 },
    delivery_enabled: { kind: 'flag', tokens: [], default: false },
    delivery_price: { kind: 'price', min: 1, tokens: [], default: 199 },
    custom_enabled: { kind: 'flag', tokens: [], default: false },
    custom_price: { kind: 'price', min: 1, tokens: [], default: 599 },
  },
};

// --- small object helpers -----------------------------------------------------
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
// Deep clone via JSON — every stored value is JSON-safe (strings, numbers,
// booleans, arrays, plain objects). Isolates callers from the in-memory store.
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
// Deep-merge `override` onto `base` (base is the default). Nested plain objects
// merge recursively so a partial override (e.g. a trigger's { enabled:false })
// keeps the default's other fields; arrays and scalars REPLACE. Dangerous keys
// are skipped so an override can't pollute Object.prototype.
function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);
  const out = clone(base);
  for (const k of Object.keys(override)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    const ov = override[k];
    if (isPlainObject(ov) && isPlainObject(out[k])) out[k] = deepMerge(out[k], ov);
    else out[k] = clone(ov);
  }
  return out;
}

// Is (section, key) a registered, editable key? Own-property + dangerous-key
// checks make this safe against prototype pollution.
function hasKey(section, key) {
  if (typeof section !== 'string' || typeof key !== 'string') return false;
  if (DANGEROUS_KEYS.has(section) || DANGEROUS_KEYS.has(key)) return false;
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, section)) return false;
  return Object.prototype.hasOwnProperty.call(REGISTRY[section], key);
}

function defaultFor(section, key) {
  return REGISTRY[section][key].default;
}

// --- persistence (clone of the playbook/content pattern) ----------------------
let _overrides = load();
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (isPlainObject(raw)) return raw;
  } catch {
    /* missing / unreadable — start with no overrides */
  }
  return {};
}
function save() {
  // Ensure the data dir exists before the atomic tmp-write+rename — otherwise
  // writeFileSync throws ENOENT on the first save (same guard as playbook.js).
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_overrides, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function overrideFor(section, key) {
  if (!Object.prototype.hasOwnProperty.call(_overrides, section)) return undefined;
  const bag = _overrides[section];
  if (!Object.prototype.hasOwnProperty.call(bag, key)) return undefined;
  return bag[key];
}

// --- public API ---------------------------------------------------------------
// The effective value for (section, key): the override deep-merged over the
// default, or the default when there is no override. Throws on an unknown key so
// a typo in a caller surfaces immediately.
function get(section, key) {
  if (!hasKey(section, key)) {
    throw new Error('unknown settings key: ' + section + '.' + key);
  }
  const def = defaultFor(section, key);
  const ov = overrideFor(section, key);
  if (ov === undefined) return clone(def);
  if (isPlainObject(def)) {
    // Defensive backstop: only a plain-object override may deep-merge over an
    // object default. A wrong-typed override (null/array/string/number) would
    // strip fields notify depends on (a missing subject -> TypeError, a missing
    // field_labels.currency -> "0 undefined"), so fall back to the complete,
    // well-typed default instead of handing the caller a broken value. This
    // holds even if set()'s shape validation was somehow bypassed.
    return isPlainObject(ov) ? deepMerge(def, ov) : clone(def);
  }
  return clone(ov);
}

const isIntInRange = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

// Range-validate a trigger's timing object. The EXPECTED shape is derived from
// the registry default timing (so new triggers need no changes here):
//   default has `hour`      -> daily_* : integer hour 0..23
//   default has idle_hours/window -> quiet: integer idle_hours>=1, integer
//                              max>=1, window a 2-int array [start,end], each
//                              0..23, start < end.
//   default has no timing    -> an event trigger: it accepts no timing.
// Returns an error message string, or null when the timing is acceptable.
function validateTiming(section, key, timing) {
  const def = defaultFor(section, key);
  const defTiming = isPlainObject(def) ? def.timing : undefined;
  if (!isPlainObject(defTiming)) return 'this trigger does not accept timing';
  // A partial timing override deep-merges over the default on read, so range-
  // check the EFFECTIVE (merged) timing — the value the scheduler will actually
  // use — not the raw (possibly partial) override.
  const t = deepMerge(defTiming, timing);
  if ('hour' in defTiming) {
    if (!isIntInRange(t.hour, 0, 23)) return 'timing.hour must be an integer 0..23';
    return null;
  }
  // quiet shape (idle_hours / max / window)
  if (!(Number.isInteger(t.idle_hours) && t.idle_hours >= 1)) {
    return 'timing.idle_hours must be an integer >= 1';
  }
  if (!(Number.isInteger(t.max) && t.max >= 1)) {
    return 'timing.max must be an integer >= 1';
  }
  if (!Array.isArray(t.window) || t.window.length !== 2) {
    return 'timing.window must be a 2-element array';
  }
  const [start, end] = t.window;
  if (!isIntInRange(start, 0, 23) || !isIntInRange(end, 0, 23)) {
    return 'timing.window hours must be integers 0..23';
  }
  if (start >= end) return 'timing.window start must be before end';
  return null;
}

// Validate an override VALUE's shape against the registry default for
// (section, key). Returns an error message string, or null when the value is
// acceptable. Object defaults require an object override (partial objects are
// fine — they deep-merge on read); wrong-typed overrides are rejected so a bad
// write can never reach notify. Kept in this module (single source of truth) and
// called by both set() and the admin route.
function validateValue(section, key, value) {
  if (!hasKey(section, key)) return 'unknown section/key';
  const spec = REGISTRY[section][key];
  const kind = spec.kind;
  const has = (k) => Object.prototype.hasOwnProperty.call(value, k);
  if (kind === 'email') {
    if (!isPlainObject(value)) return 'value must be an object with { subject, body }';
    if (typeof value.subject !== 'string') return 'subject must be a string';
    if (typeof value.body !== 'string') return 'body must be a string';
    return null;
  }
  if (kind === 'map' || kind === 'footer') {
    if (!isPlainObject(value)) return 'value must be an object';
    return null;
  }
  if (kind === 'price') {
    // A NIS amount: an integer >= the key's `min` (default 0). Version `*_price`
    // keys carry min:1 — a CHARGED price can never be 0 (a 0 total is treated as a
    // free/paid order downstream). Rejects strings ('199'), floats (1.5), values
    // below min, and null so a bad write can never reach the charge path.
    const min = Number.isInteger(spec.min) ? spec.min : 0;
    if (!Number.isInteger(value) || value < min) {
      return min > 0 ? 'value must be a positive integer' : 'value must be a non-negative integer';
    }
    return null;
  }
  if (kind === 'trigger') {
    if (!isPlainObject(value)) return 'value must be an object';
    if (has('enabled') && typeof value.enabled !== 'boolean') return 'enabled must be a boolean';
    if (has('text') && typeof value.text !== 'string') return 'text must be a string';
    if (has('timing')) {
      if (!isPlainObject(value.timing)) return 'timing must be an object';
      // Range-check the timing numbers so a bad override can never be stored (a
      // saved {hour:25} / {hour:0-from-blank} / window:[0,0] would make the
      // reminder scheduler misfire). The expected shape is keyed off the
      // registry DEFAULT timing so it stays generic as triggers are added.
      const timingErr = validateTiming(section, key, value.timing);
      if (timingErr) return timingErr;
    }
    return null;
  }
  if (kind === 'flag') {
    // A feature flag is a bare boolean. Reject anything else (a string 'true',
    // 1/0, null, {}, []) so the wizard's gate condition is never truthy-by-
    // accident from a mis-typed override.
    if (typeof value !== 'boolean') return 'value must be a boolean';
    return null;
  }
  // Generic fallback: an object default requires an object override.
  if (isPlainObject(defaultFor(section, key)) && !isPlainObject(value)) {
    return 'value must be an object';
  }
  return null;
}

// Store an override for (section, key). Rejects an unknown key or a value whose
// shape doesn't match the registry default. The in-memory write is attempted
// BEFORE save(), so a save() failure (disk full / read-only fs) is ROLLED BACK —
// memory and disk never disagree, and the caller sees the error. Returns the new
// effective value.
function set(section, key, value) {
  if (!hasKey(section, key)) {
    throw new Error('unknown settings key: ' + section + '.' + key);
  }
  const err = validateValue(section, key, value);
  if (err) {
    throw new Error('invalid settings value for ' + section + '.' + key + ': ' + err);
  }
  // Snapshot the prior state so a failed save can be undone exactly.
  const sectionExisted = Object.prototype.hasOwnProperty.call(_overrides, section);
  const keyExisted =
    sectionExisted && Object.prototype.hasOwnProperty.call(_overrides[section], key);
  const prevValue = keyExisted ? _overrides[section][key] : undefined;
  if (!sectionExisted) _overrides[section] = {};
  _overrides[section][key] = clone(value);
  try {
    save();
  } catch (e) {
    // Roll the in-memory change back to exactly what it was before.
    if (keyExisted) {
      _overrides[section][key] = prevValue;
    } else if (sectionExisted) {
      delete _overrides[section][key];
    } else {
      delete _overrides[section];
    }
    throw e;
  }
  return get(section, key);
}

// Drop the override for (section, key), restoring the default. Rejects an
// unknown key. Returns the (now default) effective value.
function reset(section, key) {
  if (!hasKey(section, key)) {
    throw new Error('unknown settings key: ' + section + '.' + key);
  }
  if (
    Object.prototype.hasOwnProperty.call(_overrides, section) &&
    Object.prototype.hasOwnProperty.call(_overrides[section], key)
  ) {
    delete _overrides[section][key];
    if (Object.keys(_overrides[section]).length === 0) delete _overrides[section];
    save();
  }
  return get(section, key);
}

// Everything the admin API needs: the defaults, the raw overrides, the effective
// (merged) values, and a registry view (tokens + kind per key) so the UI can
// render an editor and list the tokens each field supports.
function all() {
  const defaults = {};
  const effective = {};
  const registry = {};
  for (const section of Object.keys(REGISTRY)) {
    defaults[section] = {};
    effective[section] = {};
    registry[section] = {};
    for (const key of Object.keys(REGISTRY[section])) {
      const spec = REGISTRY[section][key];
      defaults[section][key] = clone(spec.default);
      effective[section][key] = get(section, key);
      registry[section][key] = { tokens: spec.tokens || [], kind: spec.kind };
    }
  }
  return { defaults, overrides: clone(_overrides), effective, registry };
}

module.exports = {
  get,
  set,
  reset,
  all,
  hasKey,
  validateValue,
  interpolate,
  REGISTRY,
  _file: FILE,
};
