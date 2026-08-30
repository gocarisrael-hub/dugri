// @vitest-environment node
//
// PRODUCING A DECK AND SENDING IT TO PRINT ARE TWO DECISIONS.
//
// They used to be one press. The admin pile "הופקו — לשליחה לדפוס" was read off
// the production record alone, and that was honest while only the owner's
// צור PDF ever wrote one: pressing it WAS the decision to send. Since #542 the
// buyer's סיום produces the deck herself — so orders began walking into the
// print pile on their own, at whatever hour a customer happened to finish, with
// nobody having looked at them.
//
// `released_at` is the missing half: `generated_at` says a file was built,
// `released_at` says a human decided it should go. The deck the buyer built is
// the deck that ships — releasing stamps and rebuilds nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let db, app, server, base, dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-release-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_KEY = 'dugri-admin';
  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'settings.js', 'index.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
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
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// A paid pickup order whose deck the BUYER produced by finishing — which is the
// state this whole change is about.
function buyerProduced({ theme = 'anniversary', title = 'יובל חוגגת 23' } = {}) {
  const c = db.createCollection('שירה', { theme, custom_title: title, phone: '0527275047' });
  db.setOrder(c.id, c.owner_token, { version: 'pickup' });
  db.markPaid(c.id, { method: 'pelecard' });
  db.setProduction(c.id, { state: 'generated', pages: 208 });
  return c;
}
const prodOf = (id) => {
  const c = db.getCollection(id);
  return (c.order && c.order.production) || c.production || null;
};
const post = (p, body) =>
  fetch(base + p + (p.includes('?') ? '&' : '?') + 'key=dugri-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

describe('releasing a produced deck', () => {
  it('a buyer-produced deck is generated but NOT released', () => {
    // The bug, stated: finishing built a file and nothing else should follow.
    const c = buyerProduced();
    const p = prodOf(c.id);
    expect(p.state).toBe('generated');
    expect(p.released_at).toBeUndefined();
  });

  it('the owner releasing it stamps, and keeps every other field', () => {
    const c = buyerProduced();
    const before = prodOf(c.id);
    const after = db.setProductionReleased(c.id, true);
    expect(after.released_at).toBeTruthy();
    // The file she already has is the file that ships.
    expect(after.pdf_token).toBe(before.pdf_token);
    expect(after.pages).toBe(208);
    expect(after.state).toBe('generated');
  });

  it('releasing twice keeps the first stamp', () => {
    const c = buyerProduced();
    const first = db.setProductionReleased(c.id, true).released_at;
    expect(db.setProductionReleased(c.id, true).released_at).toBe(first);
  });

  it('it can be taken back', () => {
    const c = buyerProduced();
    db.setProductionReleased(c.id, true);
    expect(db.setProductionReleased(c.id, false).released_at).toBeUndefined();
  });

  it('there is nothing to release before a deck exists', () => {
    const c = db.createCollection('שירה', { theme: 'anniversary' });
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    expect(db.setProductionReleased(c.id, true)).toBeNull();
  });

  it('undoing the production takes the release with it', () => {
    // "בטל הפקה" deletes the record and the files; a re-produced deck has to
    // start unreleased again, which is the safe direction.
    const c = buyerProduced();
    db.setProductionReleased(c.id, true);
    db.clearProduction(c.id);
    expect(prodOf(c.id)).toBeNull();
    db.setProduction(c.id, { state: 'generated', pages: 208 });
    expect(prodOf(c.id).released_at).toBeUndefined();
  });
});

describe('the release route', () => {
  it('stamps, and answers with the record', async () => {
    const c = buyerProduced();
    const r = await post('/api/admin/collections/' + c.id + '/release');
    expect(r.status).toBe(200);
    expect((await r.json()).production.released_at).toBeTruthy();
    expect(prodOf(c.id).released_at).toBeTruthy();
  });

  it('undoes with {undo:true}', async () => {
    const c = buyerProduced();
    await post('/api/admin/collections/' + c.id + '/release');
    const r = await post('/api/admin/collections/' + c.id + '/release', { undo: true });
    expect(r.status).toBe(200);
    expect(prodOf(c.id).released_at).toBeUndefined();
  });

  it('refuses an order with no deck (409), rather than stamping an empty record', async () => {
    const c = db.createCollection('שירה', { theme: 'anniversary' });
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    const r = await post('/api/admin/collections/' + c.id + '/release');
    expect(r.status).toBe(409);
  });

  it('404s an order that does not exist', async () => {
    expect((await post('/api/admin/collections/nope/release')).status).toBe(404);
  });

  it('needs the admin key', async () => {
    const c = buyerProduced();
    const r = await fetch(base + '/api/admin/collections/' + c.id + '/release', { method: 'POST' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(prodOf(c.id).released_at).toBeUndefined();
  });
});

describe('the sticker sheet follows the pile it mirrors', () => {
  it('a built-but-unreleased deck is not in tonight’s batch', () => {
    // The sheet calls itself "exactly the owner's הופקו pile" and ONE STAGE, NOT
    // A RANGE. Reading `generated` here would label boxes nobody has sent.
    const c = buyerProduced({ title: 'טרם שוחרר' });
    expect(app.pickupStickerOrders().map((x) => x.title)).not.toContain('טרם שוחרר');
    db.setProductionReleased(c.id, true);
    expect(app.pickupStickerOrders().map((x) => x.title)).toContain('טרם שוחרר');
  });
});
