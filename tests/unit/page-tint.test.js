import { describe, it, expect } from 'vitest';
import { pageTint } from '../../site/js/configurator.js';

const FALLBACK = '#e5197d';

describe('pageTint — page theme colour resolution', () => {
  it('prefers an explicitly chosen slider colour over everything', () => {
    expect(pageTint('#2d7ff9', '#ff78a0', ['#111111', '#ff0000'], FALLBACK)).toBe('#2d7ff9');
  });

  it('falls back to the design accent when no slider colour is chosen', () => {
    expect(pageTint(null, '#ff78a0', ['#111111'], FALLBACK)).toBe('#ff78a0');
  });

  it('uses the most-saturated anchor when there is no accent', () => {
    // grey then vivid red → the red anchor is the most saturated
    expect(pageTint(null, null, ['#808080', '#ff0000'], FALLBACK)).toBe('#ff0000');
  });

  it('GUARD: an accent-less, anchor-less (fixed) design falls back to the brand tint', () => {
    // this is the latent-stale-tint case: without the fallback, activeMain would
    // be null and the page would keep the PREVIOUS design's tint.
    expect(pageTint(null, null, [], FALLBACK)).toBe(FALLBACK);
    expect(pageTint(null, undefined, undefined, FALLBACK)).toBe(FALLBACK);
    expect(pageTint('', '', [], FALLBACK)).toBe(FALLBACK);
  });

  it('never returns a falsy value when a fallback is provided', () => {
    for (const args of [
      [null, null, [], FALLBACK],
      ['#123456', null, [], FALLBACK],
      [null, '#abcdef', [], FALLBACK],
    ]) {
      expect(pageTint(...args)).toBeTruthy();
    }
  });
});
