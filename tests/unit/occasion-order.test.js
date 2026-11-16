// @vitest-environment node
//
// The wizard's side of an order from an occasion page (site/js/occasion-order.js):
// options.html?occasion=<slug> → the slug, the page's label (from GET
// /api/occasions, i.e. the occasion data files), and the event-type pre-fill.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  occasionSlug,
  labelFor,
  prefillEventType,
  fetchOccasions,
} from '../../site/js/occasion-order.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const occasions = require(path.join(__dirname, '..', '..', 'server', 'occasions.js'));
// exactly what GET /api/occasions answers (tests/unit/occasion-report.test.js pins that)
const LIST = occasions.live().map((o) => ({ slug: o.slug, label: o.label, audience: o.audience }));

describe('occasionSlug', () => {
  it('reads ?occasion= and refuses anything not slug-shaped', () => {
    expect(occasionSlug('?occasion=yom-huledet&plan=base')).toBe('yom-huledet');
    expect(occasionSlug('?plan=base&occasion=Yom-Huledet')).toBe('yom-huledet');
    expect(occasionSlug('?plan=base')).toBe('');
    expect(occasionSlug('?occasion=../admin')).toBe('');
    expect(occasionSlug('?occasion=%3Cscript%3E')).toBe('');
    expect(occasionSlug('?occasion=' + 'a'.repeat(81))).toBe('');
    expect(occasionSlug(undefined)).toBe('');
  });
});

describe('slug → label: the occasion data files, not a second table', () => {
  it('maps every live page to its own data file’s label', () => {
    expect(LIST.length).toBeGreaterThan(0);
    for (const o of occasions.live()) expect(labelFor(o.slug, LIST)).toBe(o.label);
  });
  it('the two live pages read as their labels', () => {
    expect(labelFor('yom-huledet', LIST)).toBe('יום הולדת לאמא');
    expect(labelFor('yom-huledet-aba', LIST)).toBe('יום הולדת לאבא');
  });
  it('an unknown slug, or no list, has no label', () => {
    expect(labelFor('no-such-page', LIST)).toBe('');
    expect(labelFor('yom-huledet', null)).toBe('');
    expect(labelFor('', LIST)).toBe('');
  });
  it('site/js/occasion-order.js holds no label of its own', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'site', 'js', 'occasion-order.js'),
      'utf8'
    );
    for (const o of occasions.all().values()) expect(src).not.toContain(o.label);
  });
});

describe('prefillEventType', () => {
  const mom = 'יום הולדת לאמא';
  it('fills an empty box with the page’s label', () => {
    expect(prefillEventType('', mom, LIST)).toBe(mom);
    expect(prefillEventType('   ', mom, LIST)).toBe(mom);
  });
  it('never replaces what she typed', () => {
    expect(prefillEventType('בת מצווה של אחותי', mom, LIST)).toBe('בת מצווה של אחותי');
  });
  it('replaces another page’s label left from an earlier visit', () => {
    expect(prefillEventType('יום הולדת לאבא', mom, LIST)).toBe(mom);
  });
  it('with no label, changes nothing', () => {
    expect(prefillEventType('', '', LIST)).toBe('');
    expect(prefillEventType('פרישה', '', LIST)).toBe('פרישה');
  });
});

describe('fetchOccasions', () => {
  it('returns the list, and [] on any failure', async () => {
    const ok = vi.fn(async () => ({ ok: true, json: async () => ({ occasions: LIST }) }));
    expect(await fetchOccasions({ fetchImpl: ok })).toEqual(LIST);
    expect(ok.mock.calls[0][0]).toBe('/api/occasions');
    expect(await fetchOccasions({ fetchImpl: async () => ({ ok: false }) })).toEqual([]);
    expect(
      await fetchOccasions({
        fetchImpl: async () => {
          throw new Error('offline');
        },
      })
    ).toEqual([]);
    expect(
      await fetchOccasions({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })
    ).toEqual([]);
    expect(await fetchOccasions({ fetchImpl: null })).toEqual([]);
  });
});
