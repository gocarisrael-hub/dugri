// event-selector.js — homepage "event selector".
// Clicking an event pill swaps the product mockup / accent / swatches / CTA
// IN PLACE (no navigation). Dugri sells ONE product per event; only events that
// have real artwork are listed here. Defensive: initEventSelector is a no-op on
// pages that don't contain the #events section, so it's safe to import anywhere.

import { PUBLIC_DESIGNS } from './designs.js';
import { pageTint } from './configurator.js';

/** Brand sage — the guaranteed accent fallback so we never keep a stale tint. */
export const DEFAULT_TINT = '#8ca287';

/**
 * Event pill id -> design id. Only events backed by real artwork appear here
 * (all six ids below exist in PUBLIC_DESIGNS; `japanese` exists too but is not
 * surfaced as a homepage event).
 */
export const EVENTS = [
  { id: 'birthday', design: 'birthday' },
  { id: 'bachelorette', design: 'bachelorette' },
  { id: 'marriage', design: 'marriage' },
  { id: 'posttrip', design: 'posttrip' },
  { id: 'neon', design: 'neon' },
  { id: 'kids', design: 'kids' },
];

/** Look up a design object by id, or undefined if unknown. */
export function designFor(designId) {
  return PUBLIC_DESIGNS.find((d) => d.id === designId);
}

/** Resolve an event design's accent colour (accent → main anchor → brand tint). */
export function accentFor(d) {
  return pageTint(null, d && d.accent, d && d.anchors, DEFAULT_TINT);
}

/**
 * Wire the homepage event selector inside `root`. No-op when the section is
 * absent, so it's safe to call on every page. Returns nothing.
 */
export function initEventSelector(root = document) {
  const pills = Array.from(root.querySelectorAll('.event-pill[data-design-id]'));
  if (pills.length === 0) return;

  // The section whose --event-accent we theme. Prefer the well-known id, else
  // the closest section ancestor of the first pill.
  const section =
    (root.getElementById && root.getElementById('events')) ||
    document.getElementById('events') ||
    pills[0].closest('section');

  const mockup = document.getElementById('eventMockup');
  const dots = document.getElementById('eventDots');
  const copy = document.getElementById('eventCopy');
  const cta = document.getElementById('eventCta');

  function select(pill) {
    if (!pill) return;

    // (a) active state — only the chosen pill is active/selected.
    pills.forEach((p) => {
      const on = p === pill;
      p.classList.toggle('is-active', on);
      p.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    // (b) resolve the design; bail if it's missing.
    const design = designFor(pill.dataset.designId);
    if (!design) return;

    // (c) product mockup image.
    if (mockup) mockup.src = (design.thumbs && design.thumbs.front) || design.thumb;

    // (d) accent as a CSS custom property on the section.
    const accent = accentFor(design);
    if (section) section.style.setProperty('--event-accent', accent);

    // (e) swatch dots — up to 4 colours from anchors (or the accent).
    if (dots) {
      dots.textContent = '';
      const colors = design.anchors && design.anchors.length ? design.anchors : [design.accent];
      colors.slice(0, 4).forEach((hex) => {
        const dot = document.createElement('span');
        dot.className = 'event-dot';
        dot.style.background = hex;
        dots.appendChild(dot);
      });
    }

    // (f) copy = design name.
    if (copy) copy.textContent = design.name;

    // (g) CTA deep-links to the configurator for this design.
    if (cta) cta.href = 'options.html?design=' + design.id;
  }

  pills.forEach((pill) => pill.addEventListener('click', () => select(pill)));

  // Initial selection: the pre-marked active pill, else the first.
  const initial =
    pills.find(
      (p) => p.classList.contains('is-active') || p.getAttribute('aria-selected') === 'true'
    ) || pills[0];
  select(initial);
}
