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
const REGISTRY = {
  email: {
    order_paid: {
      kind: 'email',
      tokens: ['honoree'],
      default: {
        subject: 'דוגרי · התקבל תשלום — {honoree}',
        body: 'התקבל תשלום עבור ההזמנה של {honoree}.',
      },
    },
    custom_order_alert: {
      kind: 'email',
      tokens: ['honoree'],
      default: {
        subject: 'דוגרי · הזמנה בהתאמה אישית — צריך עיצוב ידני · {honoree}',
        body:
          'התקבלה הזמנת עיצוב אישי (מותאם אישית) עבור {honoree}.\n' +
          'ההזמנה דורשת עיצוב ידני — אין תבנית מוכנה, יש להכין עיצוב בהתאמה מלאה.',
      },
    },
    buyer_confirmation: {
      kind: 'email',
      tokens: ['honoree'],
      default: {
        subject: 'דוגרי · ההזמנה שלכם התקבלה — {honoree}',
        body:
          'תודה רבה על ההזמנה!\n' +
          'קיבלנו את התשלום עבור המשחק של {honoree}.\n' +
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
  if (isPlainObject(def) && isPlainObject(ov)) return deepMerge(def, ov);
  return clone(ov);
}

// Store an override for (section, key). Rejects an unknown key. Returns the new
// effective value.
function set(section, key, value) {
  if (!hasKey(section, key)) {
    throw new Error('unknown settings key: ' + section + '.' + key);
  }
  if (!Object.prototype.hasOwnProperty.call(_overrides, section)) _overrides[section] = {};
  _overrides[section][key] = clone(value);
  save();
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
  interpolate,
  REGISTRY,
  _file: FILE,
};
