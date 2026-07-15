// @vitest-environment node
// The owner-editable settings store (server/settings.js). It reads DATA_DIR at
// require time, so each test points DATA_DIR at a fresh temp dir BEFORE loading a
// clean copy of the module (fresh-require pattern).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, '..', '..', 'server', 'settings.js');

let dataDir;

function loadFresh() {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-settings-'));
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

describe('get / set / reset', () => {
  it('returns the registry default when there is no override', () => {
    const s = loadFresh();
    expect(s.get('email', 'order_paid')).toEqual({
      subject: 'דוגרי · התקבל תשלום — {honoree}',
      body: 'התקבל תשלום עבור ההזמנה של {honoree}.',
    });
  });

  it('returns (and persists) the override once set', () => {
    const s = loadFresh();
    s.set('email', 'order_paid', {
      subject: 'שולם — {honoree}',
      body: 'קיבלנו תשלום מ-{honoree}.',
    });
    expect(s.get('email', 'order_paid')).toEqual({
      subject: 'שולם — {honoree}',
      body: 'קיבלנו תשלום מ-{honoree}.',
    });
    // Persisted to disk: a freshly loaded copy sees the same override.
    expect(fs.existsSync(path.join(dataDir, 'settings.json'))).toBe(true);
    const reloaded = loadFresh();
    expect(reloaded.get('email', 'order_paid').subject).toBe('שולם — {honoree}');
  });

  it('deep-merges a nested partial override (keeps the default’s other fields)', () => {
    const s = loadFresh();
    // Toggle a trigger off WITHOUT resending its text/timing.
    s.set('wa', 'trigger.daily_morning', { enabled: false });
    const eff = s.get('wa', 'trigger.daily_morning');
    expect(eff.enabled).toBe(false);
    // text + timing survive from the default.
    expect(eff.text).toBe('בוקר טוב! יש עוד זמן להוסיף מילים על {honoree}: {link}');
    expect(eff.timing).toEqual({ hour: 7 });
  });

  it('deep-merges nested timing fields but replaces arrays wholesale', () => {
    const s = loadFresh();
    s.set('wa', 'trigger.quiet_reminder', { timing: { max: 5, window: [8, 22] } });
    const eff = s.get('wa', 'trigger.quiet_reminder');
    // idle_hours kept from default, max overridden, window replaced (not merged).
    expect(eff.timing).toEqual({ idle_hours: 24, max: 5, window: [8, 22] });
  });

  it('reset restores the default and drops the override', () => {
    const s = loadFresh();
    s.set('email', 'footer', { line1: 'x', line2: 'y' });
    expect(s.get('email', 'footer')).toEqual({ line1: 'x', line2: 'y' });
    const restored = s.reset('email', 'footer');
    expect(restored).toEqual({ line1: 'נתראה על הלוח,', line2: 'צוות דוגרי' });
    expect(s.all().overrides).toEqual({});
  });

  it('rejects an unknown section/key on get, set and reset; hasKey is false', () => {
    const s = loadFresh();
    expect(s.hasKey('email', 'nope')).toBe(false);
    expect(s.hasKey('bogus', 'order_paid')).toBe(false);
    // Prototype-pollution keys are never treated as valid keys.
    expect(s.hasKey('email', '__proto__')).toBe(false);
    expect(() => s.get('email', 'nope')).toThrow();
    expect(() => s.set('email', 'nope', { x: 1 })).toThrow();
    expect(() => s.reset('bogus', 'order_paid')).toThrow();
  });
});

describe('value-shape validation (set + validateValue)', () => {
  it('rejects a null/string/array/number override for an object-typed key and leaves the store unchanged', () => {
    const s = loadFresh();
    for (const bad of [null, 'oops', ['a'], 42]) {
      expect(s.validateValue('email', 'order_paid', bad)).toBeTruthy();
      expect(() => s.set('email', 'order_paid', bad)).toThrow();
    }
    // No override was written, and the default is intact.
    expect(s.all().overrides).toEqual({});
    expect(s.get('email', 'order_paid').subject).toBe('דוגרי · התקבל תשלום — {honoree}');
    // Nothing persisted to disk either.
    expect(fs.existsSync(path.join(dataDir, 'settings.json'))).toBe(false);
  });

  it('rejects a template object missing a string subject/body', () => {
    const s = loadFresh();
    expect(s.validateValue('email', 'order_paid', { subject: 'x' })).toBeTruthy(); // no body
    expect(s.validateValue('email', 'order_paid', { subject: 1, body: 'y' })).toBeTruthy();
    expect(() => s.set('email', 'order_paid', { body: 'only body' })).toThrow();
    expect(s.all().overrides).toEqual({});
  });

  it('rejects a trigger with a wrong-typed field but accepts a valid partial', () => {
    const s = loadFresh();
    expect(s.validateValue('wa', 'trigger.daily_morning', { enabled: 'yes' })).toBeTruthy();
    expect(s.validateValue('wa', 'trigger.daily_morning', { timing: 'soon' })).toBeTruthy();
    expect(s.validateValue('wa', 'trigger.daily_morning', { enabled: false })).toBeNull();
  });

  it('accepts a valid override', () => {
    const s = loadFresh();
    expect(s.validateValue('email', 'order_paid', { subject: 'a', body: 'b' })).toBeNull();
    const eff = s.set('email', 'order_paid', { subject: 'a', body: 'b' });
    expect(eff).toEqual({ subject: 'a', body: 'b' });
  });

  it('range-validates a daily_* trigger hour (0..23 integer)', () => {
    const s = loadFresh();
    const k = 'trigger.daily_morning';
    // out of range / non-integer / wrong-typed hours are rejected
    for (const bad of [25, -1, 24, 7.5, NaN, '7', null]) {
      expect(s.validateValue('wa', k, { timing: { hour: bad } })).toBeTruthy();
      expect(() => s.set('wa', k, { enabled: true, text: 't', timing: { hour: bad } })).toThrow();
    }
    // valid hours (including the boundaries 0 and 23) are accepted
    for (const good of [0, 7, 23]) {
      expect(s.validateValue('wa', k, { timing: { hour: good } })).toBeNull();
    }
    const eff = s.set('wa', k, { enabled: true, text: 't', timing: { hour: 6 } });
    expect(eff.timing).toEqual({ hour: 6 });
    // nothing bad leaked into the store
    expect(s.all().effective.wa[k].timing).toEqual({ hour: 6 });
  });

  it('range-validates quiet_reminder timing (idle_hours/max/window)', () => {
    const s = loadFresh();
    const k = 'trigger.quiet_reminder';
    const base = { idle_hours: 24, max: 3, window: [9, 21] };
    const bad = [
      { ...base, idle_hours: 0 }, // must be >= 1
      { ...base, max: 0 }, // must be >= 1
      { ...base, window: [0, 0] }, // start must be < end
      { ...base, window: [21, 9] }, // out of order
      { ...base, window: [9] }, // wrong length
      { ...base, window: [9, 24] }, // hour out of range
      { ...base, window: [-1, 9] }, // hour out of range
      { ...base, idle_hours: 2.5 }, // non-integer
    ];
    for (const t of bad) {
      expect(s.validateValue('wa', k, { timing: t })).toBeTruthy();
      expect(() => s.set('wa', k, { enabled: true, text: 't', timing: t })).toThrow();
    }
    expect(s.validateValue('wa', k, { timing: base })).toBeNull();
    const eff = s.set('wa', k, { enabled: true, text: 't', timing: base });
    expect(eff.timing).toEqual(base);
    expect(Array.isArray(eff.timing.window)).toBe(true);
    expect(s.all().overrides).toHaveProperty(['wa', k]);
  });

  it('rejects timing on an event trigger that has no default timing', () => {
    const s = loadFresh();
    // list_closed is an event trigger — its default has no timing
    expect(s.validateValue('wa', 'trigger.list_closed', { timing: { hour: 7 } })).toBeTruthy();
    // but a valid timing-free override is fine
    expect(s.validateValue('wa', 'trigger.list_closed', { enabled: false, text: 'x' })).toBeNull();
  });
});

describe('get() is a defensive backstop', () => {
  it('returns the complete default when a bad-typed override is on disk (bypassing set)', () => {
    // Write a broken override DIRECTLY to the store file (simulating corruption
    // or a write that bypassed validateValue), then load fresh.
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({ email: { field_labels: null, order_paid: 'nonsense' } }),
      'utf8'
    );
    const s = loadFresh();
    // field_labels default is fully restored — currency etc. are never undefined.
    const f = s.get('email', 'field_labels');
    expect(f.currency).toBe('₪');
    expect(f.version).toBe('גרסה');
    // order_paid returns the complete template, not the bad string.
    expect(s.get('email', 'order_paid')).toEqual({
      subject: 'דוגרי · התקבל תשלום — {honoree}',
      body: 'התקבל תשלום עבור ההזמנה של {honoree}.',
    });
  });
});

describe('set() rolls back the in-memory change when save() fails', () => {
  it('leaves the prior value intact and does not persist a failed write', () => {
    const s = loadFresh();
    // Establish a good prior override.
    s.set('email', 'order_paid', { subject: 'good', body: 'good body' });
    // Now force the atomic write to fail on the next save.
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENOSPC: disk full');
    });
    expect(() => s.set('email', 'order_paid', { subject: 'new', body: 'new body' })).toThrow(
      /disk full/
    );
    spy.mockRestore();
    // Memory still holds the PRIOR value — not the failed new one.
    expect(s.get('email', 'order_paid')).toEqual({ subject: 'good', body: 'good body' });
    // And disk was never updated to the new value.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    expect(onDisk.email.order_paid).toEqual({ subject: 'good', body: 'good body' });
  });

  it('rolls back to NO override when the very first save fails', () => {
    const s = loadFresh();
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('EACCES: read-only fs');
    });
    expect(() => s.set('email', 'footer', { line1: 'x', line2: 'y' })).toThrow();
    spy.mockRestore();
    // The section/key was never left dangling in memory.
    expect(s.all().overrides).toEqual({});
    expect(s.get('email', 'footer')).toEqual({ line1: 'נתראה על הלוח,', line2: 'צוות דוגרי' });
  });
});

describe('feature flags (kind: flag)', () => {
  it('get returns the boolean default (false) when there is no override', () => {
    const s = loadFresh();
    expect(s.get('features', 'color_picking')).toBe(false);
    expect(s.get('features', 'chasers_choice')).toBe(false);
    expect(s.get('features', 'font_choice')).toBe(false);
    expect(s.get('features', 'name_preview')).toBe(false);
  });

  it('set stores + persists a flag, and reset restores the default', () => {
    const s = loadFresh();
    expect(s.set('features', 'color_picking', true)).toBe(true);
    expect(s.get('features', 'color_picking')).toBe(true);
    // Persisted to disk: a freshly loaded copy sees the override.
    const reloaded = loadFresh();
    expect(reloaded.get('features', 'color_picking')).toBe(true);
    // reset drops the override and restores the default (false).
    expect(reloaded.reset('features', 'color_picking')).toBe(false);
    expect(reloaded.all().overrides).toEqual({});
  });

  it('validateValue accepts booleans and rejects everything else', () => {
    const s = loadFresh();
    for (const good of [true, false]) {
      expect(s.validateValue('features', 'name_preview', good)).toBeNull();
    }
    for (const bad of ['true', 'false', 1, 0, null, {}, [], undefined]) {
      expect(s.validateValue('features', 'name_preview', bad)).toBeTruthy();
      expect(() => s.set('features', 'name_preview', bad)).toThrow();
    }
    // No bad override leaked into the store or onto disk.
    expect(s.all().overrides).toEqual({});
    expect(fs.existsSync(path.join(dataDir, 'settings.json'))).toBe(false);
  });

  it('all().registry.features advertises the flag kind for every key', () => {
    const s = loadFresh();
    const reg = s.all().registry.features;
    for (const k of ['color_picking', 'chasers_choice', 'font_choice', 'name_preview']) {
      expect(reg[k]).toEqual({ tokens: [], kind: 'flag' });
    }
  });
});

describe('all()', () => {
  it('exposes defaults, overrides, effective and the registry (tokens + kind)', () => {
    const s = loadFresh();
    s.set('email', 'order_finished', { subject: 'מוכן', body: 'הכל מוכן' });
    const a = s.all();
    // defaults are the registry defaults, untouched by the override.
    expect(a.defaults.email.order_finished.subject).toBe('דוגרי · הזמנה מוכנה להפקה — {honoree}');
    // overrides carry only what was set.
    expect(a.overrides.email.order_finished).toEqual({ subject: 'מוכן', body: 'הכל מוכן' });
    // effective is the merged value.
    expect(a.effective.email.order_finished.subject).toBe('מוכן');
    // registry advertises tokens + kind per key so the UI can render an editor.
    expect(a.registry.email.order_paid).toEqual({ tokens: ['honoree'], kind: 'email' });
    expect(a.registry.wa['trigger.word_added'].kind).toBe('trigger');
    expect(a.registry.wa['trigger.word_added'].tokens).toContain('count');
  });
});

describe('interpolate', () => {
  it('replaces known tokens', () => {
    const s = loadFresh();
    expect(s.interpolate('שלום {honoree}!', { honoree: 'דנה' })).toBe('שלום דנה!');
    expect(s.interpolate('{count} מילים', { count: 12 })).toBe('12 מילים');
  });

  it('leaves unknown tokens as-is', () => {
    const s = loadFresh();
    expect(s.interpolate('{honoree} — {link}', { honoree: 'דנה' })).toBe('דנה — {link}');
    expect(s.interpolate('{nope}', {})).toBe('{nope}');
  });

  it('HTML-escapes substituted values only on the html path', () => {
    const s = loadFresh();
    const val = { honoree: '<b>a & b</b>' };
    expect(s.interpolate('{honoree}', val)).toBe('<b>a & b</b>');
    expect(s.interpolate('{honoree}', val, { html: true })).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
  });
});
