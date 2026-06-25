// Shared GA4 funnel-event helper.
// gtag is a global defined by the per-page <head> stub; it pushes to dataLayer
// even before GA itself loads, so events queue safely until consent loads GA.

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
