import { describe, it, expect, afterEach } from 'vitest';
import { paramsFromDataset, track } from '../../site/js/analytics.js';

describe('paramsFromDataset', () => {
  it('maps data-ga-* keys to params, lowercasing the first char, and skips ga itself', () => {
    expect(
      paramsFromDataset({ ga: 'order_started', gaCta: 'hero', gaChannel: 'whatsapp' })
    ).toEqual({ cta: 'hero', channel: 'whatsapp' });
  });
  it('ignores non-ga keys and a bare ga key', () => {
    expect(paramsFromDataset({ ga: 'x', testid: 'y', other: 'z' })).toEqual({});
  });
  it('returns an empty object for an empty dataset', () => {
    expect(paramsFromDataset({})).toEqual({});
  });
});

describe('track', () => {
  afterEach(() => {
    delete global.gtag;
    if (typeof window !== 'undefined') delete window.gtag;
  });

  it('is a safe no-op when gtag is undefined', () => {
    expect(() => track('order_started', { cta: 'hero' })).not.toThrow();
  });

  it('pushes ["event", name, params] to gtag when present', () => {
    const calls = [];
    const fake = (...args) => calls.push(args);
    global.gtag = fake;
    if (typeof window !== 'undefined') window.gtag = fake;
    track('order_started', { cta: 'hero' });
    expect(calls).toEqual([['event', 'order_started', { cta: 'hero' }]]);
  });

  it('defaults params to an empty object', () => {
    const calls = [];
    const fake = (...args) => calls.push(args);
    global.gtag = fake;
    if (typeof window !== 'undefined') window.gtag = fake;
    track('begin_checkout');
    expect(calls).toEqual([['event', 'begin_checkout', {}]]);
  });
});
