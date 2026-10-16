// Business leads: the "for businesses" inquiry form on the homepage (POST
// /api/business-lead, server/routes/platform.js). A company that wants Dugri for
// an event leaves a name, a company and a phone; the owner gets an email and calls
// back.
//
// Every lead is STORED before the email is attempted, in its own small file
// (DATA_DIR/business-leads.json), so a Resend outage or a missing NOTIFY_TO loses
// nothing: the lead is on the volume with `email` recording what happened to its
// alert. There is no admin view yet; Agent A can surface the list later through
// list().
//
// Kept out of dugri-data.json on purpose: that file is the order store, rewritten
// whole on every save, and a marketing form has no business growing it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = () => process.env.DATA_DIR || path.join(__dirname);
const FILE = () => path.join(DATA_DIR(), 'business-leads.json');

const NAME_MIN = 2;
const NAME_MAX = 80;
const SOURCE_MAX = 200;

// Trimmed, inner whitespace collapsed, control characters out. `null` for
// anything that is not a string.
function cleanText(v) {
  if (typeof v !== 'string') return null;
  return v
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// An Israeli phone number, as people type it: spaces, dashes, dots and brackets
// are ignored. Accepted:
//   0 + 8 digits (landline, 02-1234567) or 0 + 9 digits (mobile, 052-1234567);
//   +972 then the same number without its leading 0, or with it (+972-052-…),
//   which people write often enough to accept.
// Returns the local form ("0521234567") or null.
function normalizeIlPhone(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\s\-.()[\]]/g, '');
  let m = /^0(\d{8,9})$/.exec(s);
  if (m) return '0' + m[1];
  m = /^(?:\+|00)9720?(\d{8,9})$/.exec(s);
  if (m) return '0' + m[1];
  return null;
}

// The international form for a tel: link: 0521234567 → +972521234567.
function telHref(localPhone) {
  return 'tel:+972' + String(localPhone).replace(/^0/, '');
}

// Validates a request body. Returns { ok: true, lead } with the cleaned fields,
// or { ok: false, errors } with one code per bad field:
//   'required' | 'too_short' | 'too_long' | 'invalid'
function validateLead(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = {};
  const out = {};
  for (const field of ['name', 'company']) {
    const v = cleanText(b[field]);
    if (!v) errors[field] = 'required';
    else if (v.length < NAME_MIN) errors[field] = 'too_short';
    else if (v.length > NAME_MAX) errors[field] = 'too_long';
    else out[field] = v;
  }
  if (cleanText(b.phone) === null || cleanText(b.phone) === '') errors.phone = 'required';
  else {
    const p = normalizeIlPhone(b.phone);
    if (!p) errors.phone = 'invalid';
    else out.phone = p;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, lead: out };
}

// The page the form was sent from: the body's `source` if the page says, else the
// Referer, reduced to a path (and query) so no foreign origin is stored. Never
// required; '' when unknown.
function sourceOf(body, referer) {
  const raw = cleanText(body && body.source) || cleanText(referer) || '';
  if (!raw) return '';
  let p = raw;
  try {
    const u = new URL(raw, 'http://local');
    p = u.pathname + u.search;
  } catch {
    return '';
  }
  return p.startsWith('/') ? p.slice(0, SOURCE_MAX) : '';
}

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    // A file that exists but will not parse is NOT treated as empty: the next
    // append would write the emptiness over every lead in it.
    throw new Error(`business-leads.json cannot be read: ${e.message}`);
  }
}

function writeAll(list) {
  fs.mkdirSync(DATA_DIR(), { recursive: true });
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list), 'utf8');
  fs.renameSync(tmp, FILE());
}

// Stores a validated lead. Synchronous, temp file + rename, like every store here:
// when this returns the lead is on disk. Returns the stored record.
function add({ name, company, phone }, { source = '', now = new Date() } = {}) {
  const rec = {
    id: crypto.randomUUID(),
    created_at: now.toISOString(),
    name,
    company,
    phone,
    source,
    // What happened to the owner's alert: 'pending' until the send settles, then
    // 'sent', 'off' (the owner switched the email off), or 'failed' (Resend
    // unconfigured or the send failed).
    email: 'pending',
  };
  const list = readAll();
  list.push(rec);
  writeAll(list);
  return rec;
}

function setEmailStatus(id, status) {
  const list = readAll();
  const rec = list.find((r) => r.id === id);
  if (!rec) return false;
  rec.email = status;
  writeAll(list);
  return true;
}

// Newest first.
function list() {
  return readAll().slice().reverse();
}

module.exports = {
  NAME_MIN,
  NAME_MAX,
  cleanText,
  normalizeIlPhone,
  telHref,
  validateLead,
  sourceOf,
  add,
  setEmailStatus,
  list,
  file: FILE,
};
