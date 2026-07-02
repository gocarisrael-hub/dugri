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

// A PeleCard pay session only counts as "in flight" (and thus blocks the free
// coupon path) for a short window — a hosted-iframe session that isn't completed
// is abandoned/declined, and its callback never arrives to resolve it. Without a
// TTL a single closed modal would block every future free coupon forever.
const SESSION_TTL_MS = Number(process.env.PELECARD_SESSION_TTL_MS || 20 * 60 * 1000);
// Cap stored pay sessions, but ONLY ever evict RESOLVED ones — dropping an
// unresolved session would lose the amount a later completing callback needs to
// verify against, leaving a charged customer's order stuck unpaid.
const MAX_SESSIONS = Number(process.env.PELECARD_MAX_SESSIONS || 50);

const DEFAULTS = { collections: [], words: [], coupons: [] };

// Single source of truth for order pricing (NIS).
// pdf = digital PDF; pickup = printed + pickup at גלאור; delivery = door-to-door.
const ORDER_PRICES = { pdf: 79, pickup: 149, delivery: 199 };

// How often, at most, the dirty in-memory state is flushed to disk. A burst of
// mutations (e.g. many word-adds arriving together) collapses to roughly one
// write per interval instead of one blocking write per mutation.
const FLUSH_INTERVAL_MS = Number(process.env.DB_FLUSH_INTERVAL_MS || 1000);

// In-memory index: collection_id -> array of that collection's word objects.
// A DERIVED view of _db.words (the persisted source of truth), NOT persisted.
// Lets hot read paths (listWords poll, addWords dedupe, admin word_count) cost
// O(words-in-collection) instead of scanning the whole words array every time.
let _wordsByCollection = new Map();

function rebuildWordIndex() {
  _wordsByCollection = new Map();
  for (const w of _db.words) {
    let arr = _wordsByCollection.get(w.collection_id);
    if (!arr) {
      arr = [];
      _wordsByCollection.set(w.collection_id, arr);
    }
    arr.push(w);
  }
}

// Words of a single collection (never mutate the returned array in place).
function wordsFor(id) {
  return _wordsByCollection.get(id) || [];
}

// Add a word object to the index (mirrors an _db.words.push).
function indexWord(w) {
  let arr = _wordsByCollection.get(w.collection_id);
  if (!arr) {
    arr = [];
    _wordsByCollection.set(w.collection_id, arr);
  }
  arr.push(w);
}

// Remove a single word (by id) from a collection's index array.
function unindexWord(collectionId, wordId) {
  const arr = _wordsByCollection.get(collectionId);
  if (!arr) return;
  const i = arr.findIndex((w) => w.id === wordId);
  if (i !== -1) arr.splice(i, 1);
  if (arr.length === 0) _wordsByCollection.delete(collectionId);
}

function loadDb() {
  try {
    // JSON.parse handles both compact and legacy pretty-printed files.
    if (!fs.existsSync(DB_FILE)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

let _db = loadDb();
rebuildWordIndex();

// --- Coalesced + atomic persistence --------------------------------------
// The old code did a synchronous pretty-printed writeFileSync of the WHOLE db
// on every mutation. With a ~150MB file that blocked the single event-loop
// thread for seconds per request, freezing all concurrent traffic (even static
// files) until Railway's 15s proxy timeout returned 502s.
//
// Now most mutations mark the state dirty and flush asynchronously, coalesced
// to at most once per FLUSH_INTERVAL_MS, to a temp file that is atomically
// renamed over DB_FILE. Payment-critical mutations (see saveDb({immediate}))
// instead flush SYNCHRONOUSLY so a charged customer's paid state / ParamX token
// is durable the instant the HTTP handler returns — durability beats latency
// for money, and those writes are rare.
//
// HONEST CAVEAT: the async flush still runs JSON.stringify(_db) over the whole
// ~150MB in one synchronous call on the event-loop thread; only the disk I/O
// (writeFile) is async. Coalescing cuts how OFTEN that serialize stall happens,
// but it does not remove the per-flush freeze.
// TODO(datastore): the real long-term fix is an incremental store (e.g. SQLite)
// so a change writes only its own rows instead of re-serializing the whole DB.
let _flushScheduled = false;
let _flushTimer = null;
let _flushing = false;
let _lastFlushAt = 0;
let _tmpSeq = 0;
// Monotonic version counters. _seq bumps on every mutation; _writtenSeq is the
// highest _seq known to be durably on disk. dirty === (_seq > _writtenSeq).
// Comparing them (instead of a boolean) lets a synchronous flush and an
// in-flight async flush coordinate: an async flush that finishes AFTER a newer
// sync flush already persisted a higher _seq must NOT rename its now-stale temp
// over the fresher file.
let _seq = 0;
let _writtenSeq = 0;

function isDirty() {
  return _seq > _writtenSeq;
}

const tmpPath = (tag) => `${DB_FILE}.tmp-${tag || process.pid}-${_tmpSeq++}`;

// Public API — callers keep calling saveDb() exactly as before. Without options
// it defers; saveDb({ immediate: true }) forces a synchronous durable write for
// payment-critical mutations.
function saveDb(options) {
  _seq += 1;
  if (options && options.immediate) {
    flushSync();
    return;
  }
  scheduleFlush();
}

function scheduleFlush() {
  if (_flushScheduled || _flushing || !isDirty()) return;
  _flushScheduled = true;
  const elapsed = Date.now() - _lastFlushAt;
  const delay = Math.max(0, FLUSH_INTERVAL_MS - elapsed);
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    _flushScheduled = false;
    flushAsync();
  }, delay);
  // Don't let a pending flush timer keep the process alive on shutdown; the
  // SIGTERM/SIGINT/exit handlers do a final synchronous flush instead.
  if (_flushTimer && typeof _flushTimer.unref === 'function') _flushTimer.unref();
}

async function flushAsync() {
  if (_flushing || !isDirty()) return;
  _flushing = true;
  // Advance the attempt timestamp NOW (not only on success) so a persistently
  // failing write backs off to ~FLUSH_INTERVAL_MS between tries instead of
  // busy-looping with delay 0 and hammering the disk on the event-loop thread.
  _lastFlushAt = Date.now();
  const seq = _seq;
  const data = JSON.stringify(_db);
  const tmp = tmpPath();
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(tmp, data, 'utf8');
    if (seq <= _writtenSeq) {
      // A synchronous flush persisted a newer (or equal) state while we were
      // writing — our temp is stale, so discard it rather than clobber.
      await fs.promises.unlink(tmp);
    } else {
      await fs.promises.rename(tmp, DB_FILE);
      _writtenSeq = seq;
    }
  } catch (err) {
    console.error('[db] persistence failed', err);
    // Leave the state dirty (_writtenSeq unadvanced) so a later flush retries.
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* temp may not exist */
    }
  } finally {
    _flushing = false;
    // Dirtied again while we were writing (or the write failed): flush again.
    if (isDirty()) scheduleFlush();
  }
}

// Synchronous, durable, atomic write of the CURRENT in-memory state. Used both
// for payment-critical mutations and for graceful shutdown. Always writes the
// latest _db regardless of the dirty flag or any in-flight async flush — that
// is idempotent (persisting current state is always safe) and guarantees a
// SIGTERM redeploy never skips the write just because an async flush had
// already cleared the dirty state without finishing its rename.
function flushSync() {
  const seq = _seq;
  const tmp = tmpPath('sync');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(_db), 'utf8');
    fs.renameSync(tmp, DB_FILE);
    if (seq > _writtenSeq) _writtenSeq = seq;
    _lastFlushAt = Date.now();
  } catch (err) {
    console.error('[db] persistence failed', err);
    // Clean up our own temp so a failed sync write leaves no orphan.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  }
}

// Remove any leftover *.tmp-* files (e.g. from an async flush interrupted by
// SIGTERM before its rename). Called on shutdown after the final sync write.
function cleanupTempFiles() {
  try {
    const prefix = `${path.basename(DB_FILE)}.tmp-`;
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (name.startsWith(prefix)) {
        try {
          fs.rmSync(path.join(DATA_DIR, name), { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* dir may not exist */
  }
}

// Register shutdown handlers once. On SIGTERM/SIGINT (Railway redeploy) flush
// synchronously and sweep temp files, then re-raise the signal with default
// behavior so the process still terminates normally (adding a listener
// otherwise suppresses the default exit). 'exit' is a last-resort sync flush.
let _handlersRegistered = false;
function registerShutdownHandlers() {
  if (_handlersRegistered) return;
  _handlersRegistered = true;
  const onSignal = (sig) => {
    flushSync();
    cleanupTempFiles();
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('exit', () => {
    flushSync();
    cleanupTempFiles();
  });
}
registerShutdownHandlers();

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
        word_count: wordsFor(c.id).length,
      }));
  },

  listWords(id) {
    // Copy the per-collection index array before sorting so we never reorder
    // the index itself.
    return [...wordsFor(id)].sort((a, b) => a.created_at.localeCompare(b.created_at));
  },

  // Add a batch of words. Dedupes (case/space-insensitive) within the
  // collection. Returns {added, skipped} or {closed:true} if not open.
  addWords(id, words, addedBy) {
    const c = this.getCollection(id);
    if (!c) return null;
    if (effectiveStatus(c) !== 'open') return { closed: true, added: 0, skipped: 0 };

    const indexArr = wordsFor(id);
    const existing = new Set(indexArr.map((w) => w.norm));
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
      const w = {
        id: uid(),
        collection_id: id,
        text,
        norm: n,
        added_by: by,
        created_at: nowIso(),
      };
      _db.words.push(w);
      indexWord(w);
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
    unindexWord(id, wordId);
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
    _wordsByCollection.delete(id);
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
    // Payment-critical: the ParamX token MUST be durable before we answer the
    // HTTP request, else a restart in the ~1s async window loses the token the
    // PeleCard callback needs to verify the charge. Flush synchronously.
    saveDb({ immediate: true });
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
    // Payment-critical: a charged customer's paid state must survive an
    // immediate restart, so persist synchronously before the handler returns.
    saveDb({ immediate: true });
    return true;
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
};

module.exports = db;
module.exports.ORDER_PRICES = ORDER_PRICES;

// Internal hooks for unit tests only — NOT part of the public API used by
// server/index.js. Lets tests drive the deferred-flush machinery and inspect
// the in-memory word index deterministically.
module.exports.__test = {
  DB_FILE,
  DATA_DIR,
  flushNow: () => flushAsync(),
  flushSync,
  isDirty,
  isFlushing: () => _flushing,
  wordIndexFor: (id) => wordsFor(id),
  wordIndexSize: () => _wordsByCollection.size,
  reload: () => {
    _db = loadDb();
    rebuildWordIndex();
    // The reloaded state matches disk, so mark it clean.
    _writtenSeq = _seq;
    return _db;
  },
  // Cancel any pending scheduled flush and clear transient flags, so scheduling
  // state can't leak between tests (a fake timer discarded by useRealTimers
  // would otherwise leave _flushScheduled stuck true).
  reset: () => {
    if (_flushTimer) {
      clearTimeout(_flushTimer);
      _flushTimer = null;
    }
    _flushScheduled = false;
    _flushing = false;
  },
};
