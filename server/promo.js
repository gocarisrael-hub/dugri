'use strict';

// The home-page "new game" section — one owner-managed block that shows off a
// game the storefront doesn't sell yet as a design: a badge, a title, a couple of
// explaining lines, up to three photos and one or two buttons.
//
// It exists because a genuinely NEW product cannot be announced from any surface
// we already had. The designs rail frames everything inside it as "one more
// design", the hero rotates a message away after five seconds, and the FAQ is
// read by people who already decided. So the block sits on its own, ABOVE the
// designs rail by default, and — unlike every other section on the page — it is
// OFF until the owner turns it on.
//
// This module is PURE (no I/O), exactly like server/faq.js: the settings store
// owns persistence, this file owns the SHAPE. Keeping validatePromo here as the
// single source of truth is what makes it the security boundary — settings.set
// calls it, so a block can never reach the store (and from there the public
// /api/promo response and every visitor's browser) unless it passed.
//
// Three rules matter more than the rest:
//   • Text is PLAIN TEXT. The renderer escapes every character, so no field can
//     contribute markup to the home page.
//   • A button link is a validated href, never free-form. Only `https://…` and
//     same-site `/…` survive, so `javascript:`, `data:`, `vbscript:` and the
//     protocol-relative `//evil.example` can't be stored in the first place.
//   • A photo is one of OUR OWN uploads — a `/content-uploads/<hash>.<ext>` path
//     written by the upload route. An arbitrary URL here would let the admin
//     panel point the home page at a third-party host (and leak every visitor to
//     it), so the shape itself refuses one.

// Caps. Generous for real copy, bounded so a runaway client can't grow the store
// (and the unauthenticated /api/promo response) without limit.
const MAX_BADGE = 14;
const MAX_TITLE = 60;
const MAX_SUB = 300;
const MAX_ALT = 120;
const MAX_CTA_TEXT = 30;
const MAX_URL = 300;
const MAX_PHOTOS = 3;

// Where the block sits relative to the designs rail (#products on the home page).
const POSITIONS = ['before', 'after'];
// The section's ground. Both neighbours (אודות, העיצובים שלנו) are white, so
// 'sand' is the default — it separates the block without needing a new divider.
const BACKGROUNDS = ['sand', 'white'];

// C0/C1 control characters, EXCEPT tab / newline / carriage return: a newline is
// how the sub-title expresses a paragraph break, and a textarea on Windows sends
// CRLF. Everything else in that range is rejected — most of it is invisible in an
// admin field but meaningful to some parser downstream.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
// Same shape the content store hands out (server/content.saveImageBytes): a
// 16-hex content hash plus a sniffed extension.
const UPLOAD_PATH_RE = /^\/content-uploads\/[a-f0-9]{16}\.(webp|jpe?g|png)$/;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The shipped default: OFF, with the furniture pre-filled so the owner's first
// visit to the admin page is "write a title, add a photo, flip the switch" rather
// than a blank form. Nothing here is visible to anyone until `enabled` is true.
const DEFAULT_PROMO = {
  enabled: false,
  position: 'before',
  background: 'sand',
  badge: 'חדש',
  title: '',
  sub: '',
  photos: [],
  cta_text: 'לרכישה ›',
  cta_url: '/products.html',
  cta2_enabled: false,
  cta2_text: '',
  cta2_url: '',
};

// A link the home page may point at: an absolute https:// URL, or a same-site
// path. Deliberately NOT a general URL parse — the allowed set is tiny, and an
// allow-list is the only version of this check that can't be talked around.
// `//evil.example` is rejected by requiring a non-slash after the leading `/`.
function linkOk(url) {
  return /^https:\/\/[^/]/.test(url) || /^\/[^/]/.test(url);
}

// One plain-text field: a string, no control characters, within its cap.
// `multiline` allows the newlines that separate paragraphs in the sub-title;
// every other field renders in a one-line slot, where a pasted newline would
// blow the layout apart.
function textErr(label, value, max, multiline) {
  if (typeof value !== 'string') return label + ' must be a string';
  if (CONTROL_RE.test(value)) return label + ' contains control characters';
  if (!multiline && /[\r\n]/.test(value)) return label + ' must be a single line';
  if (value.length > max) return label + ' must be at most ' + max + ' characters';
  return null;
}

// Validate ONE button pair. A button is all-or-nothing: text without a target is
// a dead control, a target without text is an invisible one.
function ctaErr(label, text, url) {
  const te = textErr(label + ' text', text, MAX_CTA_TEXT, false);
  if (te) return te;
  const ue = textErr(label + ' url', url, MAX_URL, false);
  if (ue) return ue;
  if (!text.trim()) return label + ' text cannot be empty';
  if (!url.trim()) return label + ' url cannot be empty';
  if (!linkOk(url)) return label + ' url must start with https:// or / (a path on this site)';
  return null;
}

// Validate the whole block. Returns an error message string, or null when the
// value is acceptable. Called by settings.validateValue (kind: 'promo') on every
// write, so this is the ONLY gate between the admin panel and the public API.
//
// The value is validated WHOLE (not field-by-field deep-merged) because the admin
// page always POSTs the complete block: a partial write that left, say, `enabled`
// true next to a blanked title could publish an empty section.
function validatePromo(value) {
  if (!isPlainObject(value)) return 'value must be an object';

  if (typeof value.enabled !== 'boolean') return 'enabled must be a boolean';
  if (typeof value.cta2_enabled !== 'boolean') return 'cta2_enabled must be a boolean';
  if (!POSITIONS.includes(value.position)) {
    return 'position must be one of: ' + POSITIONS.join(', ');
  }
  if (!BACKGROUNDS.includes(value.background)) {
    return 'background must be one of: ' + BACKGROUNDS.join(', ');
  }

  const fields = [
    ['badge', value.badge, MAX_BADGE, false],
    ['title', value.title, MAX_TITLE, false],
    ['sub', value.sub, MAX_SUB, true],
  ];
  for (const [label, v, max, multi] of fields) {
    const err = textErr(label, v, max, multi);
    if (err) return err;
  }

  if (!Array.isArray(value.photos)) return 'photos must be an array';
  if (value.photos.length > MAX_PHOTOS) return 'photos must hold at most ' + MAX_PHOTOS + ' items';
  for (let i = 0; i < value.photos.length; i++) {
    const p = value.photos[i];
    const at = 'photo ' + (i + 1);
    if (!isPlainObject(p)) return at + ' must be an object';
    if (typeof p.src !== 'string' || !UPLOAD_PATH_RE.test(p.src)) {
      return at + ' src must be an uploaded /content-uploads path';
    }
    const err = textErr(at + ' alt', p.alt, MAX_ALT, false);
    if (err) return err;
  }

  const c1 = ctaErr('cta', value.cta_text, value.cta_url);
  if (c1) return c1;
  // The second button is validated only when it is ON: leaving its two fields
  // blank while it's off is the normal state, not an error the owner must fix.
  if (value.cta2_enabled) {
    const c2 = ctaErr('cta2', value.cta2_text, value.cta2_url);
    if (c2) return c2;
  } else {
    const te = textErr('cta2 text', value.cta2_text, MAX_CTA_TEXT, false);
    if (te) return te;
    const ue = textErr('cta2 url', value.cta2_url, MAX_URL, false);
    if (ue) return ue;
  }

  // The one cross-field rule, and the reason the section can never ship empty:
  // switched ON, it must have something to say. A block with no title is a sand
  // stripe with a button in it.
  if (value.enabled && !value.title.trim()) {
    return 'title cannot be empty while the section is switched on';
  }
  return null;
}

// The PUBLIC projection: what GET /api/promo hands an unauthenticated visitor.
// Returns null while the section is off — not a disabled copy of the block. An
// unlaunched game's name, copy and photos would otherwise sit in a public
// response for anyone who looked, days before the owner meant to announce it.
function publicPromo(block) {
  if (!isPlainObject(block) || !block.enabled) return null;
  return {
    position: POSITIONS.includes(block.position) ? block.position : 'before',
    background: BACKGROUNDS.includes(block.background) ? block.background : 'sand',
    badge: String(block.badge || ''),
    title: String(block.title || ''),
    sub: String(block.sub || ''),
    photos: (Array.isArray(block.photos) ? block.photos : [])
      .filter((p) => isPlainObject(p) && typeof p.src === 'string' && UPLOAD_PATH_RE.test(p.src))
      .slice(0, MAX_PHOTOS)
      .map((p) => ({ src: p.src, alt: String(p.alt || '') })),
    cta_text: String(block.cta_text || ''),
    cta_url: String(block.cta_url || ''),
    // A second button that is off is absent from the projection entirely, so the
    // renderer never has to ask twice.
    cta2: block.cta2_enabled
      ? { text: String(block.cta2_text || ''), url: String(block.cta2_url || '') }
      : null,
  };
}

module.exports = {
  DEFAULT_PROMO,
  validatePromo,
  publicPromo,
  POSITIONS,
  BACKGROUNDS,
  MAX_PHOTOS,
  MAX_BADGE,
  MAX_TITLE,
  MAX_SUB,
  MAX_ALT,
  MAX_CTA_TEXT,
  UPLOAD_PATH_RE,
};
