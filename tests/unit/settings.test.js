// @vitest-environment node
// The owner-editable settings store (server/settings.js). It reads DATA_DIR at
// require time, so each test points DATA_DIR at a fresh temp dir BEFORE loading a
// clean copy of the module (fresh-require pattern).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
