// Shared GA4 funnel-event helper.
// gtag is a global defined by the per-page <head> stub; it pushes to dataLayer
// even before GA itself loads, so events queue safely until consent loads GA.

// First-party ad attribution rides along here rather than in another <script>
// tag per page: this module is already loaded on exactly the buyer-facing pages
// (the list analytics-coverage.test.js guards), so importing it means the
// campaign that produced a visit is recorded on every one of them, and on no
// admin screen.
import { sendEvent } from './attribution.js';
// The friend coupon's landing note (Agent A): a visit from the coupon email
// (?coupon=CODE) remembers the code for checkout and says it is active. Imported
// here for the same reason as attribution — this module is on exactly the
// buyer-facing pages, so one line covers all of them.
import './friend-coupon.js';
// An occasion page's questions report their opens like the home FAQ's do. faq.js
// imports track() from here: the cycle is safe because neither module calls into
// the other while it is still being evaluated except through function
// declarations, which exist from the start.
import { trackFaqOpens } from './faq.js';

// The seam for pay-success.html, which owns the purchase moment and runs as a
// CLASSIC script (it cannot import). The wizard is a module and imports
// sendEvent directly. Deliberately narrow: a page can send an event, it cannot
// read or rewrite the visitor's stored campaign.
if (typeof window !== 'undefined') window.dugriTrack = sendEvent;

// THE OCCASION PAGES (/yom-huledet, ...: site/occasion.html, filled by
// server/occasions.js) carry their slug and audience in #occasion-data. On such a
// page every event is sent with `occasion: <slug>`, so GA can split anything by
// the page it happened on, and a few events gain a companion the owner's reports
// key on (the spec's "Analytics and Google connections"):
//   • occasion_view {occasion, audience}  once, when the page loads;
//   • occasion_cta_click {occasion, cta}  with every order button
//     (order_started / nav_order: cta is the button's place, hero / steps /
//     designs / faq / design_view, the header or the menu). A company page's lead
//     buttons say data-ga="occasion_cta_click" data-ga-cta="…" themselves;
//   • faq_open gains `occasion` (the page's own questions are wired below);
//   • on a page whose audience is "business" (the company pages): the business
//     lead form's success (business_lead, js/home-new.js) also sends
//     business_lead_submit {occasion}, and every whatsapp_click is
//     cta: business, its own place kept as `where`.
// All of it is driven by the data file's audience, never by the URL.

// {occasion, audience} on an occasion page, null anywhere else.
export function occasionContext(doc = typeof document !== 'undefined' ? document : null) {
  try {
    const el = doc && doc.getElementById('occasion-data');
    if (!el) return null;
    const o = JSON.parse(el.textContent);
    if (!o || typeof o.slug !== 'string' || !o.slug) return null;
    return { occasion: o.slug, audience: o.audience === 'business' ? 'business' : 'private' };
  } catch {
    return null;
  }
}

const ORDER_EVENTS = new Set(['order_started', 'nav_order']);

// The [name, params] pairs one track() call sends. Pure: with no context it is
// the call itself, unchanged.
export function occasionEvents(name, params = {}, ctx = null) {
  if (!ctx) return [[name, params]];
  const { occasion } = ctx;
  const business = ctx.audience === 'business';
  let own = { ...params, occasion };
  if (business && name === 'whatsapp_click') {
    own = { ...own, cta: 'business' };
    if (params.cta && params.cta !== 'business' && !params.where) own.where = params.cta;
  }
  const out = [[name, own]];
  if (ORDER_EVENTS.has(name)) {
    out.push(['occasion_cta_click', { occasion, cta: params.cta || params.where || 'header' }]);
  }
  if (business && name === 'business_lead') out.push(['business_lead_submit', { occasion }]);
  return out;
}

// Fire a GA4 event. No-op (safe) if gtag isn't defined yet.
export function track(name, params = {}) {
  if (typeof gtag === 'function') {
    for (const [n, p] of occasionEvents(name, params, occasionContext())) gtag('event', n, p);
  }
}

// An occasion page's own start: the view, and its FAQ's opens (faq_open through
// track(), which adds the occasion).
export function initOccasionPage(doc = typeof document !== 'undefined' ? document : null) {
  const ctx = occasionContext(doc);
  if (!ctx) return null;
  track('occasion_view', { audience: ctx.audience });
  const qa = doc.querySelector('#faq .qa');
  if (qa) trackFaqOpens(qa, track);
  return ctx;
}

// Pure helper: turn an element's dataset into a params object from data-ga-*
// keys. `data-ga` itself is the event name and is skipped. The first char
// after "ga" is lowercased: gaCta -> cta, gaChannel -> channel.
export function paramsFromDataset(dataset) {
  const params = {};
  for (const key of Object.keys(dataset)) {
    if (key === 'ga' || !key.startsWith('ga')) continue;
    const rest = key.slice(2);
    if (!rest) continue;
    const param = rest.charAt(0).toLowerCase() + rest.slice(1);
    params[param] = dataset[key];
  }
  return params;
}

// One delegated click listener instruments every [data-ga] element (plain
// <a> CTAs) without per-element handlers.
if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const el = event.target.closest && event.target.closest('[data-ga]');
    if (el) {
      track(el.dataset.ga, paramsFromDataset(el.dataset));
    }
  });
}

if (typeof document !== 'undefined') initOccasionPage(document);
