// The friend coupon's landing half (Agent A): a visitor who arrives from the
// coupon email (/?coupon=NOA5-K7Q2&utm_…) has the code remembered for the rest of
// this visit, sees a small "your coupon is active" note, and finds it already
// filled in at checkout (collect.html reads carriedCoupon()).
//
// Loaded on every buyer-facing page through js/analytics.js, which those pages
// all load already — one import there rather than a <script> tag per page.
//
// Storage is sessionStorage, wrapped: some in-app browsers (Instagram's among
// them) throw on any storage access. When it is blocked the code lives in this
// module's memory for the page, and the buyer can still type it at checkout.
//
// GA is called through the page's own gtag stub — consent-gated by consent.js
// exactly like every other event — and never with anything but the code TYPE:
// no email, and not the code itself (it is a personal one).

const KEY = 'dugri:coupon';
let memory = null;

// Mirrors server/friend-coupons.js CODE_RE: PREFIX (Latin letters) + PERCENT +
// '-' + 4 from the unambiguous alphabet. The percent printed in the code is what
// the banner shows: it is the record of what was promised when the code was
// issued, which today's setting may no longer be.
const FRIEND_CODE_RE = /^[A-Z]{1,8}(\d{1,3})-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

export function normalizeCode(s) {
  return String(s == null ? '' : s)
    .trim()
    .toUpperCase();
}

export function percentInCode(code) {
  const m = FRIEND_CODE_RE.exec(normalizeCode(code));
  return m ? Number(m[1]) : null;
}

// A code worth carrying: the owner's coupons are [A-Z0-9]{3,20}, friend codes
// add one dash. Anything else in the URL is ignored rather than stored.
function plausible(code) {
  return /^[A-Z0-9-]{3,24}$/.test(code);
}

export function carriedCoupon() {
  try {
    const v = sessionStorage.getItem(KEY);
    if (v) return v;
  } catch {
    /* storage blocked — fall back to memory */
  }
  return memory;
}

export function clearCarriedCoupon() {
  memory = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked */
  }
}

function remember(code) {
  memory = code;
  try {
    sessionStorage.setItem(KEY, code);
  } catch {
    /* storage blocked — memory only */
  }
}

// The note itself. Small, fixed to the top, closes itself after a few seconds
// and on a tap. Built here (styles inline) so no page has to carry markup for it.
function showBanner(percent) {
  if (typeof document === 'undefined' || !document.body) return;
  const bar = document.createElement('div');
  bar.id = 'couponLanding';
  bar.setAttribute('role', 'status');
  bar.setAttribute('data-testid', 'coupon-landing');
  bar.setAttribute(
    'style',
    [
      'position:fixed',
      'top:0',
      'inset-inline:0',
      'z-index:300',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'gap:12px',
      'padding:calc(10px + env(safe-area-inset-top, 0px)) 44px 10px',
      'background:#141414',
      'color:#fff',
      "font-family:'Heebo',Arial,sans-serif",
      'font-size:15px',
      'font-weight:400',
      'direction:rtl',
      'text-align:center',
    ].join(';')
  );
  const text = document.createElement('span');
  text.textContent =
    percent != null ? 'הקופון שלכם פעיל: ' + percent + '% הנחה' : 'הקופון שלכם פעיל';
  const x = document.createElement('button');
  x.type = 'button';
  x.setAttribute('aria-label', 'סגירה');
  x.textContent = '×';
  x.setAttribute(
    'style',
    'position:absolute;inset-inline-end:8px;top:50%;transform:translateY(-50%);' +
      'background:none;border:0;color:#fff;font-size:22px;line-height:1;padding:6px 10px;cursor:pointer'
  );
  bar.append(text, x);
  const close = () => bar.remove();
  x.addEventListener('click', close);
  setTimeout(close, 8000);
  document.body.appendChild(bar);
}

// Exported for the unit test; runs once on import in a browser.
export function landFromUrl(search) {
  const raw = new URLSearchParams(search || '').get('coupon');
  if (!raw) return null;
  const code = normalizeCode(raw);
  if (!plausible(code)) return null;
  remember(code);
  const percent = percentInCode(code);
  if (typeof gtag === 'function') {
    gtag('event', 'coupon_landing', { coupon_type: percent != null ? 'friend' : 'regular' });
  }
  const show = () => showBanner(percent);
  if (typeof document !== 'undefined') {
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show, { once: true });
  }
  return code;
}

if (typeof location !== 'undefined') landFromUrl(location.search);
