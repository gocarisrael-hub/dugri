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
// the owner has been typing that sheet by hand every night. She describes the
// batch as "all the pickup orders that are בדפוס" — and taking that literally
// (the sent-to-print STAMP) matched nothing at all: measured against the real
// orders, 135 carry that stamp and every one of them is also already marked
// ready, because the two get pressed together. Her בדפוס is the pile going to
// the printer tonight, not a state an order rests in.
//
// So the rule is the one the label itself implies — THE BOX EXISTS AND HAS NOT
// GONE OUT: a paid self-collection order whose deck has been produced and which
// is not yet marked ready.
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
  shipment = null,
  shipmentCancelled = false,
  paid = true,
  produced = true,
  toPrint = false,
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
  db.setOrder(
    c.id,
    c.owner_token,
    {
      version,
      address:
        version === 'delivery'
          ? { street: 'הרצל 12', city: 'תל אביב', postal: '6100000' }
          : undefined,
    },
    // As the owner, because a fresh settings store has the delivery version
    // switched OFF and a public setOrder would be refused ('version
    // unavailable') — which is how the delivery case here used to pass while
    // never actually creating a delivery order.
    { admin: version === 'delivery' }
  );
  if (paid) db.markPaid(c.id, { method: 'pelecard' });
  // The deck having been BUILT is what makes a box to label. This is the state
  // the generator leaves behind on a successful run.
  if (produced) {
    db.setProduction(c.id, { state: 'generated', pages: 208 });
    // The sheet IS the הופקו pile, and nothing reaches that pile without the
    // owner releasing it (server/db.setProductionReleased). A deck that is built
    // but not released has its own case below.
    db.setProductionReleased(c.id, true);
  }
  // A booked courier parcel — the only thing that gives a DELIVERY order a
  // label, since the sticker for one is HFD's and not ours.
  if (shipment) {
    db.setHfdShipment(c.id, {
      shipment_number: String(shipment),
      rand_number: '65678' + shipment,
      tracking_url: 'https://run.hfd.co.il/info/65678' + shipment,
      sent_at: '2026-09-01T00:00:00.000Z',
      cancelled_at: shipmentCancelled ? '2026-09-02T00:00:00.000Z' : null,
    });
  }
  if (toPrint) db.setOrderSentToPrint(c.id, true);
  if (ready) db.setOrderReady(c.id, true);
  return c;
}

const batchTitles = () => app.stickerBatch().map((e) => e.label.title);
const entryFor = (title) => app.stickerBatch().find((e) => e.label.title === title);

const titles = () => app.pickupStickerOrders().map((s) => s.title);

describe('which orders are on tonight’s sheet', () => {
  it('a produced self-collection order is — that is the pile going to the printer', () => {
    order({ title: 'על הסהר' });
    expect(titles()).toContain('על הסהר');
  });

  // The sheet is ONE stage — the pile about to leave for Galor — not everything
  // built and not yet handed over. An order already at the printer had its
  // sticker printed with that batch; printing it again is a duplicate label for
  // a box that already carries one.
  it('an order already SENT to print is not — its sticker went with the batch', () => {
    order({ toPrint: true, title: 'כבר נשלח לדפוס' });
    expect(titles()).not.toContain('כבר נשלח לדפוס');
  });

  it('…and it returns to the sheet if that stamp is taken back', () => {
    const c = order({ toPrint: true, title: 'הוחזר מהדפוס' });
    expect(titles()).not.toContain('הוחזר מהדפוס');
    db.setOrderSentToPrint(c.id, false);
    expect(titles()).toContain('הוחזר מהדפוס');
  });

  it('a DELIVERY order is not — it is posted, not collected', () => {
    order({ version: 'delivery', title: 'נשלח בדואר' });
    expect(titles()).not.toContain('נשלח בדואר');
  });

  it('a DIGITAL order is not — there is no box', () => {
    order({ version: 'pdf', title: 'קובץ בלבד' });
    expect(titles()).not.toContain('קובץ בלבד');
  });

  it('an order whose deck has not been built is not — there is nothing to label yet', () => {
    // Still collecting words, or closed and not yet run: no box exists.
    order({ produced: false, title: 'עוד לא הופק' });
    expect(titles()).not.toContain('עוד לא הופק');
  });

  it('an UNPAID order is not — it is not being made', () => {
    order({ paid: false, produced: false, title: 'לא שולם' });
    expect(titles()).not.toContain('לא שולם');
  });

  it('an order already marked ready is not — it has been labelled and handed over', () => {
    order({ ready: true, toPrint: true, title: 'כבר מוכן' });
    expect(titles()).not.toContain('כבר מוכן');
  });

  it('…and it comes back onto the sheet if BOTH presses are undone', () => {
    const c = order({ ready: true, toPrint: true, title: 'סומן בטעות' });
    expect(titles()).not.toContain('סומן בטעות');
    db.setOrderReady(c.id, false);
    // Still off the sheet: undoing "ready" leaves it at the printer, which is
    // the batch whose stickers are already printed.
    expect(titles()).not.toContain('סומן בטעות');
    db.setOrderSentToPrint(c.id, false);
    expect(titles()).toContain('סומן בטעות');
  });

  it('a CANCELLED order is not', () => {
    const c = order({ title: 'בוטלה' });
    db.cancelCollection(c.id);
    expect(titles()).not.toContain('בוטלה');
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
    db.setProduction(c.id, { state: 'generated', pages: 208 });
    db.setProductionReleased(c.id, true);
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

// THE PILE IS MIXED, AND SO IS THE PDF.
//
// A produced box either gets collected or gets carried, and the label differs:
// ours (drawn here) for a collection, HFD's own courier sticker for a delivery.
// The owner was getting the first from this button and the second from HFD's
// website; the batch below is both, in the order the orders table shows them.
describe('the delivery half of tonight’s batch', () => {
  it('a produced delivery order with a booked parcel is on it, as the courier’s', () => {
    order({ version: 'delivery', shipment: '95314644', title: 'נוסע במשלוח' });
    const e = entryFor('נוסע במשלוח');
    expect(e).toBeTruthy();
    expect(e.kind).toBe('delivery');
    expect(e.shipment_number).toBe('95314644');
    // …and NOT among the labels this server draws: HFD prints that one.
    expect(titles()).not.toContain('נוסע במשלוח');
  });

  it('one with no shipment booked is listed but has nothing to fetch', () => {
    // It stays in the batch on purpose: the caller has to be able to name it
    // back to the owner ("these got no sticker"), which it cannot do for an
    // order that was filtered away.
    order({ version: 'delivery', title: 'בלי משלוח' });
    const e = entryFor('בלי משלוח');
    expect(e.kind).toBe('delivery');
    expect(e.shipment_number).toBeNull();
  });

  it('one whose parcel was CANCELLED has nothing to fetch either', () => {
    // The number is kept as history; a stood-down van has no label to print.
    order({
      version: 'delivery',
      shipment: '95314647',
      shipmentCancelled: true,
      title: 'משלוח בוטל',
    });
    expect(entryFor('משלוח בוטל').shipment_number).toBeNull();
  });

  it('a DIGITAL order is on neither list — there is no box', () => {
    order({ version: 'pdf', title: 'קובץ בלבד 2' });
    expect(batchTitles()).not.toContain('קובץ בלבד 2');
  });

  it('the batch is oldest first, collections and deliveries together', () => {
    // The PDF has to read down the owner's list. Sorting the two kinds apart
    // would mean counting boxes in one order and stickers in another.
    const all = app.stickerBatch();
    const nums = all.map((e) => Number(String(e.label.order_no).replace(/\D/g, '')));
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(new Set(all.map((e) => e.kind))).toEqual(new Set(['pickup', 'delivery']));
  });

  it('the self-collection list is exactly the pickups of that batch', () => {
    // Derived, not re-filtered: the two must not drift into disagreeing about
    // what tonight's pile is.
    const fromBatch = app
      .stickerBatch()
      .filter((e) => e.kind === 'pickup')
      .map((e) => e.label);
    expect(app.pickupStickerOrders()).toEqual(fromBatch);
  });
});

// WHAT GOES INTO THE PDF, in what order. The generator takes our labels as
// fields and the courier's as a file it merges in whole, and the sequence of
// this list IS the page order of the download.
describe('the batch handed to the renderer', () => {
  const pickup = (n) => ({ id: 'p' + n, kind: 'pickup', label: { title: 'איסוף ' + n } });
  const delivery = (n) => ({
    id: 'd' + n,
    kind: 'delivery',
    shipment_number: '9531464' + n,
    label: { title: 'משלוח ' + n },
  });

  it('keeps table order, ours as fields and HFD’s as the file', () => {
    const entries = app.stickerEntries(
      [pickup(1), delivery(2), pickup(3)],
      new Map([['d2', '/tmp/hfd-95314642.pdf']])
    );
    expect(entries).toEqual([
      { title: 'איסוף 1' },
      { pdf: '/tmp/hfd-95314642.pdf' },
      { title: 'איסוף 3' },
    ]);
  });

  it('drops a delivery whose label never came down, and keeps the rest', () => {
    // One sticker HFD would not hand over must not cost the owner the other
    // twenty; the page tells her which parcels to fetch by hand.
    const entries = app.stickerEntries([delivery(1), pickup(2), delivery(3)], new Map());
    expect(entries).toEqual([{ title: 'איסוף 2' }]);
  });
});

describe('GET /api/admin/pickup-stickers', () => {
  it('is closed without the admin key', async () => {
    expect((await fetch(base + '/api/admin/pickup-stickers')).status).toBe(403);
  });

  it('the batch also answers on its own name', async () => {
    // /api/admin/pickup-stickers is what the button shipped as and what the
    // staff allowlist names; /api/admin/stickers is what it does now that the
    // pile is mixed. Both reach the same handler.
    expect((await fetch(base + '/api/admin/stickers')).status).toBe(403);
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

  it('says WHY when the only boxes waiting are unbooked deliveries', async () => {
    // Nothing to print is not the same as nothing to do: these need one press of
    // שלח ל-HFD each, and a flat "there are none tonight" would hide that.
    const only = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-stickers-unbooked-'));
    process.env.DATA_DIR = only;
    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'index.js']) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
    const freshDb = require(path.join(serverDir, 'db.js'));
    const freshApp = require(path.join(serverDir, 'index.js'));
    const c = freshDb.createCollection('שירה', {
      theme: 'anniversary',
      custom_title: 'ממתין למשלוח',
      buyer_name: 'אופק',
      phone: '0527275047',
    });
    freshDb.setOrder(
      c.id,
      c.owner_token,
      { version: 'delivery', address: { street: 'הרצל 12', city: 'תל אביב', postal: '6100000' } },
      { admin: true }
    );
    freshDb.markPaid(c.id, { method: 'pelecard' });
    freshDb.setProduction(c.id, { state: 'generated', pages: 208 });
    freshDb.setProductionReleased(c.id, true);
    const srv = await new Promise((resolve) => {
      const s2 = freshApp.listen(0, () => resolve(s2));
    });
    const res = await fetch(
      'http://127.0.0.1:' + srv.address().port + '/api/admin/stickers?key=dugri-admin'
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('none');
    expect(body.message).toContain('HFD');
    expect(body.unbooked).toEqual([freshDb.orderRef(freshDb.getCollection(c.id))]);
    srv.close();
    fs.rmSync(only, { recursive: true, force: true });
    process.env.DATA_DIR = dataDir;
  });
});
