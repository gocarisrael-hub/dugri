// The occasion page an order starts from (site/occasion.html → every order button
// opens options.html?occasion=<slug>). The wizard reads the slug here, pre-fills
// the order's event type with that page's label, and sends the slug with the
// order, so the admin can count each page's orders.
//
// The labels are the pages' own (GET /api/occasions, read from
// server/occasions/<slug>.json): there is no second table of names here to fall
// out of step with the pages.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The slug in a query string, '' when there is none or it is not slug-shaped.
export function occasionSlug(search) {
  let v = '';
  try {
    v = new URLSearchParams(String(search || '')).get('occasion') || '';
  } catch {
    return '';
  }
  v = v.trim().toLowerCase();
  return SLUG_RE.test(v) && v.length <= 80 ? v : '';
}

// The page's label for a slug, from the /api/occasions list; '' when unknown.
export function labelFor(slug, list) {
  if (!slug || !Array.isArray(list)) return '';
  const hit = list.find((o) => o && o.slug === slug);
  return hit && typeof hit.label === 'string' ? hit.label.trim() : '';
}

// What the event-type box should hold: what she typed stays; an empty box, or one
// still holding another page's label (a pre-fill from an earlier visit, restored
// from the saved selection), takes this page's label.
export function prefillEventType(current, label, list = []) {
  const now = String(current || '').trim();
  if (!label) return String(current || '');
  if (!now) return label;
  const labels = new Set((Array.isArray(list) ? list : []).map((o) => o && o.label));
  return labels.has(now) ? label : String(current);
}

// The live pages, [] on any failure (the wizard works the same without them).
export async function fetchOccasions({ fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  if (typeof fetchImpl !== 'function') return [];
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl('/api/occasions', ctl ? { signal: ctl.signal } : undefined);
    if (!r || !r.ok) return [];
    const j = await r.json();
    return Array.isArray(j && j.occasions) ? j.occasions : [];
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
