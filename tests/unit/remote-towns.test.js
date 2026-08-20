// @vitest-environment node
// The out-of-the-way localities: the owner types a list, the checkout prints it
// under a collapsed note in both places a buyer asks for delivery.
//
// The rule these tests exist to hold is the FAIL-CLOSED one. Every failure —
// unset, corrupt, wrong type, blank — must produce an EMPTY town list, because
// an empty list hides the note and leaves the standard delivery estimate
// standing on its own. The opposite failure (a half-parsed list, or a day count
// we could not read) prints a longer delivery promise next to towns it was not
// meant for, which is a promise made to the wrong buyer.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let dir;
let settings;
let db;

function load() {
  for (const f of ['settings.js', 'db.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  db = require(path.join(serverDir, 'db.js'));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-towns-'));
  process.env.DATA_DIR = dir;
  load();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe('the shipped default', () => {
  it('is an empty list, so a deploy shows no note at all', () => {
    expect(settings.get('pricing', 'remote_towns')).toBe('');
    expect(db.deliveryExceptions().towns).toEqual([]);
  });

  it('still carries a day count, so the only thing missing is the list', () => {
    expect(db.deliveryExceptions().eta_days).toBe(11);
  });
});

describe('parsing the owner list', () => {
  const set = (v) => settings.set('pricing', 'remote_towns', v);

  it('splits one locality per line and trims each', () => {
    set('  אילת \n מצפה רמון\nראש פינה  ');
    expect(db.deliveryExceptions().towns).toEqual(['אילת', 'מצפה רמון', 'ראש פינה']);
  });

  it('drops blank lines rather than printing empty entries', () => {
    set('אילת\n\n\nמצפה רמון\n   \n');
    expect(db.deliveryExceptions().towns).toEqual(['אילת', 'מצפה רמון']);
  });

  it('de-duplicates, keeping the order she typed', () => {
    set('אילת\nמצפה רמון\nאילת');
    expect(db.deliveryExceptions().towns).toEqual(['אילת', 'מצפה רמון']);
  });

  it('a list of nothing but blanks reads as no list', () => {
    set('\n  \n\n');
    expect(db.deliveryExceptions().towns).toEqual([]);
  });

  it('does NOT split on a comma — a locality may legitimately contain one', () => {
    set('כפר סבא, מזרח');
    expect(db.deliveryExceptions().towns).toEqual(['כפר סבא, מזרח']);
  });
});

describe('the day count', () => {
  it('follows the owner setting', () => {
    settings.set('pricing', 'remote_eta_days', 14);
    expect(db.deliveryExceptions().eta_days).toBe(14);
  });

  it('refuses 0 — an exception of no extra days is not an exception', () => {
    expect(() => settings.set('pricing', 'remote_eta_days', 0)).toThrow(/positive|between/);
  });

  it('refuses an absurd count, so a slipped keypad cannot promise a year', () => {
    expect(() => settings.set('pricing', 'remote_eta_days', 900)).toThrow(/between/);
  });
});

describe('what may be stored at all', () => {
  it('refuses a non-string list (an array would reach the browser unparsed)', () => {
    expect(() => settings.set('pricing', 'remote_towns', ['אילת'])).toThrow(/string/);
  });

  it('refuses control characters', () => {
    expect(() => settings.set('pricing', 'remote_towns', 'אילת\u0007')).toThrow(/control/);
  });

  it('accepts the newlines that carry the list itself', () => {
    expect(() => settings.set('pricing', 'remote_towns', 'א\nב\r\nג')).not.toThrow();
  });

  // The cap is a runaway-paste guard, NOT a policy. The first pair of numbers
  // (400 lines) was a guess made before anyone had pasted a real list, and the
  // owner hit it on her first save — a courier's own exceptions list runs to
  // thousands of localities. A real-sized list has to go in.
  it('accepts a real-sized courier list', () => {
    const real = Array.from({ length: 2500 }, (_, i) => 'יישוב ' + i).join('\n');
    expect(() => settings.set('pricing', 'remote_towns', real)).not.toThrow();
    expect(db.deliveryExceptions().towns).toHaveLength(2500);
  });

  it('still refuses a list long enough to be a runaway paste', () => {
    expect(() => settings.set('pricing', 'remote_towns', 'x\n'.repeat(6000))).toThrow(/lines/);
    expect(() => settings.set('pricing', 'remote_towns', 'x'.repeat(200001))).toThrow(/characters/);
  });
});

describe('what /api/pricing carries', () => {
  // The HEADLINE only. Every storefront page fetches pricing for its numbers,
  // and none of them prints a single town — so a 2,500-name list must not ride
  // along on the home page, the shop and every product page. The names have
  // their own endpoint, fetched by the checkout alone.
  it('carries how many and how long, never the names', () => {
    settings.set('pricing', 'remote_towns', 'אילת\nמצפה רמון');
    settings.set('pricing', 'remote_eta_days', 11);
    const p = db.effectivePricing();
    expect(p.delivery_exceptions).toEqual({ count: 2, eta_days: 11 });
    expect(JSON.stringify(p)).not.toContain('אילת');
    // and the prices are untouched by any of it
    expect(p.store.now).toBe(199);
  });

  it('stays a fixed size however long the list gets', () => {
    const big = Array.from({ length: 2000 }, (_, i) => 'יישוב ' + i).join('\n');
    settings.set('pricing', 'remote_towns', big);
    const bytes = JSON.stringify(db.effectivePricing()).length;
    settings.set('pricing', 'remote_towns', 'אילת');
    const small = JSON.stringify(db.effectivePricing()).length;
    // Only the count's own digits differ — a 2,000-town list costs the
    // storefront three characters, not fifty kilobytes.
    expect(bytes - small).toBeLessThan(10);
  });

  it('the towns themselves are still there for the checkout to fetch', () => {
    settings.set('pricing', 'remote_towns', 'אילת\nמצפה רמון');
    expect(db.deliveryExceptions()).toEqual({ towns: ['אילת', 'מצפה רמון'], eta_days: 11 });
  });
});
