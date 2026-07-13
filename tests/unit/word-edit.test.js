// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boot the real db + Express app against a throwaway DATA_DIR so the tests never
// touch real data. Mirrors tests/unit/collection-reopen-routes.test.js.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;
let db;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-word-edit-'));
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

// The single word of a collection (helper: collections start with one word).
function onlyWord(id) {
  return db.listWords(id)[0];
}

async function patch(urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('db.editWord', () => {
  it('changes the text and preserves the word id + added_by + created_at', () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['סוכר באמא'], 'דנה');
    const w = onlyWord(c.id);

    const r = db.editWord(c.id, w.id, 'סוכר בבא', c.owner_token);
    expect(r.text).toBe('סוכר בבא');
    // Same word — identity + contributor metadata are untouched.
    const after = onlyWord(c.id);
    expect(after.id).toBe(w.id);
    expect(after.text).toBe('סוכר בבא');
    expect(after.added_by).toBe('דנה');
    expect(after.created_at).toBe(w.created_at);
    // dedupe norm was recomputed for the new text.
    expect(after.norm).toBe('סוכר בבא');
  });

  it('trims, collapses inner whitespace, and caps at 80 chars', () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['מילה'], null);
    const w = onlyWord(c.id);

    db.editWord(c.id, w.id, '   הרבה    רווחים   ', c.owner_token);
    expect(onlyWord(c.id).text).toBe('הרבה רווחים');

    db.editWord(c.id, w.id, 'א'.repeat(200), c.owner_token);
    expect(onlyWord(c.id).text.length).toBe(80);
  });

  it('rejects an edit that normalizes to empty, leaving the word unchanged', () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['שמור אותי'], null);
    const w = onlyWord(c.id);

    expect(db.editWord(c.id, w.id, '   ', c.owner_token)).toMatchObject({ error: 'empty' });
    expect(onlyWord(c.id).text).toBe('שמור אותי');
  });

  it('rejects a duplicate of ANOTHER existing word (case/space-insensitive)', () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['ראשונה', 'שנייה'], null);
    const [w1] = db.listWords(c.id);

    // Editing w1 to collide with "שנייה" (different casing/spacing) is rejected.
    expect(db.editWord(c.id, w1.id, '  שנייה ', c.owner_token)).toMatchObject({
      error: 'duplicate',
    });
    expect(db.listWords(c.id).find((x) => x.id === w1.id).text).toBe('ראשונה');
  });

  it('allows re-casing/re-spacing the word to its OWN normalized form', () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['shira'], null);
    const w = onlyWord(c.id);
    const r = db.editWord(c.id, w.id, 'Shira', c.owner_token);
    expect(r.text).toBe('Shira');
    expect(onlyWord(c.id).text).toBe('Shira');
  });

  it('returns forbidden on a bad owner token (word unchanged)', () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['לא לגעת'], null);
    const w = onlyWord(c.id);
    expect(db.editWord(c.id, w.id, 'שונה', 'wrong-token')).toMatchObject({ error: 'forbidden' });
    expect(onlyWord(c.id).text).toBe('לא לגעת');
  });

  it('returns not_found for an unknown word id, and null for an unknown collection', () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['מילה'], null);
    expect(db.editWord(c.id, 'no-such-word', 'x', c.owner_token)).toMatchObject({
      error: 'not_found',
    });
    expect(db.editWord('no-such-collection', 'no-such-word', 'x', 'tok')).toBe(null);
  });
});

describe('PATCH /api/collections/:id/words/:wordId', () => {
  it('updates a word and returns the sanitized text', async () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['טעעעות'], 'רן');
    const w = onlyWord(c.id);

    const r = await patch(`/api/collections/${c.id}/words/${w.id}`, {
      owner_token: c.owner_token,
      text: '  תוקן   כאן  ',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      word: { id: w.id, text: 'תוקן כאן', added_by: 'רן' },
    });
    expect(onlyWord(c.id).text).toBe('תוקן כאן');
  });

  it('403 on a bad owner token', async () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['מילה'], null);
    const w = onlyWord(c.id);
    const r = await patch(`/api/collections/${c.id}/words/${w.id}`, {
      owner_token: 'nope',
      text: 'שונה',
    });
    expect(r.status).toBe(403);
    expect(onlyWord(c.id).text).toBe('מילה');
  });

  it('404 for an unknown collection', async () => {
    const r = await patch('/api/collections/no-such-id/words/no-such-word', {
      owner_token: 'tok',
      text: 'x',
    });
    expect(r.status).toBe(404);
  });

  it('404 for an unknown word in a real collection', async () => {
    const c = db.createCollection('לקוח');
    const r = await patch(`/api/collections/${c.id}/words/no-such-word`, {
      owner_token: c.owner_token,
      text: 'x',
    });
    expect(r.status).toBe(404);
  });

  it('400 when the text is empty/whitespace', async () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['לפני'], null);
    const w = onlyWord(c.id);
    const r = await patch(`/api/collections/${c.id}/words/${w.id}`, {
      owner_token: c.owner_token,
      text: '   ',
    });
    expect(r.status).toBe(400);
    expect(onlyWord(c.id).text).toBe('לפני');
  });

  it('409 when the edit duplicates another existing word', async () => {
    const c = db.createCollection('לקוח');
    db.addWords(c.id, ['אחת', 'שתיים'], null);
    const [w1] = db.listWords(c.id);
    const r = await patch(`/api/collections/${c.id}/words/${w1.id}`, {
      owner_token: c.owner_token,
      text: 'שתיים',
    });
    expect(r.status).toBe(409);
    expect(db.listWords(c.id).find((x) => x.id === w1.id).text).toBe('אחת');
  });
});
