import { describe, it, expect, beforeEach } from 'vitest';
import { PUBLIC_DESIGNS } from '../../site/js/designs.js';
import {
  EVENTS,
  DEFAULT_TINT,
  designFor,
  accentFor,
  initEventSelector,
} from '../../site/js/event-selector.js';

describe('event-selector — event → design mapping', () => {
  it('lists at least one event', () => {
    expect(EVENTS.length).toBeGreaterThan(0);
  });

  it('every event maps to a real design in PUBLIC_DESIGNS', () => {
    for (const ev of EVENTS) {
      const d = designFor(ev.design);
      expect(d, `event ${ev.id} → design ${ev.design}`).toBeTruthy();
      expect(d.id).toBe(ev.design);
      expect(PUBLIC_DESIGNS.some((x) => x.id === ev.design)).toBe(true);
    }
  });

  it('accentFor returns a truthy colour string for every event design', () => {
    for (const ev of EVENTS) {
      const accent = accentFor(designFor(ev.design));
      expect(typeof accent).toBe('string');
      expect(accent.length).toBeGreaterThan(0);
      expect(/^(#|rgb)/.test(accent)).toBe(true);
    }
  });

  it('accentFor falls back to the brand tint for an accent-less, anchor-less design', () => {
    expect(accentFor({})).toBe(DEFAULT_TINT);
    expect(accentFor(null)).toBe(DEFAULT_TINT);
  });
});

describe('event-selector — initEventSelector DOM wiring', () => {
  const firstDesign = designFor(EVENTS[0].design);
  const bacheloretteDesign = designFor('bachelorette');

  function buildDom() {
    const pills = EVENTS.map(
      (ev, i) =>
        `<button class="event-pill${i === 0 ? ' is-active' : ''}" role="tab" ` +
        `data-design-id="${ev.design}" aria-selected="${i === 0 ? 'true' : 'false'}">${ev.id}</button>`
    ).join('');
    document.body.innerHTML = `
      <section id="events">
        <div class="event-pills">${pills}</div>
        <div class="event-preview">
          <img id="eventMockup" src="placeholder.png" alt="" />
          <div id="eventDots"></div>
          <p id="eventCopy"></p>
          <a id="eventCta" href="options.html?design=birthday">להזמנה</a>
        </div>
      </section>`;
  }

  beforeEach(() => {
    buildDom();
  });

  it('is a no-op when the section is absent (no pills)', () => {
    document.body.innerHTML = '<main>no events here</main>';
    expect(() => initEventSelector()).not.toThrow();
  });

  it('selects the pre-marked active pill on init and renders its design', () => {
    initEventSelector();
    expect(document.getElementById('eventCopy').textContent).toBe(firstDesign.name);
    expect(document.getElementById('eventCta').getAttribute('href')).toBe(
      'options.html?design=' + firstDesign.id
    );
    // Section carries the accent custom property.
    const accent = document.getElementById('events').style.getPropertyValue('--event-accent');
    expect(accent).toBe(accentFor(firstDesign));
    // Swatch dots rendered (up to 4).
    const dots = document.querySelectorAll('#eventDots .event-dot');
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.length).toBeLessThanOrEqual(4);
  });

  it('clicking a pill swaps the CTA href, mockup src, copy and active state in place', () => {
    initEventSelector();
    const mockup = document.getElementById('eventMockup');
    const beforeSrc = mockup.getAttribute('src');

    const pill = document.querySelector('.event-pill[data-design-id="bachelorette"]');
    pill.click();

    expect(document.getElementById('eventCta').getAttribute('href')).toBe(
      'options.html?design=bachelorette'
    );
    expect(document.getElementById('eventCopy').textContent).toBe(bacheloretteDesign.name);
    // Mockup src changed to the design's front thumb (or thumb fallback).
    const expected =
      (bacheloretteDesign.thumbs && bacheloretteDesign.thumbs.front) || bacheloretteDesign.thumb;
    expect(mockup.getAttribute('src')).toBe(expected);
    if (expected !== beforeSrc) {
      expect(mockup.getAttribute('src')).not.toBe(beforeSrc);
    }

    // Only the clicked pill is active/selected.
    expect(pill.classList.contains('is-active')).toBe(true);
    expect(pill.getAttribute('aria-selected')).toBe('true');
    const others = Array.from(document.querySelectorAll('.event-pill')).filter((p) => p !== pill);
    for (const o of others) {
      expect(o.classList.contains('is-active')).toBe(false);
      expect(o.getAttribute('aria-selected')).toBe('false');
    }
  });
});
