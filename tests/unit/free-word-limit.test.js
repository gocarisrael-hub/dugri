import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The free word quota: a collection may gather `pricing.free_word_limit` words,
// after which adding is refused until the order is paid. Both the quota and the
// enforce switch are owner-editable, so this suite drives them through settings
// rather than hardcoding 20.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDbPath = path.join(__dirname, '..', '..', 'server', 'db.js');
const settingsPath = path.join(__dirname, '..', '..', 'server', 'settings.js');

let db;
let settings;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-freelimit-'));
  delete require.cache[require.resolve(settingsPath)];
  settings = require(settingsPath);
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  db = require(serverDbPath);
});

afterEach(() => {
  // Every test starts from the registry defaults.
  settings.reset('pricing', 'free_word_limit');
  settings.reset('pricing', 'lock_after_free_limit');
});

// n distinct words ('w1'…'wn'), so nothing is lost to deduping.
const words = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => prefix + (i + 1));

describe('settings: the quota knobs', () => {
  it('defaults to a 20-word quota that is enforced', () => {
    expect(settings.get('pricing', 'free_word_limit')).toBe(20);
    expect(settings.get('pricing', 'lock_after_free_limit')).toBe(true);
  });

  it('rejects a 0 quota — it would lock every collection at its first word', () => {
    expect(settings.validateValue('pricing', 'free_word_limit', 0)).toBeTruthy();
    expect(() => settings.set('pricing', 'free_word_limit', 0)).toThrow();
  });

  it('rejects a non-integer quota', () => {
    expect(settings.validateValue('pricing', 'free_word_limit', 12.5)).toBeTruthy();
    expect(settings.validateValue('pricing', 'free_word_limit', '20')).toBeTruthy();
  });

  it('accepts a positive integer quota', () => {
    expect(settings.validateValue('pricing', 'free_word_limit', 5)).toBe(null);
    expect(settings.set('pricing', 'free_word_limit', 5)).toBe(5);
  });
});

describe('addWords under the quota', () => {
  it('stores words freely below the quota', () => {
    settings.set('pricing', 'free_word_limit', 5);
    const c = db.createCollection('שירה', { email: 'a@example.com' });
    const r = db.addWords(c.id, words(3));
    expect(r).toMatchObject({ added: 3, skipped: 0, blocked: 0 });
    expect(db.countWords(c.id)).toBe(3);
  });

  it('accepts a batch PARTIALLY: fills the remaining slots, blocks the rest', () => {
    settings.set('pricing', 'free_word_limit', 5);
    const c = db.createCollection('שירה', { email: 'b@example.com' });
    db.addWords(c.id, words(3));
    // 2 slots left, 10 offered -> 2 stored, 8 blocked. The buyer's typing is
    // never thrown away wholesale.
    const r = db.addWords(c.id, words(10, 'x'));
    expect(r).toMatchObject({ added: 2, blocked: 8 });
    expect(db.countWords(c.id)).toBe(5);
  });

  it('refuses every word once the quota is full', () => {
    settings.set('pricing', 'free_word_limit', 4);
    const c = db.createCollection('שירה', { email: 'c@example.com' });
    db.addWords(c.id, words(4));
    const r = db.addWords(c.id, ['נוספת']);
    expect(r).toMatchObject({ added: 0, blocked: 1 });
    expect(db.countWords(c.id)).toBe(4);
  });

  it('counts duplicates as skipped, not blocked — they were never going to store', () => {
    settings.set('pricing', 'free_word_limit', 10);
    const c = db.createCollection('שירה', { email: 'd@example.com' });
    db.addWords(c.id, ['קפה']);
    const r = db.addWords(c.id, ['קפה', 'תה']);
    expect(r).toMatchObject({ added: 1, skipped: 1, blocked: 0 });
  });

  it('a duplicate does not consume a quota slot', () => {
    settings.set('pricing', 'free_word_limit', 3);
    const c = db.createCollection('שירה', { email: 'e@example.com' });
    db.addWords(c.id, ['א']);
    // 'א' is a dupe; 'ב' and 'ג' still fit under the 3-word quota.
    const r = db.addWords(c.id, ['א', 'ב', 'ג']);
    expect(r).toMatchObject({ added: 2, skipped: 1, blocked: 0 });
    expect(db.countWords(c.id)).toBe(3);
  });
});

describe('who the quota applies to', () => {
  it('does not apply once the order is paid — payment is what lifts the gate', () => {
    settings.set('pricing', 'free_word_limit', 3);
    const c = db.createCollection('שירה', { email: 'f@example.com' });
    db.addWords(c.id, words(3));
    expect(db.freeLimit(c.id).locked).toBe(true);
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id);
    expect(db.freeLimit(c.id).locked).toBe(false);
    const r = db.addWords(c.id, ['עוד', 'ועוד']);
    expect(r).toMatchObject({ added: 2, blocked: 0 });
  });

  it('does not apply to collections created before the gate shipped', () => {
    settings.set('pricing', 'free_word_limit', 2);
    const c = db.createCollection('שירה', { email: 'g@example.com' });
    // Older rows carry no `free_limit_applies` stamp at all.
    delete db.getCollection(c.id).free_limit_applies;
    const r = db.addWords(c.id, words(6));
    expect(r).toMatchObject({ added: 6, blocked: 0 });
    expect(db.freeLimit(c.id).locked).toBe(false);
  });

  it('stops blocking when the enforce switch is off, keeping the quota number', () => {
    settings.set('pricing', 'free_word_limit', 2);
    settings.set('pricing', 'lock_after_free_limit', false);
    const c = db.createCollection('שירה', { email: 'h@example.com' });
    const r = db.addWords(c.id, words(6));
    expect(r).toMatchObject({ added: 6, blocked: 0 });
    const fl = db.freeLimit(c.id);
    expect(fl.limit).toBe(2);
    expect(fl.applies).toBe(false);
    expect(fl.locked).toBe(false);
  });
});

describe('freeLimitState projection', () => {
  it('reports remaining slots while below the quota', () => {
    settings.set('pricing', 'free_word_limit', 20);
    const c = db.createCollection('שירה', { email: 'i@example.com' });
    db.addWords(c.id, words(12));
    expect(db.freeLimit(c.id)).toMatchObject({ limit: 20, remaining: 8, locked: false });
  });

  it('never reports a negative remainder', () => {
    settings.set('pricing', 'free_word_limit', 4);
    const c = db.createCollection('שירה', { email: 'j@example.com' });
    db.addWords(c.id, words(4));
    expect(db.freeLimit(c.id).remaining).toBe(0);
  });

  it('falls back to the registry default when the override is corrupt', () => {
    // Bypass validateValue the way a hand-edited settings.json would.
    const c = db.createCollection('שירה', { email: 'k@example.com' });
    const state = db.freeLimitState({ ...db.getCollection(c.id) }, 0);
    expect(state.limit).toBe(20);
  });
});

describe('the one-time "quota reached" email marker', () => {
  it('returns true exactly once, so the mail can never be sent twice', () => {
    const c = db.createCollection('שירה', { email: 'l@example.com' });
    expect(db.markFreeLimitNotified(c.id)).toBe(true);
    expect(db.markFreeLimitNotified(c.id)).toBe(false);
    expect(db.getCollection(c.id).free_limit_notified_at).toBeTruthy();
  });

  it('starts null on a fresh collection', () => {
    const c = db.createCollection('שירה', { email: 'm@example.com' });
    expect(c.free_limit_notified_at).toBe(null);
    expect(c.free_limit_applies).toBe(true);
  });

  it('is a no-op for an unknown collection', () => {
    expect(db.markFreeLimitNotified('nope')).toBe(false);
  });
});

describe('the "quota reached" email body', () => {
  it('names the quota and carries the pay CTA on the owner link', () => {
    const notify = require(path.join(__dirname, '..', '..', 'server', 'notify.js'));
    const c = db.createCollection('שירה', { email: 'n@example.com' });
    const msg = notify.buildFreeLimitReached(c, 'https://dugri.example', 20);
    expect(msg.subject).toContain('20');
    expect(msg.subject).toContain('שירה');
    expect(msg.text).toContain('20');
    // The CTA points at the owner link — the page the pay panel lives on.
    expect(msg.html).toContain(c.owner_token);
    expect(msg.text).toContain(c.owner_token);
  });
});

// The held bucket: words the quota refuses are parked, not discarded, and cross
// into the real list exactly once — on payment. This exists because a buyer
// pasted 150 words onto a 15-word quota, was shown "all your words are saved",
// paid, and found 15. The 135 were never stored anywhere.
describe('words the quota refuses are held, not dropped', () => {
  it('parks the overflow of a batch and keeps it out of the list', () => {
    settings.set('pricing', 'free_word_limit', 5);
    const c = db.createCollection('שירה', { email: 'h1@example.com' });
    const r = db.addWords(c.id, words(12));
    expect(r).toMatchObject({ added: 5, blocked: 7, held: 7, dropped: 0 });
    // The list holds only what was paid for; the count the whole product reads
    // from is untouched by the held words.
    expect(db.countWords(c.id)).toBe(5);
    expect(db.countHeldWords(c.id)).toBe(7);
    expect(db.listWords(c.id)).toHaveLength(5);
    expect(db.listHeldWords(c.id).map((w) => w.text)).toEqual(words(12).slice(5));
  });

  it('releases them into the list on payment, oldest-first, keeping their order', () => {
    settings.set('pricing', 'free_word_limit', 3);
    const c = db.createCollection('שירה', { email: 'h2@example.com' });
    db.addWords(c.id, words(9));
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    expect(db.markPaid(c.id)).toBe(true);
    expect(db.countHeldWords(c.id)).toBe(0);
    expect(db.listWords(c.id).map((w) => w.text)).toEqual(words(9));
  });

  it('keeps the contributor name on a released word', () => {
    settings.set('pricing', 'free_word_limit', 1);
    const c = db.createCollection('שירה', { email: 'h3@example.com' });
    db.addWords(c.id, ['ראשונה', 'שנייה'], 'דנה');
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id);
    const released = db.listWords(c.id).find((w) => w.text === 'שנייה');
    expect(released.added_by).toBe('דנה');
  });

  it('does not hold a word that is already in the list', () => {
    settings.set('pricing', 'free_word_limit', 2);
    const c = db.createCollection('שירה', { email: 'h4@example.com' });
    db.addWords(c.id, ['אחת', 'שתיים']);
    // 'אחת' is a duplicate of a stored word, so it is skipped rather than held —
    // releasing it later would put the same word in the deck twice.
    const r = db.addWords(c.id, ['אחת', 'שלוש']);
    expect(r).toMatchObject({ added: 0, skipped: 1, blocked: 1, held: 1 });
    expect(db.listHeldWords(c.id).map((w) => w.text)).toEqual(['שלוש']);
  });

  it('promotes a held word typed by hand instead of showing it in both places', () => {
    settings.set('pricing', 'free_word_limit', 1);
    const c = db.createCollection('שירה', { email: 'h5@example.com' });
    db.addWords(c.id, ['אחת', 'שתיים']);
    expect(db.countHeldWords(c.id)).toBe(1);
    // The owner raises the quota — which does NOT lift it, so the bucket stays
    // parked — and types the held word herself before paying.
    settings.set('pricing', 'free_word_limit', 10);
    db.addWords(c.id, ['שתיים']);
    expect(db.listWords(c.id).map((w) => w.text)).toEqual(['אחת', 'שתיים']);
    // The held copy is GONE, not waiting alongside it. Leaving it would print
    // 'שתיים' on the page twice — once as collected, once under "will be added
    // when you pay" — about a word she can already see in her list.
    expect(db.countHeldWords(c.id)).toBe(0);
  });

  it('discards an emptied bucket on disk, not just in memory', () => {
    settings.set('pricing', 'free_word_limit', 1);
    const c = db.createCollection('שירה', { email: 'h10@example.com' });
    db.addWords(c.id, ['אחת', 'שתיים']);
    // Gate off, and the only held word is a duplicate of one already in the list,
    // so the release moves NOTHING while still emptying the bucket. A save keyed
    // on "did anything cross over" would skip here and the bucket would come back
    // from disk on the next boot.
    db.addWords(c.id, ['שתיים']);
    settings.set('pricing', 'lock_after_free_limit', false);
    db.addWords(c.id, ['שלוש']);
    expect(db.countHeldWords(c.id)).toBe(0);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(process.env.DATA_DIR, 'dugri-data.json'), 'utf8')
    );
    expect((onDisk.held_words || []).filter((w) => w.collection_id === c.id)).toEqual([]);
  });

  it('counts a re-pasted held word as a duplicate, not as a fresh rejection', () => {
    settings.set('pricing', 'free_word_limit', 2);
    const c = db.createCollection('שירה', { email: 'h11@example.com' });
    db.addWords(c.id, words(6));
    // She re-pastes the identical list, thinking the first attempt failed. The
    // four held words are duplicates — counting them as `blocked` as well would
    // break the partition of the batch and make the page report four rejections
    // for words it is already holding.
    const r = db.addWords(c.id, words(6));
    expect(r).toMatchObject({ added: 0, skipped: 6, blocked: 0, held: 0, dropped: 0 });
    expect(r.added + r.skipped + r.blocked + r.tooLong + r.emoji + r.niqqud).toBe(6);
    expect(db.countHeldWords(c.id)).toBe(4);
  });

  it('discards a word bank frozen before the held words were released', () => {
    settings.set('pricing', 'free_word_limit', 2);
    const c = db.createCollection('שירה', { email: 'h12@example.com' });
    db.addWords(c.id, words(6));
    // She closes while still unpaid — the close card is offered on any open
    // unpaid order — and the bank the deck prints from is frozen from the 2
    // words she has.
    db.closeCollection(c.id, c.owner_token);
    db.setWordBank(c.id, { words: db.listWords(c.id).map((w) => w.text) });
    expect(db.getCollection(c.id).word_bank).toBeTruthy();
    // Paying now releases 4 more words into the list. The frozen bank predates
    // them, so keeping it would print a deck without words the page shows as
    // collected. It is discarded and re-freezes on the next close.
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id);
    expect(db.listWords(c.id)).toHaveLength(6);
    expect(db.getCollection(c.id).word_bank).toBeUndefined();
  });

  it('keeps a word bank that no release invalidated', () => {
    settings.set('pricing', 'free_word_limit', 50);
    const c = db.createCollection('שירה', { email: 'h13@example.com' });
    db.addWords(c.id, words(4));
    db.closeCollection(c.id, c.owner_token);
    db.setWordBank(c.id, { words: db.listWords(c.id).map((w) => w.text) });
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id);
    // Nothing was held, so nothing moved, so the approved bank stands.
    expect(db.getCollection(c.id).word_bank).toBeTruthy();
  });

  it('releases the bucket as soon as the quota stops applying', () => {
    settings.set('pricing', 'free_word_limit', 2);
    const c = db.createCollection('שירה', { email: 'h6@example.com' });
    db.addWords(c.id, words(6));
    expect(db.countHeldWords(c.id)).toBe(4);
    // The owner switches the gate off. The next add sweeps the held words in
    // rather than leaving them stranded behind a lock that no longer exists.
    settings.set('pricing', 'lock_after_free_limit', false);
    db.addWords(c.id, ['נוספת']);
    expect(db.countHeldWords(c.id)).toBe(0);
    expect(db.listWords(c.id)).toHaveLength(7);
  });

  // The held bucket's own ceiling (MAX_HELD_WORDS, 500) is no longer the binding
  // one: a held word becomes a printed word the moment the buyer pays, so the
  // DECK cap (412, db.DECK_WORDS) stops the batch first. What the batch keeps —
  // stored plus held — can never exceed one deck, and the surplus is reported as
  // `full` rather than as anything we kept.
  it('refuses to hold beyond the deck, and says so rather than implying it kept them', () => {
    settings.set('pricing', 'free_word_limit', 1);
    const c = db.createCollection('שירה', { email: 'h7@example.com' });
    const r = db.addWords(c.id, words(520));
    expect(r.added).toBe(1);
    expect(r.held).toBe(db.DECK_WORDS - 1);
    expect(r.added + r.held).toBe(db.DECK_WORDS);
    // Everything past a full deck: refused outright, and counted as refused.
    expect(r.full).toBe(520 - db.DECK_WORDS);
    // `blocked` keeps its meaning — what the QUOTA turned away — and every one of
    // those was parked rather than lost, so nothing was dropped on the floor.
    expect(r.blocked).toBe(r.held);
    expect(r.dropped).toBe(0);
    expect(db.countHeldWords(c.id)).toBe(db.DECK_WORDS - 1);
  });

  it('never holds a word that failed validation', () => {
    settings.set('pricing', 'free_word_limit', 1);
    const c = db.createCollection('שירה', { email: 'h8@example.com' });
    const r = db.addWords(c.id, ['בסדר', 'שמח 🎉', 'שָׁלוֹם', 'ב'.repeat(40)]);
    expect(r).toMatchObject({ added: 1, emoji: 1, niqqud: 1, tooLong: 1, held: 0 });
    // A word we refuse for its content is refused, full stop — parking it would
    // only release it into the deck later, which is what the refusal prevents.
    expect(db.countHeldWords(c.id)).toBe(0);
  });

  it('drops the bucket with the collection', () => {
    settings.set('pricing', 'free_word_limit', 1);
    const c = db.createCollection('שירה', { email: 'h9@example.com' });
    db.addWords(c.id, words(5));
    expect(db.countHeldWords(c.id)).toBe(4);
    db.deleteCollection(c.id);
    expect(db.countHeldWords(c.id)).toBe(0);
  });
});
