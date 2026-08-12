import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// HOW LONG THE PRINTED GAME TAKES, in every place the buyer is told.
//
// The number lives in four unrelated files — the checkout options, the home-page
// FAQ (and the static copy of it in index.html), and the confirmation-email
// defaults — because each surface is written where it is rendered. That is fine
// until they drift: a buyer who reads "ready in 2 days" at checkout and "3–5
// business days" in her confirmation mail has been told two different things
// about the same order, and the one she remembers is the shorter one.
//
// So these tests pin the promise itself rather than any one file's wording:
// self-pickup is 3 business days, home delivery 7, and no surface is allowed to
// still be quoting the older, faster numbers (48 hours / 2 days for pickup, 5
// days for delivery).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// The surfaces that quote a production time, each named as the buyer meets it.
const SURFACES = [
  ['the checkout options', () => read('site', 'collect.html')],
  ['the home-page FAQ seed', () => read('server', 'faq.js')],
  ['the FAQ fallback in index.html', () => read('site', 'index.html')],
  ['the confirmation-email defaults', () => read('server', 'settings.js')],
];

// Whitespace in HTML wraps: index.html has the answer split across two source
// lines, so "תוך\n              3 ימי עסקים" is the same sentence. Collapse
// before matching, or this passes/fails on Prettier's line breaks.
const flat = (s) => s.replace(/\s+/g, ' ');

describe('production times are the same promise on every surface', () => {
  it('self-pickup is quoted as 3 business days, never 2 days or 48 hours', () => {
    for (const [name, load] of SURFACES) {
      const text = flat(load());
      expect(text, `${name} still promises pickup in 48 hours`).not.toContain('48 שעות');
      expect(text, `${name} still promises pickup in 2 business days`).not.toContain('2 ימי עסקים');
      expect(text, `${name} still quotes the old 3–5 day pickup range`).not.toContain('3–5 ימי');
    }
  });

  it('home delivery is quoted as 7 business days, never 5', () => {
    for (const [name, load] of SURFACES) {
      const text = flat(load());
      expect(text, `${name} still promises delivery in 5 days`).not.toMatch(/[^–-]5 ימים/);
      expect(text, `${name} still quotes the old 5–7 day delivery range`).not.toContain('5–7 ימי');
    }
  });

  it('the checkout states 3 days for pickup and 7 for delivery', () => {
    const html = flat(read('site', 'collect.html'));
    expect(html).toContain('מוכן תוך כ-3 ימי עסקים');
    expect(html).toContain('מגיע תוך כ-7 ימי עסקים');
  });

  // The trust line under the pay button used to carry a second promise —
  // "the file is sent within 24 hours of the words" — sitting directly beneath a
  // printed game quoted at 3 business days. Two turnaround times in one panel,
  // and the faster one was the one in the buyer's eye at the moment she paid.
  // The line is security reassurance now; each option states its own timing.
  it('the checkout trust line promises security, not a turnaround time', () => {
    const html = flat(read('site', 'collect.html'));
    const line = html.match(/data-edit="collect-pay-trust">([^<]*)</);
    expect(line, 'the trust line is gone entirely').not.toBeNull();
    expect(line[1]).toContain('תשלום מאובטח');
    expect(line[1]).not.toMatch(/\d/);
  });

  it('the FAQ answer about timing says 3 business days for pickup', () => {
    expect(flat(read('server', 'faq.js'))).toContain('איסוף עצמי אפשרי תוך 3 ימי עסקים');
  });

  // Read through the registry, not the file text: this is the value the mail
  // actually renders when the owner has saved no override of her own.
  it('the confirmation email quotes 3 days for pickup and 7 for delivery', async () => {
    const settings = await import('../../server/settings.js');
    const { REGISTRY } = settings.default || settings;
    expect(REGISTRY.email.pickup_info.default.eta).toContain('כ-3 ימי עסקים');
    expect(REGISTRY.email.delivery_info.default.eta).toContain('כ-7 ימי עסקים');
  });
});
