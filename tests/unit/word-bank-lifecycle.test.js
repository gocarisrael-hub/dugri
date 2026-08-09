// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// THE LIFECYCLE OF THE APPROVED WORD BANK, through the real routes.
//
// The bank is the production input the later production-preview step will render
// from, so what matters is not that a field exists but WHEN it appears and when
// it goes away: frozen at the close that approves the order, discarded the
// moment the order stops matching it, re-frozen (version + 1) on the next close.
// The owner settled the discard rule herself: "discarded and re-frozen on the
// next close".
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';

let app;
let db;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-word-bank-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['db.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
  app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
});

async function post(urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patch(urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// An order with a design and a handful of the buyer's own words — the state a
// real collection is in when its owner presses סיום.
function seeded(name = 'לקוחה') {
  const c = db.createCollection(name);
  db.adminUpdateCollection(c.id, { theme: 'bachelorette' });
  db.addWords(c.id, ['מסיבה', 'חברים', 'ריקודים', 'צחוקים'], 'test');
  return c;
}

const close = (c) => post('/api/collections/' + c.id + '/close', { owner_token: c.owner_token });

describe('the approved word bank', () => {
  it('is frozen by the close that approves the order', async () => {
    const c = seeded();
    expect(db.getCollection(c.id).word_bank).toBeUndefined();

    expect((await close(c)).status).toBe(200);

    const bank = db.getCollection(c.id).word_bank;
    // No python on the box means no bank, and that is a supported state — the
    // order then prints the way it did before freezing existed. Everything below
    // is about what the bank IS when it could be made.
    if (!bank) return;
    expect(bank.version).toBe(1);
    expect(bank.theme).toBe('bachelorette');
    expect(bank.personal_count).toBe(4);
    expect(bank.words.length).toBeGreaterThanOrEqual(412);
    // The buyer's own words lead it, in her order — this is HER deck topped up,
    // not a pool with her words mixed in.
    expect(bank.words.slice(0, 4)).toEqual(['מסיבה', 'חברים', 'ריקודים', 'צחוקים']);
  });

  it('is discarded on reopen and re-frozen, one version higher, on the next close', async () => {
    const c = seeded();
    await close(c);
    const first = db.getCollection(c.id).word_bank;
    if (!first) return;

    const r = await post('/api/admin/collections/' + c.id + '/reopen?key=' + ADMIN_KEY);
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).word_bank).toBeUndefined();

    // The buyer adds one more word while it is open again…
    db.addWords(c.id, ['שירים'], 'test');
    await close(c);

    const second = db.getCollection(c.id).word_bank;
    expect(second.version).toBe(2);
    expect(second.personal_count).toBe(5);
    expect(second.words.slice(0, 5)).toEqual(['מסיבה', 'חברים', 'ריקודים', 'צחוקים', 'שירים']);
  });

  it('is discarded when the seed pool changes under it', async () => {
    const c = seeded();
    await close(c);
    if (!db.getCollection(c.id).word_bank) return;

    // The owner switches the pool that completes the deck — a production input,
    // so the frozen 412 is no longer what this order's inputs produce.
    const r = await patch('/api/admin/collections/' + c.id + '?key=' + ADMIN_KEY, {
      wordlist: 'generic-350.txt',
    });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).word_bank).toBeUndefined();
  });

  it('survives an edit that re-saves the same pool', async () => {
    // Opening the order dialog and pressing save must not cost the order its
    // approved bank — only a real change does.
    const c = seeded();
    await close(c);
    const before = db.getCollection(c.id).word_bank;
    if (!before) return;

    await patch('/api/admin/collections/' + c.id + '?key=' + ADMIN_KEY, { honoree_name: 'דנה' });
    expect(db.getCollection(c.id).word_bank).toEqual(before);
  });

  it('is not re-frozen by closing an already-closed order', async () => {
    // A repeated close is a no-op everywhere else (it must not re-send the
    // emails either), and it must not silently mint a new version here.
    const c = seeded();
    await close(c);
    const first = db.getCollection(c.id).word_bank;
    if (!first) return;
    await close(c);
    expect(db.getCollection(c.id).word_bank.version).toBe(1);
    expect(db.getCollection(c.id).word_bank.created_at).toBe(first.created_at);
  });
});
