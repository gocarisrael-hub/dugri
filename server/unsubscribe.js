'use strict';

// unsubscribe.js — the "stop emailing me" list, and the signed link that gets an
// address onto it in one tap.
//
// WHAT IT SUPPRESSES: everything. The owner's rule was "a button that stops
// sending them mail at all, no matter what", so the gate sits in notify.send() —
// the single place every message passes through — rather than in each sender.
// That means a receipt, "your order is ready", and the word-collection link stop
// too, not just the reminders. It is the strictest reading on purpose: an
// unsubscribe that keeps sending SOME mail is the thing people press twice and
// then report as spam. The page they land on says exactly that, and offers the
// way back in the same tap.
//
// ONE EXCEPTION, and it is not the buyer's: NOTIFY_TO, the business inbox that
// receives the owner's own order alerts. Suppressing that would silently stop her
// hearing about orders, from a link she pressed in her own copy of a mail. It is
// excluded in notify.js, where the address is known.
//
// KEYED BY ADDRESS, not by order: a person who says stop means stop, and the same
// address can carry several orders — including ones she has not placed yet.
//
// THE LINK IS SIGNED. `?e=<address>&t=<hmac>` — without the signature anyone
// could unsubscribe anyone by editing a query string, which is both a nuisance
// and a way to silence a competitor's mail. The key comes from the environment
// when set; otherwise one is generated ONCE and stored beside the list, so links
// already in somebody's inbox keep working across restarts and deploys (the file
// is on the volume). Compared in constant time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILE = path.join(DATA_DIR, 'unsubscribed.json');
// Long enough that guessing is hopeless, short enough to survive a mail client's
// line wrapping without being mangled.
const TOKEN_CHARS = 32;

// { secret: '<hex>', addresses: { '<lowercased email>': { at, source } } }
let _store = load();

function empty() {
  return { secret: '', addresses: {} };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return {
        secret: typeof raw.secret === 'string' ? raw.secret : '',
        addresses:
          raw.addresses && typeof raw.addresses === 'object' && !Array.isArray(raw.addresses)
            ? raw.addresses
            : {},
      };
    }
  } catch {
    /* missing or corrupt — start from empty rather than refuse to boot */
  }
  return empty();
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_store, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
    return true;
  } catch (e) {
    console.warn('[unsubscribe] save failed:', e && e.message ? e.message : e);
    return false;
  }
}

// The comparison key. Addresses are case-insensitive in practice and people type
// them both ways; a list that treated Dana@X and dana@x as two people would keep
// mailing someone who has already pressed the button.
function norm(email) {
  return String(email == null ? '' : email)
    .trim()
    .toLowerCase();
}

// The signing key: the environment's if set, else a persisted random one. NOT
// derived from ADMIN_KEY — rotating the admin key must not invalidate every
// unsubscribe link already sitting in people's inboxes.
function secret() {
  if (process.env.UNSUBSCRIBE_SECRET) return String(process.env.UNSUBSCRIBE_SECRET);
  if (!_store.secret) {
    _store.secret = crypto.randomBytes(32).toString('hex');
    save();
  }
  return _store.secret;
}

// The signature for one address. Truncated to TOKEN_CHARS hex chars (128 bits) —
// far past guessable, and short enough to keep the URL tidy.
function tokenFor(email) {
  const n = norm(email);
  if (!n) return '';
  return crypto.createHmac('sha256', secret()).update(n).digest('hex').slice(0, TOKEN_CHARS);
}

// Constant-time check, so the token cannot be recovered a character at a time by
// measuring how long a wrong guess takes.
function verify(email, token) {
  const expected = tokenFor(email);
  const given = String(token == null ? '' : token);
  if (!expected || expected.length !== given.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  } catch {
    return false;
  }
}

// The one-tap link for an address. Returns null without a base URL — a relative
// unsubscribe link in an email is a dead link.
function linkFor(email, baseUrl) {
  const n = norm(email);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!n || !base) return null;
  return (
    base + '/unsubscribe.html?e=' + encodeURIComponent(n) + '&t=' + encodeURIComponent(tokenFor(n))
  );
}

function isUnsubscribed(email) {
  const n = norm(email);
  return !!(n && _store.addresses[n]);
}

// Add an address. Idempotent — pressing the button twice is not an error, and the
// second press must not overwrite when the first one happened.
function unsubscribe(email, source) {
  const n = norm(email);
  if (!n) return false;
  if (!_store.addresses[n]) {
    _store.addresses[n] = { at: new Date().toISOString(), source: String(source || 'link') };
    save();
  }
  return true;
}

// Take an address back off. The same page offers this, because one tap in a mail
// client is easy to do by accident and the alternative is a phone call.
function resubscribe(email) {
  const n = norm(email);
  if (!n) return false;
  if (_store.addresses[n]) {
    delete _store.addresses[n];
    save();
  }
  return true;
}

// Every suppressed address, newest first — for the admin.
function list() {
  return Object.keys(_store.addresses)
    .map((email) => ({ email, ...(_store.addresses[email] || {}) }))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

// Test seam: re-read the file (the store is cached in memory).
function _reload() {
  _store = load();
}

module.exports = {
  norm,
  tokenFor,
  verify,
  linkFor,
  isUnsubscribed,
  unsubscribe,
  resubscribe,
  list,
  _reload,
};
