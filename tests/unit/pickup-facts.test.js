// THE PICKUP FACTS EXIST IN TWO PLACES NOW.
//
// The checkout's note opens in place rather than sending a buyer to /pickup —
// leaving a half-filled order to read an address is how an order gets abandoned.
// The cost of that decision is a second copy of the address and the hours, in a
// different file from the page that owns them.
//
// Two copies of a closing time is exactly how someone arrives at 16:15 on a
// Thursday to a locked door. So the copies are pinned to each other here: not
// word-for-word (the checkout is a one-line summary, the page is a table), but
// on every FACT a buyer could act on and be wrong about.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(__dirname, '..', '..', 'site');
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');
// Prettier re-wraps both files to its own width, so a fact can be split across
// source lines in one and not the other. Collapse before matching — the
// wrapping is formatting, the facts are the contract.
const flat = (s) => s.replace(/\s+/g, ' ');

// Just the checkout's pickup note, so a match cannot be satisfied by the same
// words appearing somewhere else on a 6000-line page.
function checkoutNote() {
  const html = read('collect.html');
  const start = html.indexOf('data-testid="pickup-details"');
  expect(start, 'the checkout pickup note is gone').toBeGreaterThan(-1);
  const end = html.indexOf('</details>', start);
  return flat(html.slice(start, end));
}

describe('the checkout note and the pickup page agree', () => {
  const note = checkoutNote();
  const page = flat(read('pickup.html'));

  // WHERE. Street, entrance and floor: the three that decide whether she finds
  // the door, and the three that were missing before the page existed.
  it.each(['התחייה 14', 'תל אביב', 'כניסה B', 'קומה ראשונה'])('both say %s', (fact) => {
    expect(note, 'the checkout note').toContain(fact);
    expect(page, 'the pickup page').toContain(fact);
  });

  // WHEN. Thursday closes an hour before the rest of the week — the single fact
  // most likely to be got wrong, and the one with a wasted drive behind it.
  it('both close at 15:30 on Thursday and 16:30 the rest of the week', () => {
    for (const [where, text] of [
      ['the checkout note', note],
      ['the pickup page', page],
    ]) {
      expect(text, where).toContain('15:30');
      expect(text, where).toContain('16:30');
    }
  });

  it('both say the weekend is closed', () => {
    expect(note).toContain('סגור');
    expect(page).toContain('סגור');
  });

  // WHAT TO BRING, and the one instruction that saves a wasted journey.
  it('both tell her not to come before we say it is ready', () => {
    expect(note).toContain('נעדכן');
    expect(page).toContain('נעדכן');
  });
});

describe('the checkout note stays a note', () => {
  const note = checkoutNote();

  it('is a <details>, so it opens in place instead of navigating', () => {
    expect(flat(read('collect.html'))).toContain('<details class="odd-note pickup-note"');
  });

  it('offers no way out of the order at all', () => {
    // The escape hatch is gone, not merely made survivable with target="_blank":
    // the note above already answers what the full page would have told her.
    expect(note).not.toContain('pickup.html');
  });

  it('ships shut — a footnote, not a section of the checkout', () => {
    // `open` would push the pay button down the screen on every arrival.
    expect(note).not.toMatch(/<details[^>]*\bopen\b/);
  });
});
