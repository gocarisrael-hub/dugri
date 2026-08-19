// Shared client helper: fetch the owner-managed "new game" block from the PUBLIC
// /api/promo endpoint and insert it into the home page, next to the designs rail.
//
// Unlike the FAQ (js/faq.js), this section has NO shipped markup to fall back to:
// it does not exist until the owner writes one and switches it on, so an absent,
// slow or malformed response simply means "no section", and the page reads
// exactly as it did before this feature landed. That is also why the block is
// built here rather than shipped hidden in index.html — a hidden-but-present
// section would put an unlaunched game's name in the page source.
//
// Everything the owner typed is inserted as TEXT (textContent), never as markup,
// and both button hrefs are re-checked against the same https:// | /path
// allow-list the server enforces on write. The server is the security boundary;
// this is the second lock on the same door, for stored data that predates a
// validator change.

import { isSafeUrl } from './faq.js';

// Only OUR OWN uploads may be rendered as photos — the same rule server/promo.js
// enforces on write. A third-party URL here would leak every home-page visitor to
// another host, so a photo that doesn't match is dropped, not shown.
const UPLOAD_PATH_RE = /^\/content-uploads\/[a-f0-9]{16}\.(webp|jpe?g|png)$/;

// A usable payload: `promo` is either null (the section is off — the normal
// state) or an object carrying a non-empty title. A title-less block would render
// as a coloured stripe with a button in it, which is worse than no section.
export function isValidPromo(payload) {
  if (!payload || !('promo' in payload)) return false;
  const p = payload.promo;
  if (p === null) return true;
  return !!p && typeof p.title === 'string' && p.title.trim() !== '';
}

// Split a sub-title into paragraphs on blank lines, exactly like a FAQ answer.
const paragraphs = (text) =>
  String(text || '')
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

// Build the section element. Pure DOM construction from a validated payload —
// no fetching, no insertion — so a unit test can assert what the visitor gets
// without a network or a page.
export function buildPromo(promo, doc = document) {
  const sec = doc.createElement('section');
  sec.id = 'newgame';
  sec.dataset.testid = 'home-promo';
  // The ground. Both neighbours are white, so the sand wash is what separates
  // this block from them; the `section + section` hairline in index.html does the
  // rest on its own, because this is a real <section> in the page's flow.
  if (promo.background !== 'white') sec.className = 'alt';
  // Deliberately NO data-reveal: the scroll-reveal observer in index.html runs
  // over the sections present at load, and this one arrives after a fetch — it
  // would be registered too late and stay at opacity 0 forever.

  const wrap = doc.createElement('div');
  wrap.className = 'wrap';
  sec.appendChild(wrap);

  const head = doc.createElement('div');
  head.className = 'sec-title promo-head';
  wrap.appendChild(head);

  const badge = String(promo.badge || '').trim();
  if (badge) {
    const b = doc.createElement('span');
    b.className = 'promo-badge';
    b.textContent = badge;
    head.appendChild(b);
  }

  const h2 = doc.createElement('h2');
  h2.textContent = promo.title;
  head.appendChild(h2);

  for (const para of paragraphs(promo.sub)) {
    const p = doc.createElement('p');
    p.textContent = para;
    head.appendChild(p);
  }

  const photos = (Array.isArray(promo.photos) ? promo.photos : []).filter(
    (p) => p && typeof p.src === 'string' && UPLOAD_PATH_RE.test(p.src)
  );
  if (photos.length) {
    const grid = doc.createElement('div');
    grid.className = 'promo-photos';
    // The column count follows the number of photos, so two photos are a 2-up and
    // one is a single wide picture. A fixed 3-column grid would leave a hole where
    // the owner simply had nothing more to show.
    grid.dataset.count = String(photos.length);
    for (const ph of photos) {
      const img = doc.createElement('img');
      img.src = ph.src;
      // Empty alt is legitimate: these are decorative product shots, and an
      // invented description is worse for a screen reader than none.
      img.alt = String(ph.alt || '');
      // setAttribute, not the IDL properties: `loading`/`decoding` are reflected
      // by browsers but not by jsdom, and the unit test asserts the markup a
      // visitor actually receives.
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
      grid.appendChild(img);
    }
    wrap.appendChild(grid);
  }

  const ctas = doc.createElement('div');
  ctas.className = 'promo-cta';
  const buttons = [
    { text: promo.cta_text, url: promo.cta_url, ghost: false },
    promo.cta2 ? { text: promo.cta2.text, url: promo.cta2.url, ghost: true } : null,
  ].filter(Boolean);
  for (const btn of buttons) {
    const text = String(btn.text || '').trim();
    if (!text || !isSafeUrl(btn.url)) continue;
    const a = doc.createElement('a');
    a.className = btn.ghost ? 'btn ghost' : 'btn';
    a.href = btn.url;
    a.textContent = text;
    // Same event the hero and rail CTAs fire; analytics.js listens by delegation,
    // so a button built after load is instrumented like any other.
    a.dataset.ga = 'order_started';
    a.dataset.gaCta = 'home-promo';
    ctas.appendChild(a);
  }
  if (ctas.children.length) wrap.appendChild(ctas);

  return sec;
}

// Fetch and insert. Resolves to the inserted element, or null when there is
// nothing to show — a switched-off section, a timeout, a non-2xx, a bad shape, or
// a page with no designs rail to anchor to. Never throws: a home page must not
// depend on this section loading.
export async function initPromo({ timeoutMs = 2500, anchor = '#products' } = {}) {
  const rail = document.querySelector(anchor);
  if (!rail) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('/api/promo', { signal: ctrl.signal });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    if (!isValidPromo(j) || !j.promo) return null;
    const sec = buildPromo(j.promo);
    // 'before' is the default and the owner's usual choice: the block lands
    // between אודות and the designs rail, where it is the first product-shaped
    // thing a scroller meets. 'after' puts it below the rail, for when the new
    // game is a footnote to the catalogue rather than the headline.
    if (j.promo.position === 'after') rail.after(sec);
    else rail.before(sec);
    return sec;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
