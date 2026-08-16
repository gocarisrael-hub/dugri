// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// WHICH ORDERS GET A STICKER TONIGHT.
//
// Every printed game the customer collects herself gets a label on its box, and
// the owner has been typing that sheet by hand every night. The rule she works
// to is "all the pickup orders that are בדפוס", and each half of it earns its
// place: a delivered order is posted rather than collected, an order not yet
// sent to print has no box to label, and one already marked ready has been
// labelled and handed over.
//
// The SHEET itself — the grid, the padding, the fill order — is held in
// generator/test_pickup_stickers.py against the real renderer. This file is the
// selection and the route around it.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let db;
let app;
let server;
let base;
let dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-stickers-'));
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

// An order at whatever point in the pipeline the test needs.
function order({
  version = 'pickup',
  toPrint = true,
  ready = false,
  theme = 'anniversary',
  title = 'יובל חוגגת 23',
  buyer = 'אופק אוחיון',
  phone = '0527275047',
} = {}) {
  const c = db.createCollection('שירה', {
    theme,
    custom_title: title,
    buyer_name: buyer,
    phone,
  });
  db.setOrder(c.id, c.owner_token, {
    version,
    address:
      version === 'delivery'
        ? { street: 'הרצל 12', city: 'תל אביב', postal: '6100000' }
        : undefined,
  });
  db.markPaid(c.id, { method: 'pelecard' });
  if (toPrint) db.setOrderSentToPrint(c.id, true);
  if (ready) db.setOrderReady(c.id, true);
  return c;
}

const titles = () => app.pickupStickerOrders().map((s) => s.title);

describe('which orders are on tonight’s sheet', () => {
  it('a self-collection order at the printer is', () => {
    order({ title: 'על הסהר' });
    expect(titles()).toContain('על הסהר');
  });

  it('a DELIVERY order is not — it is posted, not collected', () => {
    order({ version: 'delivery', title: 'נשלח בדואר' });
    expect(titles()).not.toContain('נשלח בדואר');
  });

  it('a DIGITAL order is not — there is no box', () => {
    order({ version: 'pdf', title: 'קובץ בלבד' });
    expect(titles()).not.toContain('קובץ בלבד');
  });

  it('an order not yet sent to print is not — there is nothing to label', () => {
    order({ toPrint: false, title: 'עוד לא בדפוס' });
    expect(titles()).not.toContain('עוד לא בדפוס');
  });

  it('an order already marked ready is not — it has been labelled and handed over', () => {
    order({ ready: true, title: 'כבר מוכן' });
    expect(titles()).not.toContain('כבר מוכן');
  });

  it('…and it comes back onto the sheet if that press is undone', () => {
    const c = order({ ready: true, title: 'סומן בטעות' });
    expect(titles()).not.toContain('סומן בטעות');
    db.setOrderReady(c.id, false);
    expect(titles()).toContain('סומן בטעות');
  });

  it('a collection with no order at all is not', () => {
    db.createCollection('בלי הזמנה', { theme: 'anniversary', custom_title: 'לא הוזמן' });
    expect(titles()).not.toContain('לא הוזמן');
  });
});

describe('what each label says', () => {
  it('carries the title, the buyer, the design’s Hebrew name and the phone', () => {
    const c = order({ title: 'סבא חוגג 80', buyer: 'עדי שלייר', phone: '0506767713' });
    const s = app.pickupStickerOrders().find((x) => x.title === 'סבא חוגג 80');
    expect(s).toMatchObject({
      title: 'סבא חוגג 80',
      buyer_name: 'עדי שלייר',
      phone: '0506767713',
      order_no: db.orderRef(db.getCollection(c.id)),
    });
    // The DESIGN is named the way the owner names it — "which of these two boxes
    // is the Paris one" is a question about a picture, not about a theme key.
    expect(s.design).toBe('סנטוריני');
  });

  it('falls back to the honoree’s name when she wrote no title of her own', () => {
    const c = db.createCollection('נועה בובר', { theme: 'anniversary' });
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    db.markPaid(c.id, { method: 'pelecard' });
    db.setOrderSentToPrint(c.id, true);
    expect(titles()).toContain('נועה בובר');
  });

  it('leaves the buyer line blank rather than inventing one', () => {
    // An order that never captured a buyer name prints without that line. The
    // phone underneath still identifies whoever is collecting.
    order({ buyer: '', title: 'בלי שם קונה' });
    const s = app.pickupStickerOrders().find((x) => x.title === 'בלי שם קונה');
    expect(s.buyer_name).toBe('');
    expect(s.phone).toBeTruthy();
  });

  it('names an unknown design by its key rather than by nothing', () => {
    order({ theme: 'no-such-theme', title: 'תבנית לא מוכרת' });
    const s = app.pickupStickerOrders().find((x) => x.title === 'תבנית לא מוכרת');
    expect(s.design).toBe('no-such-theme');
  });

  it('is oldest first, so a sticker can be found in the sheet', () => {
    const all = app.pickupStickerOrders();
    const nums = all.map((s) => Number(String(s.order_no).replace(/\D/g, '')));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  });
});

describe('GET /api/admin/pickup-stickers', () => {
  it('is closed without the admin key', async () => {
    expect((await fetch(base + '/api/admin/pickup-stickers')).status).toBe(403);
  });

  it('says so plainly on a night with nothing to collect', async () => {
    // Not an error page: a quiet night is a normal night, and it should read
    // like one rather than like something that failed.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-stickers-empty-'));
    process.env.DATA_DIR = empty;
    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'index.js']) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
    const freshApp = require(path.join(serverDir, 'index.js'));
    const srv = await new Promise((resolve) => {
      const s = freshApp.listen(0, () => resolve(s));
    });
    const port = srv.address().port;
    const res = await fetch(
      'http://127.0.0.1:' + port + '/api/admin/pickup-stickers?key=dugri-admin'
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('none');
    srv.close();
    fs.rmSync(empty, { recursive: true, force: true });
    process.env.DATA_DIR = dataDir;
  });
});
