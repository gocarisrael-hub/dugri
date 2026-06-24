// Tiny JSON-file store for the word-collection feature.
// Modeled on the meilon backend pattern: an in-memory object loaded at boot,
// mutated through helpers, and written to disk on every change. The data file
// lives under DATA_DIR (a persistent Railway volume in production) so it
// survives redeploys.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'dugri-data.json');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULTS = { collections: [], words: [] };

function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

let _db = loadDb();

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(_db, null, 2), 'utf8');
}

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// Normalize a word for dedupe: trim, collapse inner whitespace, lowercase.
function norm(s) {
  return String(s).trim().replace(/\s+/g, ' ').toLowerCase();
}

// open while not closed and not past expiry; otherwise 'closed' / 'expired'.
function effectiveStatus(c) {
  if (!c) return null;
  if (c.status === 'closed') return 'closed';
  if (Date.parse(c.expires_at) < Date.now()) return 'expired';
  return 'open';
}

const db = {
  effectiveStatus,

  createCollection(honoreeName, contact = {}) {
    const c = {
      id: uid(),
      owner_token: uid(),
      honoree_name: String(honoreeName || '').trim(),
      owner_email: contact.email ? String(contact.email).trim().slice(0, 120) : null,
      owner_phone: contact.phone ? String(contact.phone).trim().slice(0, 40) : null,
      status: 'open',
      created_at: nowIso(),
      expires_at: new Date(Date.now() + WEEK_MS).toISOString(),
      closed_at: null,
    };
    _db.collections.push(c);
    saveDb();
    return c;
  },

  getCollection(id) {
    return _db.collections.find((c) => c.id === id) || null;
  },

  // Admin: every collection enriched with word count + effective status,
  // newest first. Includes owner_token so the admin can build owner links.
  listAllCollections() {
    return [..._db.collections]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((c) => ({
        ...c,
        status: effectiveStatus(c),
        word_count: _db.words.filter((w) => w.collection_id === c.id).length,
      }));
  },

  listWords(id) {
    return _db.words
      .filter((w) => w.collection_id === id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  // Add a batch of words. Dedupes (case/space-insensitive) within the
  // collection. Returns {added, skipped} or {closed:true} if not open.
  addWords(id, words, addedBy) {
    const c = this.getCollection(id);
    if (!c) return null;
    if (effectiveStatus(c) !== 'open') return { closed: true, added: 0, skipped: 0 };

    const existing = new Set(_db.words.filter((w) => w.collection_id === id).map((w) => w.norm));
    const by = addedBy ? String(addedBy).trim().slice(0, 40) : null;
    let added = 0;
    let skipped = 0;
    for (const raw of Array.isArray(words) ? words : []) {
      const text = String(raw).trim().replace(/\s+/g, ' ');
      if (!text) continue;
      const n = norm(text);
      if (existing.has(n)) {
        skipped += 1;
        continue;
      }
      existing.add(n);
      _db.words.push({
        id: uid(),
        collection_id: id,
        text,
        norm: n,
        added_by: by,
        created_at: nowIso(),
      });
      added += 1;
    }
    if (added) saveDb();
    return { added, skipped };
  },

  deleteWord(id, wordId, ownerToken) {
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return false;
    const before = _db.words.length;
    _db.words = _db.words.filter((w) => !(w.id === wordId && w.collection_id === id));
    if (_db.words.length === before) return false;
    saveDb();
    return true;
  },

  closeCollection(id, ownerToken) {
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return false;
    c.status = 'closed';
    c.closed_at = nowIso();
    saveDb();
    return true;
  },
};

module.exports = db;
