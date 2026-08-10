// @vitest-environment node
// The OWNER's own note on an order — hers, not the buyer's. `comment` is what
// the customer told us at checkout; this is what we wrote down about her. They
// are separate fields on purpose, and the tests below are mostly about keeping
// them separate: an edit to one must never touch the other.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const realFetch = globalThis.fetch;

let db;
let app;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-note-'));
  process.env.ADMIN_KEY = 'test-admin-key';
  for (const f of ['db.js', 'settings.js', 'notify.js', 'index.js']) {
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
  vi.restoreAllMocks();
  if (server) server.close();
});

const KEY = '?key=test-admin-key';
async function patch(id, body) {
  const res = await realFetch(base + '/api/admin/collections/' + id + KEY, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function made(name = 'שירה') {
  return db.createCollection(name, { email: 'buyer@example.com' });
}

describe('the owner note on a collection', () => {
  it('starts empty on a new collection, as a declared field', () => {
    const c = made();
    // Declared rather than absent, so no reader has to tell "no note" apart
    // from "a record written before notes existed".
    expect(c.owner_note).toBe(null);
  });

  it('is written and read back', () => {
    const c = made();
    db.adminUpdateCollection(c.id, { owner_note: 'מחכה לתמונה שלה' });
    expect(db.getCollection(c.id).owner_note).toBe('מחכה לתמונה שלה');
  });

  it('is cleared by an empty string, not left behind', () => {
    const c = made();
    db.adminUpdateCollection(c.id, { owner_note: 'זמני' });
    db.adminUpdateCollection(c.id, { owner_note: '   ' });
    expect(db.getCollection(c.id).owner_note).toBe(null);
  });

  it('keeps line breaks, collapses blank-line runs, and caps at 500', () => {
    const c = made();
    db.adminUpdateCollection(c.id, { owner_note: 'שורה\n\n\n\nשורה שנייה' });
    expect(db.getCollection(c.id).owner_note).toBe('שורה\n\nשורה שנייה');
    db.adminUpdateCollection(c.id, { owner_note: 'א'.repeat(700) });
    expect(db.getCollection(c.id).owner_note.length).toBe(500);
  });

  it('is a DIFFERENT field from the buyer’s comment — neither overwrites the other', () => {
    // The whole reason there are two. Merged into one box, nobody reading the
    // order back could tell which of them said it.
    const c = db.createCollection('דנה', {
      email: 'b@example.com',
      comment: 'זו הפתעה, אל תתקשרו אליה',
    });
    db.adminUpdateCollection(c.id, { owner_note: 'הודפס פעמיים, השני על חשבוננו' });
    const got = db.getCollection(c.id);
    expect(got.comment).toBe('זו הפתעה, אל תתקשרו אליה');
    expect(got.owner_note).toBe('הודפס פעמיים, השני על חשבוננו');
  });
});

describe('PATCH /api/admin/collections/:id with only owner_note', () => {
  it('requires the admin key', async () => {
    const c = made();
    const res = await realFetch(base + '/api/admin/collections/' + c.id + '?key=wrong', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_note: 'לא' }),
    });
    expect(res.status).toBe(403);
    expect(db.getCollection(c.id).owner_note).toBe(null);
  });

  it('saves the note', async () => {
    const c = made();
    const r = await patch(c.id, { owner_note: 'לתאם איסוף ליום חמישי' });
    expect(r.status).toBe(200);
    expect(db.getCollection(c.id).owner_note).toBe('לתאם איסוף ליום חמישי');
  });

  it('touches NOTHING else — the row-inline save sends this key alone', async () => {
    // The property the inline box on the orders row depends on: a body of
    // {owner_note} must not disturb a field the owner never opened.
    const c = db.createCollection('רותם', {
      email: 'r@example.com',
      phone: '0521234567',
      comment: 'צריך עד יום חמישי',
      custom_title: 'כותרת',
    });
    db.adminUpdateCollection(c.id, { theme: 'bachelorette', chasers: true });
    const before = { ...db.getCollection(c.id) };
    await patch(c.id, { owner_note: 'שלחתי לגלאור' });
    const after = db.getCollection(c.id);
    for (const k of [
      'honoree_name',
      'owner_email',
      'owner_phone',
      'comment',
      'custom_title',
      'theme',
      'chasers',
      'status',
      'created_at',
    ]) {
      expect(after[k], k).toEqual(before[k]);
    }
    expect(after.owner_note).toBe('שלחתי לגלאור');
  });

  it('404s for an unknown collection', async () => {
    const r = await patch('nope', { owner_note: 'x' });
    expect(r.status).toBe(404);
  });
});
