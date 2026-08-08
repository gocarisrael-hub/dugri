// Shared client helper: fetch the owner-editable home-page FAQ from the PUBLIC
// /api/faq endpoint and render it into the page's .faq container.
//
// FAIL-SOFT, exactly like js/pricing.js: index.html SHIPS the four launch
// questions as real markup, so a visitor with no JS, a slow network, or a broken
// API still reads a complete FAQ. This module only ever REPLACES that markup —
// and only once it holds a well-formed, non-empty list. Anything else (timeout,
// non-2xx, bad shape) leaves the shipped defaults exactly where they are.
//
// The one case that DOES clear the section is an explicitly EMPTY list: the owner
// deleting every question means "don't show this section", so the whole <section>
// is hidden rather than silently reverting to defaults she just removed.
//
// Everything an owner typed is inserted as TEXT, never as markup: questions and
// answers go through textContent, and the optional link's href is re-checked here
// against the same https:// | /path allowlist the server enforces on write. The
// server is the security boundary; this is the second lock on the same door, for
// the case where the stored data predates a validator change.

// Is this a usable payload? An array of items each carrying a non-empty question
// and answer. An empty array IS valid (see above) — it means "hide the section".
export function isValidFaq(payload) {
  if (!payload || !Array.isArray(payload.items)) return false;
  return payload.items.every(
    (it) =>
      it &&
      typeof it.q === 'string' &&
      it.q.trim() !== '' &&
      typeof it.a === 'string' &&
      it.a.trim() !== ''
  );
}

// Mirror of server/faq.js isSafeUrl. Only an absolute https:// URL or a same-site
// /path is rendered as a link; '//host' is protocol-relative (off-site) and every
// other scheme — javascript:, data:, vbscript: — is dropped. A rejected URL means
// the answer renders without its link, never with a dangerous one.
export function isSafeUrl(url) {
  if (typeof url !== 'string' || !url || url !== url.trim()) return false;
  if (url.startsWith('//')) return false;
  if (url.startsWith('/')) return true;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

// Split an answer into paragraphs on blank lines. That is the ONLY formatting an
// answer has — there is no markup to parse, so there is nothing to get wrong.
export function paragraphsOf(text) {
  return String(text == null ? '' : text)
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Timeout-bounded, fail-safe read. Resolves to { items, ok }: ok:false with an
// empty list on a slow/failing/malformed response, so a caller can tell "the
// owner has no questions" (ok:true, items:[]) from "we couldn't ask" (ok:false).
export async function fetchFaq(timeoutMs = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('/api/faq', { signal: ctrl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (!isValidFaq(j)) throw new Error('bad shape');
    return { items: j.items, ok: true };
  } catch {
    return { items: [], ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// Build one <details> for a question. Built with createElement + textContent so
// an owner-authored '<img onerror=…>' is displayed as those characters and can
// never become an element.
function detailsFor(item, doc) {
  const details = doc.createElement('details');
  const summary = doc.createElement('summary');
  summary.textContent = item.q;
  details.appendChild(summary);

  for (const para of paragraphsOf(item.a)) {
    const p = doc.createElement('p');
    // A single newline inside a paragraph stays a space (the browser's normal
    // text handling) — only a BLANK line starts a new paragraph.
    p.textContent = para.replace(/\r?\n/g, ' ');
    details.appendChild(p);
  }

  if (item.link_text && isSafeUrl(item.link_url)) {
    const p = doc.createElement('p');
    const a = doc.createElement('a');
    a.setAttribute('href', item.link_url);
    a.textContent = item.link_text;
    p.appendChild(a);
    details.appendChild(p);
  }
  return details;
}

// Replace `container`'s children with the rendered questions. An EMPTY list hides
// the enclosing <section> (the owner cleared the FAQ). Returns the number of
// questions rendered.
export function renderFaq(container, items) {
  if (!container) return 0;
  const doc = container.ownerDocument || document;
  const section = container.closest ? container.closest('section') : null;
  if (!items.length) {
    container.replaceChildren();
    if (section) section.hidden = true;
    return 0;
  }
  const frag = doc.createDocumentFragment();
  for (const item of items) frag.appendChild(detailsFor(item, doc));
  container.replaceChildren(frag);
  if (section) section.hidden = false;
  return items.length;
}

// Page bootstrap: swap the shipped questions for the owner's list, or leave the
// page untouched. Safe to call when the container isn't on this page.
export async function initFaq(container, timeoutMs) {
  if (!container) return { ok: false, rendered: 0 };
  const { items, ok } = await fetchFaq(timeoutMs);
  // ok:false → we never heard back. The shipped markup is the best content we
  // have, so it stays. This is the whole point of keeping it in the HTML.
  if (!ok) return { ok: false, rendered: 0 };
  return { ok: true, rendered: renderFaq(container, items) };
}
