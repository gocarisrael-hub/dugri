// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// WHAT IS LEFT ON THE SHELF.
//
// Boards are printed in batches per design and a deck cannot ship without one;
// boxes, thank-you notes and stickers are the packing. None of it was counted by
// the software before, so "how many Santorini boards are left?" was answered by
// walking to the shelf.
//
// Marking an order READY is what uses them up — that is the moment the deck comes
// back from the printer and gets packed. It is a toggle, so the interesting half
// of this file is the way back: un-marking a row pressed by mistake has to put
// back exactly what that press took, not what a fresh calculation would say it
// took — the rules underneath may have changed in between.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let db;
let app;
let server;
let base;
let dataDir;

// The live design list the routes read from themes.json. Passed in explicitly
// here so these tests do not depend on which templates happen to be installed.
const DESIGNS = [
  { theme: 'anniversary', name: 'סנטוריני' },
  { theme: 'birthday-girls', name: 'קליפורניה' },
  { theme: 'bachelorette', name: 'פריז' },
  { theme: 'japanese', name: 'טוקיו' },
  { theme: 'brand-new', name: 'עיצוב חדש' },
];

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-stock-'));
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

// An order standing exactly where the shelf gets touched: sent to print, not yet
// marked ready.
function orderAtPrinter(theme = 'anniversary') {
  const c = db.createCollection('בדיקת מלאי', { theme });
  db.setOrder(c.id, c.owner_token, { version: 'pickup' });
  db.markPaid(c.id, { method: 'pelecard' });
  db.setOrderSentToPrint(c.id, true);
  return c;
}

const boardCount = (snap, theme) => (snap.boards.find((b) => b.theme === theme) || {}).count;
const supply = (snap, key) => snap.supplies.find((s) => s.key === key);

describe('the opening count', () => {
  it('seeds each design from the shelf the owner counted, by its Hebrew name', () => {
    const snap = db.stockSnapshot(DESIGNS);
    expect(boardCount(snap, 'anniversary')).toBe(40); // סנטוריני
    expect(boardCount(snap, 'birthday-girls')).toBe(40); // קליפורניה
    expect(boardCount(snap, 'bachelorette')).toBe(40); // פריז
    expect(boardCount(snap, 'japanese')).toBe(5); // טוקיו
  });

  it('starts a design that was not on the shelf at zero, not at somebody else’s number', () => {
    expect(boardCount(db.stockSnapshot(DESIGNS), 'brand-new')).toBe(0);
  });

  it('seeds the packing supplies, and what each order uses of them', () => {
    const snap = db.stockSnapshot(DESIGNS);
    expect(supply(snap, 'packaging')).toMatchObject({ count: 139, per_order: 1 });
    expect(supply(snap, 'thankyou')).toMatchObject({ count: 80, per_order: 1 });
    // Stickers are counted but NOT deducted automatically: the brief named them
    // as stock and did not name them in what an order uses, so the number is
    // hers to set rather than ours to guess.
    expect(supply(snap, 'stickers')).toMatchObject({ count: 80, per_order: 0 });
  });

  it('seeds ONCE — a count set to zero is not helpfully restocked on the next read', () => {
    db.setBoardStock('bachelorette', 0, DESIGNS);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'bachelorette')).toBe(0);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'bachelorette')).toBe(0);
  });

  it('keeps the boards of a design whose template is gone, and says so', () => {
    db.setBoardStock('japanese', 7, DESIGNS);
    const snap = db.stockSnapshot(DESIGNS.filter((d) => d.theme !== 'japanese'));
    const row = snap.boards.find((b) => b.theme === 'japanese');
    // The boards are on the shelf whether or not the template is still installed.
    expect(row).toMatchObject({ count: 7, orphan: true });
  });
});

describe('correcting a count by hand', () => {
  it('takes a restock', () => {
    expect(db.setBoardStock('anniversary', 62, DESIGNS)).toBe(62);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'anniversary')).toBe(62);
  });

  it('refuses a design that does not exist', () => {
    expect(db.setBoardStock('no-such-theme', 5, DESIGNS)).toBeNull();
  });

  it('changes a supply’s count and its per-order number independently', () => {
    db.setSupplyStock('packaging', { count: 200 });
    expect(supply(db.stockSnapshot(DESIGNS), 'packaging')).toMatchObject({
      count: 200,
      per_order: 1, // a restock must not reset how many an order uses
    });
    db.setSupplyStock('packaging', { per_order: 2 });
    expect(supply(db.stockSnapshot(DESIGNS), 'packaging')).toMatchObject({
      count: 200,
      per_order: 2,
    });
    db.setSupplyStock('packaging', { count: 139, per_order: 1 });
  });

  it('refuses a supply this build does not have', () => {
    expect(db.setSupplyStock('ribbons', { count: 5 })).toBeNull();
  });
});

describe('marking an order ready takes it off the shelf', () => {
  it('takes one board of the order’s OWN design, one box and one note', () => {
    db.setBoardStock('anniversary', 40, DESIGNS);
    db.setSupplyStock('packaging', { count: 139, per_order: 1 });
    db.setSupplyStock('thankyou', { count: 80, per_order: 1 });
    db.setSupplyStock('stickers', { count: 80, per_order: 0 });
    const c = orderAtPrinter('anniversary');

    db.setOrderReady(c.id, true);
    db.applyOrderStock(c.id, true, DESIGNS);

    const snap = db.stockSnapshot(DESIGNS);
    expect(boardCount(snap, 'anniversary')).toBe(39);
    expect(supply(snap, 'packaging').count).toBe(138);
    expect(supply(snap, 'thankyou').count).toBe(79);
    // …and nothing the owner did not ask to be counted.
    expect(supply(snap, 'stickers').count).toBe(80);
    expect(boardCount(snap, 'birthday-girls')).toBe(40);
  });

  it('takes it once, however many times it is asked to', () => {
    db.setBoardStock('birthday-girls', 40, DESIGNS);
    const c = orderAtPrinter('birthday-girls');
    db.applyOrderStock(c.id, true, DESIGNS);
    db.applyOrderStock(c.id, true, DESIGNS);
    db.applyOrderStock(c.id, true, DESIGNS);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'birthday-girls')).toBe(39);
  });

  it('puts back EXACTLY what it took, even after the rules changed underneath', () => {
    db.setBoardStock('bachelorette', 10, DESIGNS);
    db.setSupplyStock('packaging', { count: 100, per_order: 1 });
    const c = orderAtPrinter('bachelorette');
    db.applyOrderStock(c.id, true, DESIGNS);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'bachelorette')).toBe(9);
    expect(supply(db.stockSnapshot(DESIGNS), 'packaging').count).toBe(99);

    // The owner now decides an order uses three boxes. The undo must still put
    // back the ONE that this order actually took — recomputing would credit her
    // two boxes she never had.
    db.setSupplyStock('packaging', { per_order: 3 });
    db.applyOrderStock(c.id, false, DESIGNS);
    expect(supply(db.stockSnapshot(DESIGNS), 'packaging').count).toBe(100);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'bachelorette')).toBe(10);
    db.setSupplyStock('packaging', { per_order: 1 });
  });

  it('puts nothing back for an order that never took anything', () => {
    db.setBoardStock('japanese', 5, DESIGNS);
    const c = orderAtPrinter('japanese');
    db.applyOrderStock(c.id, false, DESIGNS);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'japanese')).toBe(5);
  });

  it('takes a board, a box and a note PER COPY — five decks are five games', () => {
    // The brief said "one", because one is what an order usually is. Shipping
    // five decks with one board between them is not a rounding error; it is four
    // games that cannot be played.
    db.setBoardStock('birthday-girls', 40, DESIGNS);
    db.setSupplyStock('packaging', { count: 139, per_order: 1 });
    db.setSupplyStock('thankyou', { count: 80, per_order: 1 });
    const c = db.createCollection('חמישה עותקים', { theme: 'birthday-girls' });
    db.setOrder(c.id, c.owner_token, { version: 'pickup', quantity: 5 });
    db.markPaid(c.id, { method: 'pelecard' });
    db.setOrderSentToPrint(c.id, true);

    db.applyOrderStock(c.id, true, DESIGNS);
    let snap = db.stockSnapshot(DESIGNS);
    expect(boardCount(snap, 'birthday-girls')).toBe(35);
    expect(supply(snap, 'packaging').count).toBe(134);
    expect(supply(snap, 'thankyou').count).toBe(75);

    // …and the undo gives back all five, not one.
    db.applyOrderStock(c.id, false, DESIGNS);
    snap = db.stockSnapshot(DESIGNS);
    expect(boardCount(snap, 'birthday-girls')).toBe(40);
    expect(supply(snap, 'packaging').count).toBe(139);
    expect(supply(snap, 'thankyou').count).toBe(80);
  });

  it('gives one board back for a record written before copies were counted', () => {
    // An order marked ready by an older build has no `boards` in its record.
    // One is what it took, so one is what it returns.
    db.setBoardStock('bachelorette', 10, DESIGNS);
    const c = orderAtPrinter('bachelorette');
    db.applyOrderStock(c.id, true, DESIGNS);
    delete db.getCollection(c.id).order.stock_taken.boards;
    db.applyOrderStock(c.id, false, DESIGNS);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'bachelorette')).toBe(10);
  });

  it('leaves the shelf alone for a DIGITAL order — nothing physical ships', () => {
    // A PDF order still goes through the print/ready pipeline (that is how the
    // owner tracks "the file went out"), so without this every digital sale
    // would quietly drain a shelf it never touched.
    db.setBoardStock('anniversary', 40, DESIGNS);
    const before = supply(db.stockSnapshot(DESIGNS), 'packaging').count;
    const c = db.createCollection('דיגיטלי', { theme: 'anniversary' });
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    db.markPaid(c.id, { method: 'pelecard' });
    db.setOrderSentToPrint(c.id, true);

    db.applyOrderStock(c.id, true, DESIGNS);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'anniversary')).toBe(40);
    expect(supply(db.stockSnapshot(DESIGNS), 'packaging').count).toBe(before);
    // …and un-marking it gives nothing back either, since nothing was taken.
    db.applyOrderStock(c.id, false, DESIGNS);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'anniversary')).toBe(40);
  });

  it('goes NEGATIVE rather than quietly stopping at zero', () => {
    // A negative number is the truthful statement "you have shipped more of
    // these than you told me you had". Clamping would hide it, and then
    // under-count every restock afterwards.
    db.setBoardStock('japanese', 0, DESIGNS);
    const c = orderAtPrinter('japanese');
    db.applyOrderStock(c.id, true, DESIGNS);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'japanese')).toBe(-1);
    db.applyOrderStock(c.id, false, DESIGNS);
    expect(boardCount(db.stockSnapshot(DESIGNS), 'japanese')).toBe(0);
  });

  it('still deducts a board for a design it holds no record of', () => {
    const c = orderAtPrinter('never-seen');
    db.applyOrderStock(c.id, true, DESIGNS);
    const row = db.stockSnapshot(DESIGNS).boards.find((b) => b.theme === 'never-seen');
    expect(row).toMatchObject({ count: -1 });
  });
});

describe('the admin routes', () => {
  const url = (p) => base + p + (p.includes('?') ? '&' : '?') + 'key=dugri-admin';

  it('are closed without the admin key', async () => {
    expect((await fetch(base + '/api/admin/stock')).status).toBe(403);
    const bad = await fetch(base + '/api/admin/stock', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'board', theme: 'anniversary', count: 999 }),
    });
    expect(bad.status).toBe(403);
  });

  it('answer with the whole shelf', async () => {
    const snap = await fetch(url('/api/admin/stock')).then((r) => r.json());
    expect(Array.isArray(snap.boards)).toBe(true);
    expect(snap.supplies.map((s) => s.key)).toEqual(['packaging', 'thankyou', 'stickers']);
  });

  it('take a correction and answer with the shelf, not with an ok', async () => {
    // The page redraws from the server's answer rather than from the number it
    // hoped was stored, so the answer has to be the whole thing.
    const snap = await fetch(url('/api/admin/stock'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'supply', key: 'stickers', count: 64 }),
    }).then((r) => r.json());
    expect(supply(snap, 'stickers').count).toBe(64);
  });

  it('refuse an unknown design, an unknown supply and a missing kind', async () => {
    const put = (body) =>
      fetch(url('/api/admin/stock'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await put({ kind: 'board', theme: 'nope', count: 1 })).status).toBe(404);
    expect((await put({ kind: 'supply', key: 'nope', count: 1 })).status).toBe(404);
    expect((await put({ count: 1 })).status).toBe(400);
  });

  it('the READY toggle is what moves the shelf, both ways', async () => {
    const c = orderAtPrinter('anniversary');
    const before = boardCount(db.stockSnapshot(), 'anniversary');
    const ready = (undo) =>
      fetch(url('/api/admin/collections/' + c.id + '/ready'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(undo ? { undo: true } : {}),
      });

    expect((await ready(false)).status).toBe(200);
    expect(boardCount(db.stockSnapshot(), 'anniversary')).toBe(before - 1);

    expect((await ready(true)).status).toBe(200);
    expect(boardCount(db.stockSnapshot(), 'anniversary')).toBe(before);
  });

  it('an order that could not be marked ready takes nothing', async () => {
    // Not sent to print yet: the store refuses the transition, so the shelf must
    // not move either — the two have to agree or the count drifts.
    const c = db.createCollection('לא נשלח לדפוס', { theme: 'anniversary' });
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    db.markPaid(c.id, { method: 'pelecard' });
    const before = boardCount(db.stockSnapshot(), 'anniversary');
    const res = await fetch(url('/api/admin/collections/' + c.id + '/ready'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(boardCount(db.stockSnapshot(), 'anniversary')).toBe(before);
  });
});
