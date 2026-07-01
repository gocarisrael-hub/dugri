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

// Single source of truth for order pricing (NIS).
// pdf = digital PDF; pickup = printed + pickup at גלאור; delivery = door-to-door.
const ORDER_PRICES = { pdf: 79, pickup: 149, delivery: 199 };

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

// 'cancelled' (admin soft-cancel) takes precedence; otherwise open while not
// closed and not past expiry; otherwise 'closed' / 'expired'.
function effectiveStatus(c) {
  if (!c) return null;
  if (c.cancelled) return 'cancelled';
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
      honoree_name: String(honoreeName || '')
        .trim()
        .slice(0, 80),
      owner_email: contact.email ? String(contact.email).trim().slice(0, 120) : null,
      owner_phone: contact.phone ? String(contact.phone).trim().slice(0, 40) : null,
      // Hebrew display names chosen in the order flow (optional).
      design: contact.design ? String(contact.design).trim().slice(0, 80) : null,
      color: contact.color ? String(contact.color).trim().slice(0, 80) : null,
      // Honoree gender for the site's gendered question phrasing. Only 'male' or
      // 'female' are accepted; anything else stores null.
      gender: contact.gender === 'male' || contact.gender === 'female' ? contact.gender : null,
      // Optional drinking-game add-on ("צ'ייסרים") - free; the owner builds the
      // board with special "drink" tiles when this is on.
      chasers: !!contact.chasers,
      status: 'open',
      created_at: nowIso(),
      expires_at: new Date(Date.now() + WEEK_MS).toISOString(),
      closed_at: null,
      // Admin soft-cancel (reversible); a hard delete removes the row entirely.
      cancelled: false,
      cancelled_at: null,
      order: null,
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
      const text = String(raw).trim().replace(/\s+/g, ' ').slice(0, 80);
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

  // Owner-only close. Idempotent: a repeated close on an already-closed
  // collection still succeeds but reports no change, so the caller can fire the
  // "ready to produce" side effects (e.g. the owner email) only on the real
  // open->closed transition. Returns null on bad/absent owner token.
  closeCollection(id, ownerToken) {
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return null;
    const alreadyClosed = c.status === 'closed';
    if (!alreadyClosed) {
      c.status = 'closed';
      c.closed_at = nowIso();
      saveDb();
    }
    return { changed: !alreadyClosed };
  },

  // Admin: soft-cancel a collection (reversible). With undo=true it restores
  // the collection. Returns false when the collection doesn't exist.
  cancelCollection(id, undo = false) {
    const c = this.getCollection(id);
    if (!c) return false;
    c.cancelled = !undo;
    c.cancelled_at = undo ? null : nowIso();
    saveDb();
    return true;
  },

  // Admin: hard-delete a collection and all of its words. Returns false when
  // the collection doesn't exist.
  deleteCollection(id) {
    const before = _db.collections.length;
    _db.collections = _db.collections.filter((c) => c.id !== id);
    if (_db.collections.length === before) return false;
    _db.words = _db.words.filter((w) => w.collection_id !== id);
    saveDb();
    return true;
  },

  // Owner-only: attach/replace the order on a collection.
  // Returns the stored order, or an {error} object on bad input/auth.
  setOrder(id, ownerToken, { version, address } = {}) {
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return { error: 'forbidden' };
    if (!Object.prototype.hasOwnProperty.call(ORDER_PRICES, version)) {
      return { error: 'bad version' };
    }
    let addr = null;
    if (version === 'delivery') {
      const a = address || {};
      const street = String(a.street || '').trim();
      const city = String(a.city || '').trim();
      const postal = String(a.postal || '').trim();
      if (!street || !city || !postal) return { error: 'address required' };
      addr = {
        street: street.slice(0, 120),
        city: city.slice(0, 120),
        postal: postal.slice(0, 120),
        apartment: a.apartment ? String(a.apartment).trim().slice(0, 120) : null,
        floor: a.floor ? String(a.floor).trim().slice(0, 120) : null,
      };
    }
    // Preserve the pending PeleCard handshake (ParamX tokens) when an existing
    // UNPAID order is re-set — an in-flight pay session must still be matchable
    // even if the owner tweaks the version/address before completing payment.
    const prevPelecard = c.order && !c.order.paid ? c.order.pelecard || null : null;
    c.order = {
      version,
      total: ORDER_PRICES[version],
      address: addr,
      ordered_at: nowIso(),
      paid: false,
      paid_at: null,
      // Pending card-payment handshake (PeleCard); null until pay/init runs.
      pelecard: prevPelecard,
    };
    saveDb();
    return c.order;
  },

  // Record a PeleCard init handshake on an existing order. The per-payment
  // ParamX tokens ACCUMULATE (capped): an owner may open the pay modal more than
  // once, and PeleCard's callback for any of those sessions must still match.
  // Returns false when there is no order to attach it to.
  recordPaymentInit(id, { paramToken, transactionId } = {}) {
    const c = this.getCollection(id);
    if (!c || !c.order) return false;
    const p = c.order.pelecard || { param_tokens: [] };
    if (!Array.isArray(p.param_tokens)) p.param_tokens = [];
    if (paramToken && !p.param_tokens.includes(paramToken)) {
      p.param_tokens.push(paramToken);
      // Bound growth against abuse, but keep enough that a payment completed on
      // an earlier-opened modal can still be correlated back to the order.
      if (p.param_tokens.length > 25) {
        p.param_tokens = p.param_tokens.slice(-25);
      }
    }
    p.last_transaction_id = transactionId || p.last_transaction_id || null;
    p.initiated_at = nowIso();
    c.order.pelecard = p;
    saveDb();
    return true;
  },

  // Find the collection whose order was initialized with this PeleCard ParamX
  // token (the AdditionalDetailsParamX PeleCard echoes back). Returns null if
  // no order matches.
  getCollectionByPayToken(token) {
    if (!token) return null;
    return (
      _db.collections.find(
        (c) =>
          c.order &&
          c.order.pelecard &&
          Array.isArray(c.order.pelecard.param_tokens) &&
          c.order.pelecard.param_tokens.includes(token)
      ) || null
    );
  },

  // Mark an existing order as paid. Used by the admin route (manual) and by the
  // PeleCard callback (meta carries the method + transaction details).
  markPaid(id, meta = {}) {
    const c = this.getCollection(id);
    if (!c || !c.order) return false;
    c.order.paid = true;
    c.order.paid_at = nowIso();
    if (meta.method) c.order.paid_method = meta.method;
    if (meta.transactionId) c.order.paid_transaction_id = meta.transactionId;
    if (meta.approvalNo) c.order.paid_approval_no = meta.approvalNo;
    saveDb();
    return true;
  },
};

module.exports = db;
module.exports.ORDER_PRICES = ORDER_PRICES;
