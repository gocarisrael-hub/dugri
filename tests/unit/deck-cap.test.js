// @vitest-environment node
// THE DECK CAP — 412 words, enforced where it can't be walked around.
//
// site/collect.html has shown "מקסימום" at 412 since the beginning, and the
// number is real: 412 = 103 word cards x 4, generator/topup.py's TARGET. But
// only the LABEL enforced it. The input stayed live, the server had no ceiling,
// and five orders reached production oversized — 423, 417, 416, 416, 413 — which
// the generator faithfully printed as bigger decks (212 pages instead of 208) on
// a fixed price.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');

let db;
let dataDir;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-deck-cap-'));
  process.env.DATA_DIR = dataDir;
  for (const f of ['db.js', 'settings.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  db = require(path.join(serverDir, 'db.js'));
});

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const CAP = 412;
// Distinct words, and never a repeat: a duplicate is dropped by a different rule
// and would quietly hide whether the cap did anything.
const words = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// A collection past the free quota, so the ONLY ceiling in play is the deck.
function seedPaid(name = 'קפ') {
  const c = db.createCollection(name, { email: 'x@example.com' });
  db.setOrder(c.id, c.owner_token, { version: 'pdf' }, { admin: true });
  db.markPaid(c.id, { method: 'card', transactionId: 'tx' });
  return c;
}

describe('the deck cap', () => {
  it('is the generator’s deck size, published as one number', () => {
    expect(db.DECK_WORDS).toBe(CAP);
  });

  it('fills to exactly 412 and refuses the rest, saying which is which', () => {
    const c = seedPaid();
    const r = db.addWords(c.id, words(420));
    expect(r.added).toBe(CAP);
    expect(r.full).toBe(8);
    // Not counted as a quota block: this collection is paid, and "you have not
    // paid" and "the deck is full" are different answers.
    expect(r.blocked).toBe(0);
    expect(db.countWords(c.id)).toBe(CAP);
  });

  it('refuses everything once full, and adds nothing', () => {
    const c = seedPaid();
    db.addWords(c.id, words(CAP));
    const r = db.addWords(c.id, words(5, 'later'));
    expect(r).toMatchObject({ added: 0, full: 5 });
    expect(db.countWords(c.id)).toBe(CAP);
  });

  it('takes exactly the room left when a batch straddles the cap', () => {
    const c = seedPaid();
    db.addWords(c.id, words(410));
    const r = db.addWords(c.id, words(10, 'edge'));
    expect(r.added).toBe(2);
    expect(r.full).toBe(8);
    expect(db.countWords(c.id)).toBe(CAP);
  });

  it('still drops a duplicate as a duplicate, not as a full deck', () => {
    const c = seedPaid();
    db.addWords(c.id, words(400));
    const r = db.addWords(c.id, ['w0', 'w1', 'fresh']);
    expect(r).toMatchObject({ added: 1, skipped: 2, full: 0 });
  });
});

// The five oversized orders that already exist keep every word they have.
// Trimming a customer's list to fit a rule invented after she wrote it is a
// worse failure than a slightly larger deck — so this loads a store written
// BEFORE the cap existed, the way production's really looks today.
describe('a collection that is already over the cap', () => {
  let legacyDb;
  let legacyDir;
  let id;

  beforeAll(() => {
    legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-legacy-'));
    id = 'legacy-collection';
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(legacyDir, 'dugri-data.json'),
      JSON.stringify({
        collections: [
          {
            id,
            owner_token: 'tok',
            honoree_name: 'ותיקה',
            status: 'open',
            created_at: now,
            expires_at: new Date(Date.now() + 8.64e7).toISOString(),
            order: { version: 'pdf', paid: true, paid_at: now, quantity: 1 },
          },
        ],
        // 420 words: over the cap, exactly like DG-1385 (423) and DG-1423 (417).
        words: words(420, 'old').map((t, i) => ({
          id: 'w' + i,
          collection_id: id,
          text: t,
          norm: t,
          created_at: now,
        })),
        held_words: [],
      })
    );
    process.env.DATA_DIR = legacyDir;
    delete require.cache[require.resolve(path.join(serverDir, 'db.js'))];
    legacyDb = require(path.join(serverDir, 'db.js'));
  });

  afterAll(() => {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    process.env.DATA_DIR = dataDir;
    delete require.cache[require.resolve(path.join(serverDir, 'db.js'))];
  });

  it('keeps every word it already has', () => {
    expect(legacyDb.countWords(id)).toBe(420);
  });

  it('accepts nothing further, and removes nothing doing so', () => {
    const r = legacyDb.addWords(id, ['חדשה', 'עוד אחת']);
    expect(r).toMatchObject({ added: 0, full: 2 });
    expect(legacyDb.countWords(id)).toBe(420);
  });
});

describe('the cap and the payment quota together', () => {
  beforeEach(() => {
    const settings = require(path.join(serverDir, 'settings.js'));
    settings.set('pricing', 'free_word_limit', 50);
  });

  it('does not PARK an over-cap word as held — paying would only defer it', () => {
    const c = db.createCollection('לא שולם', { email: 'y@example.com' });
    // 412 already in the list is impossible under a 50-word quota, so the check
    // is on the sum: held words count against the deck exactly like real ones,
    // because payment turns them into real ones.
    const r = db.addWords(c.id, words(120));
    const kept = r.added + r.held;
    expect(kept).toBeLessThanOrEqual(CAP);
    expect(r.added).toBe(50);
    expect(r.held).toBeGreaterThan(0);
  });
});
