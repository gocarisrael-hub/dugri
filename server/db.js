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

// Owner-editable pricing lives in server/settings.js (the `pricing` section) so
// the store price + per-version enable/price change with NO deploy. This module
// reads it as the AUTHORITATIVE charge. settings.js requires nothing from db, so
// this import is cycle-free; it's wrapped so a broken settings module can never
// take the charge path down (we fall back to the built-in defaults below).
let settings = null;
try {
  settings = require('./settings');
} catch {
  settings = null;
}

// The built-in fallback pricing is DERIVED from the settings.js registry defaults
// (single source of truth — no pricing number is hardcoded here). `ORDER_PRICES`
// is also the canonical set of known versions. These are used when a runtime
// settings read fails; if the settings module itself failed to load the maps are
// empty and setOrder fails closed (rejects every version) rather than mischarge.
// pdf = digital PDF; pickup = printed + pickup at גלאור; delivery = door-to-door;
// custom = a "hand-designed just for you" bespoke game we design by hand.
function pricingDefaults() {
  const reg = (settings && settings.REGISTRY && settings.REGISTRY.pricing) || {};
  const prices = {};
  const enabled = {};
  const store = {};
  for (const key of Object.keys(reg)) {
    const d = reg[key].default;
    let m;
    if ((m = /^(.+)_price$/.exec(key))) prices[m[1]] = d;
    else if ((m = /^(.+)_enabled$/.exec(key))) enabled[m[1]] = d === true;
    else if (key === 'store_now' || key === 'store_was') store[key] = d;
  }
  return { prices, enabled, store };
}
const { prices: ORDER_PRICES, enabled: DEFAULT_ENABLED, store: STORE_DEFAULTS } = pricingDefaults();

// Is a version currently offered? Reads the `<v>_enabled` flag from settings,
// falling back to the built-in launch default if a settings read fails.
function versionEnabled(version) {
  if (!Object.prototype.hasOwnProperty.call(ORDER_PRICES, version)) return false;
  try {
    return settings.get('pricing', version + '_enabled') === true;
  } catch {
    return DEFAULT_ENABLED[version] === true;
  }
}

// The NIS charge for a version — the AUTHORITATIVE amount. Reads `<v>_price` from
// settings; only a POSITIVE integer (>= 1) is honoured, otherwise it falls back to
// the built-in default (which is itself >= 1). This guarantees a base version
// total is never 0/negative even if a corrupt override slipped past validation.
function versionPrice(version) {
  try {
    const p = settings.get('pricing', version + '_price');
    if (Number.isInteger(p) && p >= 1) return p;
  } catch {
    /* settings unavailable — use the built-in default below */
  }
  return ORDER_PRICES[version];
}

// Last-resort baked store display defaults, used only if the settings module
// itself failed to load (so the registry-derived STORE_DEFAULTS are empty). This
// guarantees the public projection never emits an `undefined` store price that
// would render as "undefined ₪" on the storefront.
const BAKED_STORE = { store_now: 199, store_was: 239 };

// The effective store display price for `store_now`/`store_was`. Display-only
// (never charged), so 0 is allowed; a corrupt/non-integer override falls back to
// the registry default, and to the baked default if even that is unavailable.
function storeValue(key) {
  try {
    const v = settings.get('pricing', key);
    if (Number.isInteger(v) && v >= 0) return v;
  } catch {
    /* settings unavailable — use the built-in default below */
  }
  const d = STORE_DEFAULTS[key];
  return Number.isInteger(d) ? d : BAKED_STORE[key];
}

// The single source for the PUBLIC /api/pricing projection AND the charge path:
// both read these same functions, so what the buyer is SHOWN can never disagree
// with what the server CHARGES. Shape: { store:{now,was}, versions:{<v>:{enabled,
// price}} }.
function effectivePricing() {
  const versions = {};
  for (const v of Object.keys(ORDER_PRICES)) {
    versions[v] = { enabled: versionEnabled(v), price: versionPrice(v) };
  }
  return { store: { now: storeValue('store_now'), was: storeValue('store_was') }, versions };
}

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

// F7 custom title: an OPTIONAL per-order free-form title that OVERRIDES the
// theme-derived title on the cards + board. Normalizes newlines, trims and
// collapses inner spaces per line, drops blank lines, and caps the total length.
// Empty/whitespace input -> null (absent), so the theme's own title is used
// unchanged. Newlines are preserved as deliberate line breaks (the generator
// splits on them); the cap guards against an unbounded stored string.
const CUSTOM_TITLE_MAX = 120;
function sanitizeCustomTitle(input) {
  if (input == null) return null;
  const lines = String(input)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((ln) => ln.trim().replace(/\s+/g, ' '))
    .filter((ln) => ln.length);
  if (!lines.length) return null;
  // Cap by code point (Array.from splits on astral chars) so the 120 boundary
  // never bisects an emoji/surrogate pair and emits a lone surrogate.
  return Array.from(lines.join('\n')).slice(0, CUSTOM_TITLE_MAX).join('');
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
  // Exposed for the preview route (parity with stored orders) + unit tests.
  sanitizeCustomTitle,

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
      // Up to 4 optional customer photos ("פיונים") attached to the collection,
      // stored as public "/content-uploads/<hash>.<ext>" path strings. Appended
      // via addPawnImages (owner-token gated). Empty on a fresh collection.
      pawn_images: [],
      // Optional free-form custom title (F7) overriding the theme's derived title
      // on the cards + board. Sanitized/capped; null when empty so the theme
      // default is used. The generator receives this via its --title CLI arg.
      custom_title: sanitizeCustomTitle(contact.custom_title),
      status: 'open',
      created_at: nowIso(),
      expires_at: new Date(Date.now() + YEAR_MS).toISOString(),
      closed_at: null,
      // One-time "you haven't added words yet" nudge timestamp; null until sent.
      reminded_at: null,
      // One-time "order received" notification marker (owner + buyer emails and
      // the WhatsApp group fire once, when the order is first created — not on
      // payment). Null until markOrderNotified sets it.
      order_notified_at: null,
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

  // Count collections whose order is paid (c.order.paid truthy). Feeds the
  // public /api/stats/orders social-proof counter — it exposes ONLY this
  // aggregate, never any order detail.
  countPaidOrders() {
    return _db.collections.filter((c) => c.order && c.order.paid).length;
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

  // Cheap word count for a collection: a single O(n) pass with NO array build and
  // NO sort, for hot paths (the inbound WhatsApp message handler) that only need
  // the number, not the ordered list. Prefer this over listWords(id).length there.
  countWords(id) {
    let n = 0;
    for (const w of _db.words) if (w.collection_id === id) n += 1;
    return n;
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

  // Owner-only: edit ONE word's text (fix a typo). Trims, collapses inner
  // whitespace and caps at 80 like addWords; the word keeps its identity and its
  // added_by/created_at metadata — only `text` (and its dedupe `norm`) change.
  // Returns the updated word, or an { error } object:
  //   'forbidden'  bad owner token
  //   'not_found'  no such word in this collection
  //   'empty'      the new text normalizes away to nothing
  //   'duplicate'  another word in the collection already has this normalized text
  // Returns null when the collection itself doesn't exist (so the route can 404).
  // Like deleteWord it does NOT gate on open/closed status — the owner can fix a
  // typo at any time. Idempotent: re-saving the same text is a no-op that still
  // succeeds.
  editWord(id, wordId, text, ownerToken) {
    const c = this.getCollection(id);
    if (!c) return null;
    if (c.owner_token !== ownerToken) return { error: 'forbidden' };
    const w = _db.words.find((x) => x.id === wordId && x.collection_id === id);
    if (!w) return { error: 'not_found' };
    const clean = String(text == null ? '' : text)
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 80);
    if (!clean) return { error: 'empty' };
    const n = norm(clean);
    // Reject a collision with a DIFFERENT word that shares the normalized form.
    // Re-casing/re-spacing the word's own text (same norm, own id) is allowed.
    const clash = _db.words.some((x) => x.collection_id === id && x.id !== wordId && x.norm === n);
    if (clash) return { error: 'duplicate' };
    if (w.text === clean && w.norm === n) return w; // no change — idempotent
    w.text = clean;
    w.norm = n;
    saveDb();
    return w;
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

  // Append up to N pawn images (customer pieces) to a collection, owner-token gated.
  // Caps the stored array at 4 total, and DE-DUPES incoming paths both against what's
  // already stored and within the batch — the paths are content-addressed, so the
  // same photo picked into two slots yields the same /content-uploads/<hash> and must
  // not appear twice. Returns the updated array, or null on a bad/absent owner token
  // or unknown collection.
  addPawnImages(id, ownerToken, paths) {
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return null;
    if (!Array.isArray(c.pawn_images)) c.pawn_images = [];
    const seen = new Set(c.pawn_images);
    const incoming = [];
    for (const raw of Array.isArray(paths) ? paths : []) {
      const p = String(raw);
      if (!p || seen.has(p)) continue; // skip empties + duplicates (existing OR batch)
      seen.add(p);
      incoming.push(p);
    }
    if (!incoming.length) return c.pawn_images;
    const room = Math.max(0, 4 - c.pawn_images.length);
    if (room > 0) {
      c.pawn_images.push(...incoming.slice(0, room));
      saveDb();
    }
    return c.pawn_images;
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

  // Admin: reopen a collection that stopped accepting words because it was
  // closed (owner finished the list) or its expiry passed, so a customer can add
  // more words. Flips status back to 'open', clears closed_at, and pushes
  // expires_at out a fresh full year (same window a new collection gets). Does
  // NOT touch a soft-cancel — a cancelled order is restored with cancelCollection
  // (undo), and effectiveStatus keeps returning 'cancelled' until it is. Returns
  // the new effective status, or null when the collection doesn't exist.
  reopenCollection(id) {
    const c = this.getCollection(id);
    if (!c) return null;
    // A soft-cancelled collection is reopened by restoring it (cancelCollection
    // undo), never here. Mutating its lifecycle fields would silently drop the
    // original closed_at/expiry (a later restore would then resurface it as
    // freshly open) while effectiveStatus still reported 'cancelled'. No-op.
    if (c.cancelled) return effectiveStatus(c);
    c.status = 'open';
    c.closed_at = null;
    c.expires_at = new Date(Date.now() + YEAR_MS).toISOString();
    saveDb();
    return effectiveStatus(c);
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
  //
  // opts.admin — an internal/admin call (e.g. the bespoke custom-order route). It
  //   BYPASSES the public version-enable gate + the version-lock, so the owner can
  //   hand-create a custom (599₪) order even while `custom` is hidden from public
  //   buyers. Public routes (/order, /pay/init) never pass it.
  setOrder(id, ownerToken, { version, address } = {}, opts = {}) {
    const admin = !!(opts && opts.admin);
    const c = this.getCollection(id);
    if (!c || c.owner_token !== ownerToken) return { error: 'forbidden' };
    if (!Object.prototype.hasOwnProperty.call(ORDER_PRICES, version)) {
      return { error: 'bad version' };
    }
    // Version-lock policy for PUBLIC callers (an admin call bypasses all of this):
    //   • A PAID order is immutable — a completed purchase is never re-charged or
    //     downgraded, whatever version is POSTed.
    //   • An ADMIN-CREATED order (source==='admin', e.g. a bespoke 599₪ custom
    //     quote) is LOCKED to its version: the buyer may re-submit the SAME version
    //     to pay it, but can never switch it to a cheaper one. This is the backstop
    //     against a client downgrading a 599₪ custom order to pickup (199₪).
    //   • An ordinary UNPAID public order is NOT locked — the buyer may still
    //     freely switch to any ENABLED version (re-priced from settings). A buyer
    //     who abandons a card session for one version must be able to order another.
    const cur = c.order || null;
    const curPaid = !!(cur && cur.paid);
    const curAdmin = !!(cur && cur.source === 'admin');
    const sameVersion = !!(cur && cur.version === version);
    if (!admin) {
      if (curPaid) return { error: 'version locked' };
      if (curAdmin && !sameVersion) return { error: 'version locked' };
    }
    // An existing UNPAID order preserves its stored total + pending PeleCard
    // handshake when the SAME version is re-submitted (e.g. paying an admin custom
    // quote, or updating a delivery address without changing the version).
    const existing = cur && !curPaid ? cur : null;
    const sameAsExisting = !!(existing && existing.version === version);
    // Reject a version the owner has turned OFF in admin (settings) exactly like an
    // unknown one — a disabled option can never be charged even if a client POSTs
    // it directly. EXEMPT: an admin call, or re-submitting the order's own locked
    // version (a buyer must be able to pay an admin-created custom order even
    // though `custom` is hidden from the public checkout).
    if (!admin && !sameAsExisting && !versionEnabled(version)) {
      return { error: 'version unavailable' };
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
      // Re-submitting the SAME version keeps the order's stored total (honours the
      // price it was created at — e.g. an admin custom quote — even if settings
      // later changed); a brand-new order is priced from settings now.
      total: sameAsExisting ? existing.total : versionPrice(version),
      address: addr,
      ordered_at: nowIso(),
      paid: false,
      paid_at: null,
      // Provenance. 'admin' marks a hand-created order (e.g. a custom quote); it
      // is version-locked for public callers (see the lock policy above). A buyer
      // re-submitting an admin order's own version PRESERVES the flag so it stays
      // locked; a brand-new public order is 'public' and freely switchable.
      source: admin ? 'admin' : (existing && existing.source) || 'public',
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
    // A custom ("hand-designed just for you") order needs manual design work once
    // paid — flag a production sub-state so the admin dashboard surfaces it as
    // awaiting design. Mirrored to the collection (like setProduction) and never
    // clobbers an already-recorded production state.
    if (c.order.version === 'custom' && !c.order.production) {
      const rec = { state: 'needs_design', custom: true, flagged_at: c.order.paid_at };
      c.order.production = rec;
      c.production = rec;
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
    // A successfully generated PDF gets a per-collection capability token so the
    // customer can be emailed a download link that never carries the admin key.
    // Reuse an existing token across regenerations so any already-sent link keeps
    // working; only mint one the first time this collection produces a PDF.
    if (rec.state === 'generated' && !rec.pdf_token) {
      const prev = (c.order && c.order.production) || c.production || null;
      rec.pdf_token = (prev && prev.pdf_token) || crypto.randomBytes(24).toString('hex');
    }
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

  // --- Order-created notification (idempotent) -----------------------------
  // Atomically claim the one-time "order received" notification for a collection:
  // returns true ONLY on the first call (and stamps order_notified_at), false
  // every time after. Callers gate the owner/buyer emails + WhatsApp group on a
  // true return, so re-setting the order version or re-opening the pay modal never
  // re-notifies. The check-and-set is synchronous (single process), so two near-
  // simultaneous order writes can't both win.
  markOrderNotified(id) {
    const c = this.getCollection(id);
    if (!c) return false;
    if (c.order_notified_at) return false;
    c.order_notified_at = nowIso();
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
// The effective pricing projection (store + per-version enabled/price), read by
// the public GET /api/pricing so the DISPLAY always matches the CHARGE path.
module.exports.effectivePricing = effectivePricing;
