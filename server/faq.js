'use strict';

// Owner-managed FAQ list — the questions shown at the bottom of the home page.
// They used to be hard-coded in site/index.html (four <details> blocks): the
// inline content editor could reword them, but the owner could never ADD a fifth
// without a deploy. The list lives here instead, edited from site/admin-faq.html
// and read by the public GET /api/faq.
//
// This module is PURE (no I/O), exactly like server/reminders.js — the settings
// store owns persistence, this file owns the SHAPE. Keeping validateFaq here as
// the single source of truth is what makes it the security boundary: settings.set
// and the admin route both call it, so an item can never reach the store (and
// from there the public API and every visitor's browser) unless it passed.
//
// Two rules matter more than the rest:
//   • Answers are PLAIN TEXT. A blank line starts a new paragraph; nothing else
//     is interpreted. The renderer escapes every character, so an answer can
//     never contribute markup to the page.
//   • A link is a validated href, never free-form. Only `https://…` and
//     same-site `/…` survive, so `javascript:`, `data:`, `vbscript:` and the
//     protocol-relative `//evil.example` can't be stored in the first place.

// Caps. Generous for real copy, bounded so a runaway client can't grow the store
// (and the unauthenticated /api/faq response) without limit.
const MAX_ITEMS = 30;
const MAX_Q = 200;
const MAX_A = 2000;
const MAX_LINK_TEXT = 60;
const MAX_LINK_URL = 300;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
// C0/C1 control characters, EXCEPT tab / newline / carriage return: a newline is
// how an answer expresses a paragraph break, and a textarea on Windows sends
// CRLF. Everything else in that range is rejected — most of it is invisible in an
// admin field but meaningful to some parser downstream.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The seed list, used as the settings default: the four questions exactly as
// they ship in site/index.html today, so turning this feature on changes nothing
// the visitor sees. `id` is stable — it is what an override is keyed by.
const DEFAULT_FAQ = [
  {
    id: 'what-is-it',
    enabled: true,
    q: 'מה זה בעצם המשחק?',
    a: 'משחק מסיבה אישי בסגנון ניחוש מילים בקבוצות: אתם שולחים לנו 70+ מילים וביטויים על בעל או בעלת השמחה - בדיחות פנימיות, הרגלים, אנשים ומקומות - ואנחנו הופכים אותם לחפיסת קלפים מעוצבת ולוח משחק מוכנים להדפסה. מתחלקים לקבוצות, מתחרים מי יגרום לחברים לנחש מהר יותר, וכל החדר צוחק על האדם שחוגגים - כי כל מילה היא רק עליו.',
    link_text: '',
    link_url: '',
  },
  {
    id: 'how-many-words',
    enabled: true,
    q: 'כמה מילים צריך לשלוח?',
    a: 'מינימום 70, ואין הגבלה עליונה. אנחנו שולחים דף עזר עם קטגוריות ודוגמאות שמקל מאוד להיזכר - אנשים, מקומות, בדיחות פנימיות, ביטויים שהוא תמיד אומר.',
    link_text: '',
    link_url: '',
  },
  {
    id: 'when-delivered',
    enabled: true,
    q: 'מתי בדיוק מקבלים?',
    a: 'הספירה מתחילה מרגע שאתם שולחים את רשימת המילים - לא מרגע התשלום. תוך 24 שעות מאותו רגע הקובץ אצלכם במייל ובוואטסאפ. יש לכם תאריך אירוע קרוב? יש גם אקספרס בעדיפות שמקצר את זה לכמה שעות.',
    link_text: '',
    link_url: '',
  },
  {
    id: 'how-to-order',
    enabled: true,
    q: 'איך מזמינים ומשלמים?',
    a: 'בוחרים חבילה ומשלמים באתר בתשלום מאובטח. מיד אחרי התשלום מקבלים הודעה בוואטסאפ ובמייל לשליחת המילים, ומשם אנחנו מתחילים.',
    link_text: '',
    link_url: '',
  },
];

// Is `url` an acceptable href for a FAQ answer? Only two forms pass:
//   • an absolute https:// URL that actually parses, or
//   • a same-site path starting with a single '/' ('//host' is protocol-relative
//     — it looks like a path but navigates OFF-SITE, so it is rejected).
// Everything else — javascript:, data:, vbscript:, file:, plain http://, a bare
// 'example.com' — fails. Leading/trailing whitespace is NOT trimmed away into
// validity: '  javascript:…' with a leading space is still rejected, because the
// value is checked exactly as it will be stored.
function isSafeUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url !== url.trim()) return false;
  if (CONTROL_RE.test(url)) return false;
  if (url.startsWith('//')) return false;
  if (url.startsWith('/')) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:';
}

// Validate an owner-supplied FAQ list. Returns an error message string, or null
// when the whole list is acceptable. Mirrors reminders.validateReminders' posture
// — a bad write must never reach the store, and the message says which item and
// what is wrong so the admin page can show it inline.
function validateFaq(list) {
  if (!Array.isArray(list)) return 'faq must be an array';
  if (list.length > MAX_ITEMS) return 'too many questions (max ' + MAX_ITEMS + ')';
  const ids = new Set();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const at = 'question ' + (i + 1) + ': ';
    if (!isPlainObject(item)) return at + 'each question must be an object';
    if (typeof item.id !== 'string' || !ID_RE.test(item.id)) {
      return at + 'id must be lowercase-kebab, 1..31 chars';
    }
    if (ids.has(item.id)) return at + 'duplicate id: ' + item.id;
    ids.add(item.id);
    if (typeof item.enabled !== 'boolean') return at + 'enabled must be a boolean';

    if (typeof item.q !== 'string' || !item.q.trim()) return at + 'q must be a non-empty string';
    if (item.q.length > MAX_Q) return at + 'q is too long (max ' + MAX_Q + ' chars)';
    // A question is a single line — it renders inside a <summary>.
    if (/[\r\n]/.test(item.q) || CONTROL_RE.test(item.q)) return at + 'q must be a single line';

    if (typeof item.a !== 'string' || !item.a.trim()) return at + 'a must be a non-empty string';
    if (item.a.length > MAX_A) return at + 'a is too long (max ' + MAX_A + ' chars)';
    if (CONTROL_RE.test(item.a)) return at + 'a must not contain control characters';

    // The optional link is all-or-nothing: a URL with no label renders nothing,
    // and a label with no URL is a link that goes nowhere. Both read to the owner
    // as "I set it and it vanished", so refuse the half-filled pair instead.
    const hasText = typeof item.link_text === 'string' && item.link_text.trim() !== '';
    const hasUrl = typeof item.link_url === 'string' && item.link_url.trim() !== '';
    if (item.link_text != null && typeof item.link_text !== 'string') {
      return at + 'link_text must be a string';
    }
    if (item.link_url != null && typeof item.link_url !== 'string') {
      return at + 'link_url must be a string';
    }
    if (hasText !== hasUrl) return at + 'link_text and link_url must be set together';
    if (hasText) {
      if (item.link_text.length > MAX_LINK_TEXT) {
        return at + 'link_text is too long (max ' + MAX_LINK_TEXT + ' chars)';
      }
      if (/[\r\n]/.test(item.link_text) || CONTROL_RE.test(item.link_text)) {
        return at + 'link_text must be a single line';
      }
      if (item.link_url.length > MAX_LINK_URL) {
        return at + 'link_url is too long (max ' + MAX_LINK_URL + ' chars)';
      }
      if (!isSafeUrl(item.link_url)) {
        return at + 'link_url must start with https:// or /';
      }
    }
  }
  return null;
}

// The PUBLIC projection: the enabled questions, in order, reduced to exactly the
// four display fields. Built field-by-field (never spread) so a stray key that
// somehow got into the store — or one a future version adds for internal use —
// can never reach the unauthenticated response. A malformed stored value falls
// back to the shipped defaults rather than blanking the section, matching how
// db.effectivePricing treats a corrupt override.
function publicFaq(list) {
  const src = Array.isArray(list) && validateFaq(list) === null ? list : DEFAULT_FAQ;
  return src
    .filter((item) => item && item.enabled)
    .map((item) => ({
      id: String(item.id),
      q: String(item.q),
      a: String(item.a),
      link_text: typeof item.link_text === 'string' ? item.link_text : '',
      link_url: typeof item.link_url === 'string' ? item.link_url : '',
    }));
}

module.exports = {
  DEFAULT_FAQ,
  validateFaq,
  publicFaq,
  isSafeUrl,
  MAX_ITEMS,
  MAX_Q,
  MAX_A,
};
