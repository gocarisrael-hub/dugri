// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// THE NOTE ON AN ORDER. It began as a box in the wizard; the owner has since
// removed that box, so no customer types one any more (see
// tests/e2e/order-comment.spec.js, which now guards its absence). What remains is
// the OWNER's own field: where she records what a customer told her on WhatsApp,
// and where the notes existing orders already carry keep living.
//
// The create route still ACCEPTS a comment, which is what these tests use to seed
// one — cheaper than driving the admin dialog, and it keeps the storage rules
// under test whichever way a comment arrives.
//
// Covered here: it is stored as typed (sanitized), it survives to the admin
// order, admin can edit it, it reaches the owner's order email, and it NEVER
// reaches the generator — a note is not a title.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
let app;
let db;
let notify;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-comment-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  app = require(path.join(serverDir, 'index.js'));
  db = require(path.join(serverDir, 'db.js'));
  notify = require(path.join(serverDir, 'notify.js'));
  await new Promise((res) => {
    server = app.listen(0, res);
  });
  base = 'http://127.0.0.1:' + server.address().port;
});

afterAll(async () => {
  if (server) await new Promise((res) => server.close(res));
});

async function createOrder(comment) {
  const r = await fetch(base + '/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      honoree_name: 'שירה',
      email: 'buyer@example.com',
      design: 'פריז',
      comment,
    }),
  });
  expect(r.status).toBe(201);
  return r.json();
}

describe('the note a buyer leaves with her order', () => {
  it('is stored exactly as she typed it', async () => {
    const { id } = await createOrder('זו הפתעה — אל תתקשרו אליה.');
    expect(db.getCollection(id).comment).toBe('זו הפתעה — אל תתקשרו אליה.');
  });

  it('keeps her line breaks, because a note is often a short list', async () => {
    const { id } = await createOrder('צריך עד חמישי\nלא לשלוח לכתובת בעבודה');
    expect(db.getCollection(id).comment).toBe('צריך עד חמישי\nלא לשלוח לכתובת בעבודה');
  });

  it('treats an empty or whitespace-only note as no note at all', async () => {
    expect(db.getCollection((await createOrder('   \n  ')).id).comment).toBeNull();
    expect(db.getCollection((await createOrder('')).id).comment).toBeNull();
    expect(db.getCollection((await createOrder(undefined)).id).comment).toBeNull();
  });

  it('caps a runaway paste instead of storing it whole', async () => {
    const { id } = await createOrder('א'.repeat(900));
    expect(db.getCollection(id).comment.length).toBe(500);
  });

  it('never bisects an emoji at the cap', async () => {
    const { id } = await createOrder('🎉'.repeat(600));
    const stored = db.getCollection(id).comment;
    expect(Array.from(stored).length).toBe(500);
    expect(stored).not.toMatch(/[\uD800-\uDBFF]$/); // no lone surrogate
  });

  it('reaches the admin order and can be corrected there', async () => {
    const { id } = await createOrder('בלי אגוזים');
    const listed = await fetch(
      base + '/api/admin/collections?key=' + encodeURIComponent(ADMIN_KEY)
    );
    const row = (await listed.json()).collections.find((x) => x.id === id);
    expect(row.comment).toBe('בלי אגוזים');

    const edited = await fetch(
      base + '/api/admin/collections/' + id + '?key=' + encodeURIComponent(ADMIN_KEY),
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: 'עדכון בטלפון: בלי אגוזים ובלי גלוטן' }),
      }
    );
    expect(edited.status).toBe(200);
    expect(db.getCollection(id).comment).toBe('עדכון בטלפון: בלי אגוזים ובלי גלוטן');
  });

  it('is in the email the owner actually reads', () => {
    const withNote = notify.buildPaidMessage(
      { id: 'c1', honoree_name: 'שירה', comment: 'זו הפתעה' },
      'https://test.example',
      {}
    );
    expect(withNote.text).toContain('זו הפתעה');
    const without = notify.buildPaidMessage(
      { id: 'c1', honoree_name: 'שירה' },
      'https://test.example',
      {}
    );
    // ...and no empty label on an order she said nothing about.
    expect(without.text).not.toContain('הערה מהלקוח/ה');
  });

  it('is never handed to the generator — a note is not a title', async () => {
    const { id } = await createOrder('אל תדפיסו את זה');
    const c = db.getCollection(id);
    expect(c.custom_title).toBeNull();
    expect(c.comment).toBe('אל תדפיסו את זה');
  });
});
