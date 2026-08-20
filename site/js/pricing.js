// Shared client helper: fetch the owner-editable pricing from the PUBLIC
// /api/pricing endpoint. The store price (now/struck-was) and each checkout
// version's { enabled, price } are edited by the owner from admin-pricing.html
// with no deploy; every storefront surface reads them through this helper.
//
// The fetch is TIMEOUT-BOUNDED (AbortController) and fail-safe. It always resolves
// to { store, versions, ok }: on a slow/failing/non-2xx/malformed response it
// returns the PRICING_FALLBACK launch defaults with `ok: false`; on success the
// live pricing with `ok: true`. Display-only surfaces (store price on
// products/index/product) can ignore `ok` and just show the numbers. The CHARGE
// path (collect.html checkout) MUST honour `ok` — when false it must NOT offer to
// pay at a guessed price, because the server would charge the live settings price
// the client couldn't read.
//
// PRICING_FALLBACK is the SINGLE client-side source of the launch defaults —
// imported everywhere a fallback is needed (never re-declared per page).

export const PRICING_FALLBACK = {
  store: { now: 199, was: 239 },
  versions: {
    pdf: { enabled: false, price: 79 },
    pickup: { enabled: true, price: 199 },
    delivery: { enabled: false, price: 199 },
    custom: { enabled: false, price: 599 },
  },
  // Shipping, charged ONCE per order however many copies it holds. 0 in the
  // fallback: a guessed fee would be a guessed CHARGE, and the checkout must
  // never show a number the server did not send.
  delivery_fee: 0,
  // Sale mode OFF in the fallback, on purpose. Every other fallback number is a
  // price we are willing to SHOW; a sale is a CLAIM ("this used to cost more"),
  // and a claim we could not read from the server is one we must not make. The
  // cost of being wrong here is asymmetric: hiding a real sale for a moment is a
  // missed nudge, showing a sale that ended is a false discount.
  sale: { on: false, label: 'מחיר השקה', banner: '' },
  // Localities where delivery takes longer — the HEADLINE only (how many, and
  // how long). The names themselves are a separate fetch, since only the
  // checkout prints them; see fetchDeliveryExceptions below.
  // A count of 0 in the fallback, for the same reason `sale` is off in it: the
  // note is a PROMISE about a delivery date, and a promise we could not read
  // from the server is one we must not make. No note simply leaves the standard
  // estimate standing.
  delivery_exceptions: { count: 0, eta_days: 11 },
};

// A well-formed pricing payload: store.now/was are integers AND every known
// version carries an integer price + boolean enabled. A store object with no
// integer now/was (e.g. an empty projection from a settings-load failure) is
// REJECTED so the storefront never renders "undefined ₪" — the caller falls back
// to PRICING_FALLBACK instead.
function isValidPricing(j) {
  if (!j || !j.store || !j.versions) return false;
  if (!Number.isInteger(j.store.now) || !Number.isInteger(j.store.was)) return false;
  for (const v of Object.keys(PRICING_FALLBACK.versions)) {
    const info = j.versions[v];
    if (!info || typeof info.enabled !== 'boolean' || !Number.isInteger(info.price)) return false;
  }
  return true;
}

// Normalise the payload's optional `sale` block. It is optional so an OLDER
// server (deployed before sale mode) still answers a payload this client accepts
// — it simply reports no sale. A malformed block is treated the same way: `on`
// must be a real boolean, and the strings must be strings, or we fall back to
// "no sale" rather than painting `undefined` into a label.
function saleOf(j) {
  const s = j && j.sale;
  if (!s || s.on !== true) return { ...PRICING_FALLBACK.sale };
  return {
    on: true,
    label: typeof s.label === 'string' && s.label ? s.label : PRICING_FALLBACK.sale.label,
    banner: typeof s.banner === 'string' ? s.banner : '',
  };
}

// Normalise the payload's optional `delivery_exceptions` block, the same way
// and for the same reason as `saleOf`: an older server omits it entirely, and a
// malformed one must read as "no exceptions" rather than paint `undefined` into
// a list of towns. Every town is coerced to a trimmed non-empty string here, so
// the renderer downstream can assume clean data.
function exceptionsOf(j) {
  const e = j && j.delivery_exceptions;
  const fallback = { count: 0, eta_days: PRICING_FALLBACK.delivery_exceptions.eta_days };
  if (!e || !Number.isInteger(e.count) || e.count < 0) return fallback;
  return {
    count: e.count,
    eta_days: Number.isInteger(e.eta_days) && e.eta_days > 0 ? e.eta_days : fallback.eta_days,
  };
}

// The localities themselves, from their own endpoint. Called ONLY by the surface
// that prints them (the checkout's delivery note) — the list is thousands of
// names on a real courier's list, and no other page shows one of them.
//
// Fail-safe exactly like fetchPricing: on a slow, failing or malformed response
// it resolves to an EMPTY list, which hides the note rather than announcing an
// exception it cannot name. Every town is coerced to a trimmed non-empty string
// here, so the renderer downstream can assume clean data.
export async function fetchDeliveryExceptions(timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('/api/delivery-exceptions', { signal: ctrl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (!j || !Array.isArray(j.towns)) throw new Error('bad shape');
    return {
      towns: j.towns.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()),
      eta_days:
        Number.isInteger(j.eta_days) && j.eta_days > 0
          ? j.eta_days
          : PRICING_FALLBACK.delivery_exceptions.eta_days,
    };
  } catch {
    return { towns: [], eta_days: PRICING_FALLBACK.delivery_exceptions.eta_days };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPricing(timeoutMs = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('/api/pricing', { signal: ctrl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (isValidPricing(j)) {
      return {
        store: j.store,
        versions: j.versions,
        // Optional: an older server (or one whose settings read failed) omits it.
        delivery_fee: Number.isInteger(j.delivery_fee) ? j.delivery_fee : 0,
        sale: saleOf(j),
        delivery_exceptions: exceptionsOf(j),
        ok: true,
      };
    }
    throw new Error('bad shape');
  } catch {
    return {
      store: { ...PRICING_FALLBACK.store },
      versions: JSON.parse(JSON.stringify(PRICING_FALLBACK.versions)),
      delivery_fee: PRICING_FALLBACK.delivery_fee,
      sale: { ...PRICING_FALLBACK.sale },
      delivery_exceptions: { count: 0, eta_days: PRICING_FALLBACK.delivery_exceptions.eta_days },
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

// The last resolved sale, kept so a page that REPAINTS its cards after the fetch
// can re-stamp the new nodes. The store grid rebuilds when custom designs land
// and when the image map resolves; the home rail rebuilds and clones cards for
// its endless loop. Those fresh flags carry the markup's default text, so
// without a re-stamp the owner's own label silently reverts on repaint.
let resolved = null;

// Paint the resolved sale state onto the page. ONE call per page, right where
// the prices are stamped, and every sale-dependent element follows — because the
// switch travels as an ATTRIBUTE on <html> and css/tokens.css does the hiding:
//
//   no [data-sale] yet  — the struck price is INVISIBLE (space reserved), flags
//                         and the strip are absent. This is the pre-fetch state
//                         every page ships in, so a shopper never sees a
//                         struck-through price flash up and then be taken away
//                         (or worse, one that the server says has ended).
//   [data-sale="on"]    — struck price, picture flags and the strip all show.
//   [data-sale="off"]   — the struck price is REMOVED from the layout entirely,
//                         so the row closes up around the single live price.
//
// Text goes in via textContent, never innerHTML: these strings are owner input
// travelling through a public endpoint, and a label is not a place for markup.
export function applySale(sale, doc = document) {
  resolved = sale && sale.on ? sale : null;
  paintSale(sale, doc);
}

// Re-stamp AFTER a repaint. Deliberately a no-op until a sale has resolved: it
// must never be able to stamp data-sale early and expose the pre-resolve state
// as a decision.
export function restampSale(doc = document) {
  if (resolved) paintSale(resolved, doc);
}

function paintSale(sale, doc) {
  const on = !!(sale && sale.on);
  doc.documentElement.setAttribute('data-sale', on ? 'on' : 'off');
  if (!on) return;
  for (const el of doc.querySelectorAll('[data-sale-label]')) {
    el.textContent = sale.label || PRICING_FALLBACK.sale.label;
  }
  // An empty banner is the owner keeping the sale but dropping the strip, so the
  // element stays hidden rather than rendering an empty bar.
  for (const el of doc.querySelectorAll('[data-sale-banner]')) {
    const text = sale.banner || '';
    el.textContent = text;
    el.hidden = !text;
  }
}
