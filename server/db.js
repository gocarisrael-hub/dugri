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
// Collections stay open for a full year — long enough that they effectively never
// expire within the order flow (a customer has all the time they need to gather
// and add words). Used for a new collection's expires_at.
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
// A collection with no words earns ONE nudge email this long after it was paid
// (or created, when unpaid): the buyer hasn't sent any words yet and production
// can't start until they do. See collectionsDueForReminder.
const REMINDER_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

// A PeleCard pay session only counts as "in flight" (and thus blocks the free
// coupon path) for a short window — a hosted-iframe session that isn't completed
// is abandoned/declined, and its callback never arrives to resolve it. Without a
// TTL a single closed modal would block every future free coupon forever.
const SESSION_TTL_MS = Number(process.env.PELECARD_SESSION_TTL_MS || 20 * 60 * 1000);
// Cap stored pay sessions, but ONLY ever evict RESOLVED ones — dropping an
// unresolved session would lose the amount a later completing callback needs to
// verify against, leaving a charged customer's order stuck unpaid.
const MAX_SESSIONS = Number(process.env.PELECARD_MAX_SESSIONS || 50);

const DEFAULTS = { collections: [], words: [], coupons: [], design_codes: [] };

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
  // Write to a temp file then rename over the real one. rename() on the same
  // filesystem is atomic, so a crash mid-write can never leave a truncated or
  // corrupt data file — readers always see either the old file or the new one.
  // A fixed temp name (not per-pid) means the next save overwrites any leftover
  // from a crash in the write→rename window, so orphan temps can't accumulate.
  // Safe because saveDb is synchronous and the service runs a single process.
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(_db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
// Today as 'YYYY-MM-DD' in Israel time. Coupon expiry is inclusive through the
// end of that Israel day, so the comparison must use the Asia/Jerusalem calendar
// date — not the server's local/UTC date (Railway runs UTC, where a coupon set
// to expire 2026-07-01 would otherwise keep working ~3h into July 2 Israel time).
// ISO date strings sort lexicographically, so a plain string compare is correct.
const todayStrIsrael = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());

// Normalize a coupon code: trim + uppercase. Callers validate the [A-Z0-9] shape.
const normCode = (s) =>
  String(s == null ? '' : s)
    .trim()
    .toUpperCase();

// Normalize a word for dedupe: trim, collapse inner whitespace, lowercase.
function norm(s) {
  return String(s).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Theme extra fields (e.g. AGE, or YEARS + NAME1 + NAME2) collected in the order
// flow. Stored as a flat object of trimmed string values, each capped. Non-object
// input (missing, array, primitive) normalizes to an empty object so the field is
// always a plain object on the collection.
function sanitizeExtraFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v == null) continue;
    const key = String(k).trim().slice(0, 40);
    if (!key) continue;
    out[key] = String(v).trim().slice(0, 80);
  }
  return out;
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
      // Generator theme (a generator/themes.json key) the chosen design resolves
      // to; drives which template production runs. Capped like other order text.
      theme: contact.theme ? String(contact.theme).trim().slice(0, 80) : null,
      // Theme-required extra fields collected after a design is chosen (AGE, or
      // YEARS + NAME1 + NAME2). Always a plain object; {} when none are needed.
      extra_fields: sanitizeExtraFields(contact.extra_fields),
      // Card word-font the customer picked in the preview (a filename in the
      // shared word-fonts/ pool). Passed to the generator as its word_font
      // override at production time. Capped; null keeps the theme's default font.
      word_font: contact.word_font ? String(contact.word_font).trim().slice(0, 80) : null,
      // Honoree gender for the site's gendered question phrasing. Only 'male' or
      // 'female' are accepted; anything else stores null.
      gender: contact.gender === 'male' || contact.gender === 'female' ? contact.gender : null,
      // Optional drinking-game add-on ("צ'ייסרים") - free; the owner builds the
      // board with special "drink" tiles when this is on.
      chasers: !!contact.chasers,
      status: 'open',
      created_at: nowIso(),
      expires_at: new Date(Date.now() + YEAR_MS).toISOString(),
      closed_at: null,
      // One-time "you haven't added words yet" nudge timestamp; null until sent.
      reminded_at: null,
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

  // Record a PeleCard init handshake as a SESSION on the order. Each pay/init is
  // its OWN session record { token, charged_total, coupon, discount_pct,
  // transaction_id, resolved } — an owner may open the pay modal more than once
  // (with different coupons), and PeleCard's callback for ANY of those sessions
  // must verify against THAT session's own amount, not a shared order value.
  // Sessions ACCUMULATE (capped). Returns false when there is no order.
  recordPaymentInit(id, { paramToken, transactionId, charged_total, coupon, discount_pct } = {}) {
    const c = this.getCollection(id);
    if (!c || !c.order) return false;
    const p = c.order.pelecard || { sessions: [] };
    if (!Array.isArray(p.sessions)) p.sessions = [];
    if (paramToken && !p.sessions.some((s) => s.token === paramToken)) {
      p.sessions.push({
        token: paramToken,
        // Always a real number so the callback never verifies against undefined.
        charged_total: Number(charged_total),
        coupon: coupon ? normCode(coupon) : null,
        discount_pct: discount_pct != null ? discount_pct : null,
        transaction_id: transactionId || null,
        resolved: false,
        // Per-session timestamp: bounds the in-flight window (see TTL) and is the
        // basis for evicting only OLD, RESOLVED sessions when over the cap.
        initiated_at: nowIso(),
      });
      // Bound growth, but NEVER evict an unresolved session — a payment completed
      // on any still-open modal must always find its own amount to verify. Drop
      // oldest RESOLVED sessions only; if all are unresolved, keep them all.
      if (p.sessions.length > MAX_SESSIONS) {
        let toDrop = p.sessions.length - MAX_SESSIONS;
        p.sessions = p.sessions.filter((s) => {
          if (toDrop > 0 && s.resolved) {
            toDrop -= 1;
            return false;
          }
          return true;
        });
      }
    }
    p.last_transaction_id = transactionId || p.last_transaction_id || null;
    p.initiated_at = nowIso();
    c.order.pelecard = p;
    saveDb();
    return true;
  },

  // Whether an order has a RECENT in-flight REAL (non-free) pay session: one with
  // a gateway transaction_id and a positive charge, not yet resolved, AND started
  // within SESSION_TTL_MS. A free/coupon path must refuse while such a session
  // exists (else the customer could be charged for a "free" order) — but an
  // abandoned session past the TTL must NOT block the free path forever.
  hasInFlightRealSession(order) {
    if (!order || !order.pelecard || !Array.isArray(order.pelecard.sessions)) return false;
    const now = Date.now();
    return order.pelecard.sessions.some(
      (s) =>
        s &&
        !s.resolved &&
        s.transaction_id &&
        Number(s.charged_total) > 0 &&
        s.initiated_at &&
        now - Date.parse(s.initiated_at) < SESSION_TTL_MS
    );
  },

  // Find the collection whose order has a pay SESSION with this ParamX token
  // (the AdditionalDetailsParamX PeleCard echoes back). Returns null if none.
  getCollectionByPayToken(token) {
    if (!token) return null;
    return (
      _db.collections.find(
        (c) =>
          c.order &&
          c.order.pelecard &&
          Array.isArray(c.order.pelecard.sessions) &&
          c.order.pelecard.sessions.some((s) => s.token === token)
      ) || null
    );
  },

  // Resolve a ParamX token to its { collection, session } pair, or null. The
  // callback uses this to verify against the SESSION's own charged_total.
  getPaymentSessionByToken(token) {
    const c = this.getCollectionByPayToken(token);
    if (!c) return null;
    const session = c.order.pelecard.sessions.find((s) => s.token === token) || null;
    return session ? { collection: c, session } : null;
  },

  // Mark an existing order as paid. Used by the admin route (manual), the
  // PeleCard callback, and the free-coupon path. meta carries the method +
  // transaction details, the applied coupon/charge (for the order record), and
  // optionally the session `token` to mark that session resolved.
  markPaid(id, meta = {}) {
    const c = this.getCollection(id);
    if (!c || !c.order) return false;
    c.order.paid = true;
    c.order.paid_at = nowIso();
    if (meta.method) c.order.paid_method = meta.method;
    if (meta.transactionId) c.order.paid_transaction_id = meta.transactionId;
    if (meta.approvalNo) c.order.paid_approval_no = meta.approvalNo;
    // Record what was actually charged + which coupon on the order for display.
    if (meta.charged_total != null) c.order.charged_total = Number(meta.charged_total);
    if (meta.coupon !== undefined) c.order.coupon = meta.coupon ? normCode(meta.coupon) : null;
    if (meta.discount_pct !== undefined) c.order.discount_pct = meta.discount_pct;
    // Mark the matched pay session resolved so it's no longer "in flight".
    if (meta.token && c.order.pelecard && Array.isArray(c.order.pelecard.sessions)) {
      const s = c.order.pelecard.sessions.find((x) => x.token === meta.token);
      if (s) s.resolved = true;
    }
    saveDb();
    return true;
  },

  // Record the PDF-production state for a collection. Shape:
  // { state:'generated', pdf_file, generated_at, theme?, pages? }. Stored on the
  // order when one exists (order.production, per the order model) and always
  // mirrored to the collection (c.production) so an order that was generated
  // before a version was chosen still surfaces its production state. Returns the
  // stored production object, or false when the collection is unknown.
  setProduction(id, production) {
    const c = this.getCollection(id);
    if (!c) return false;
    const rec = { ...production };
    c.production = rec;
    if (c.order) c.order.production = rec;
    saveDb();
    return rec;
  },

  // --- Discount coupons ---------------------------------------------------
  // A coupon is a percentage-off code the admin creates and the checkout
  // applies. Shape: { id, code, discount_pct, valid_until, active, created_at,
  // uses }. `valid_until` is a 'YYYY-MM-DD' string (inclusive) or null = never
  // expires. `uses` counts orders that used the coupon and became paid.

  // Create a coupon. Validates the code shape/uniqueness and the percentage,
  // then persists it. Returns the stored coupon, or { error } on bad input or a
  // duplicate code.
  createCoupon({ code, discount_pct, valid_until } = {}) {
    const c = normCode(code);
    if (!/^[A-Z0-9]{3,20}$/.test(c)) return { error: 'bad code' };
    if (!Number.isInteger(discount_pct) || discount_pct < 1 || discount_pct > 100) {
      return { error: 'bad discount_pct' };
    }
    let until = null;
    if (valid_until != null && valid_until !== '') {
      const s = String(valid_until).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
        return { error: 'bad valid_until' };
      }
      until = s;
    }
    if (_db.coupons.some((x) => x.code === c)) return { error: 'duplicate' };
    const coupon = {
      id: uid(),
      code: c,
      discount_pct,
      valid_until: until,
      active: true,
      created_at: nowIso(),
      uses: 0,
    };
    _db.coupons.push(coupon);
    saveDb();
    return coupon;
  },

  // All coupons, newest first.
  listCoupons() {
    return [..._db.coupons].sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  getCouponByCode(code) {
    const c = normCode(code);
    return _db.coupons.find((x) => x.code === c) || null;
  },

  getCouponById(id) {
    return _db.coupons.find((x) => x.id === id) || null;
  },

  setCouponActive(id, active) {
    const c = this.getCouponById(id);
    if (!c) return null;
    c.active = !!active;
    saveDb();
    return c;
  },

  deleteCoupon(id) {
    const before = _db.coupons.length;
    _db.coupons = _db.coupons.filter((x) => x.id !== id);
    if (_db.coupons.length === before) return false;
    saveDb();
    return true;
  },

  // Validate a code for use at checkout. Returns { valid:true, coupon } or
  // { valid:false, reason } with reason in 'not_found'|'inactive'|'expired'.
  validateCoupon(code) {
    const c = this.getCouponByCode(code);
    if (!c) return { valid: false, reason: 'not_found' };
    if (!c.active) return { valid: false, reason: 'inactive' };
    // valid_until is inclusive: expired only once today (Israel) is after it.
    if (c.valid_until && todayStrIsrael() > c.valid_until) {
      return { valid: false, reason: 'expired' };
    }
    return { valid: true, coupon: c };
  },

  // Increment a coupon's use counter (called when an order that used it is
  // marked paid). No-op/false when the code is unknown.
  incrementCouponUses(code) {
    const c = this.getCouponByCode(code);
    if (!c) return false;
    c.uses = (c.uses || 0) + 1;
    saveDb();
    return true;
  },

  // --- Words reminder ------------------------------------------------------
  // Mark a collection as having received its one-time "add your words" nudge.
  markReminded(id) {
    const c = this.getCollection(id);
    if (!c) return false;
    c.reminded_at = nowIso();
    saveDb();
    return true;
  },

  // The collections DUE for the one-time words reminder (read-only query).
  collectionsDueForReminder(now = Date.now()) {
    const cutoff = now - REMINDER_AFTER_MS;
    return _db.collections.filter((c) => {
      if (!c || !c.owner_email) return false;
      if (c.cancelled) return false;
      if (c.reminded_at) return false;
      const hasWords = _db.words.some((w) => w.collection_id === c.id);
      if (hasWords) return false;
      const paidAt = c.order && c.order.paid && c.order.paid_at ? c.order.paid_at : null;
      const basis = paidAt || c.created_at;
      const basisMs = Date.parse(basis);
      if (Number.isNaN(basisMs)) return false;
      return basisMs < cutoff;
    });
  },

  // --- Private-design access codes ----------------------------------------
  createDesignCode({ code, design_id, valid_until } = {}) {
    const c = normCode(code);
    if (!/^[A-Z0-9]{3,20}$/.test(c)) return { error: 'bad code' };
    const design = String(design_id == null ? '' : design_id)
      .trim()
      .slice(0, 80);
    if (!design) return { error: 'bad design_id' };
    let until = null;
    if (valid_until != null && valid_until !== '') {
      const s = String(valid_until).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
        return { error: 'bad valid_until' };
      }
      until = s;
    }
    if (_db.design_codes.some((x) => x.code === c)) return { error: 'duplicate' };
    const rec = {
      id: uid(),
      code: c,
      design_id: design,
      valid_until: until,
      active: true,
      created_at: nowIso(),
      uses: 0,
    };
    _db.design_codes.push(rec);
    saveDb();
    return rec;
  },

  listDesignCodes() {
    return [..._db.design_codes].sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  getDesignCodeByCode(code) {
    const c = normCode(code);
    return _db.design_codes.find((x) => x.code === c) || null;
  },

  getDesignCodeById(id) {
    return _db.design_codes.find((x) => x.id === id) || null;
  },

  setDesignCodeActive(id, active) {
    const c = this.getDesignCodeById(id);
    if (!c) return null;
    c.active = !!active;
    saveDb();
    return c;
  },

  deleteDesignCode(id) {
    const before = _db.design_codes.length;
    _db.design_codes = _db.design_codes.filter((x) => x.id !== id);
    if (_db.design_codes.length === before) return false;
    saveDb();
    return true;
  },

  validateDesignCode(code) {
    const c = this.getDesignCodeByCode(code);
    if (!c) return { valid: false, reason: 'not_found' };
    if (!c.active) return { valid: false, reason: 'inactive' };
    if (c.valid_until && todayStrIsrael() > c.valid_until) {
      return { valid: false, reason: 'expired' };
    }
    return { valid: true, design_id: c.design_id };
  },

  incrementDesignCodeUses(code) {
    const c = this.getDesignCodeByCode(code);
    if (!c) return false;
    c.uses = (c.uses || 0) + 1;
    saveDb();
    return true;
  },
};

module.exports = db;
module.exports.ORDER_PRICES = ORDER_PRICES;
