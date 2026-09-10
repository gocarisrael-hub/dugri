// Shared GA4 funnel-event helper.
// gtag is a global defined by the per-page <head> stub; it pushes to dataLayer
// even before GA itself loads, so events queue safely until consent loads GA.

// First-party ad attribution rides along here rather than in another <script>
// tag per page: this module is already loaded on exactly the buyer-facing pages
// (the list analytics-coverage.test.js guards), so importing it means the
// campaign that produced a visit is recorded on every one of them, and on no
// admin screen.
import { sendEvent } from './attribution.js';

// The seam for pay-success.html, which owns the purchase moment and runs as a
// CLASSIC script (it cannot import). The wizard is a module and imports
// sendEvent directly. Deliberately narrow: a page can send an event, it cannot
// read or rewrite the visitor's stored campaign.
if (typeof window !== 'undefined') window.dugriTrack = sendEvent;

// Fire a GA4 event. No-op (safe) if gtag isn't defined yet.
export function track(name, params = {}) {
  if (typeof gtag === 'function') {
    gtag('event', name, params);
  }
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
