// @vitest-environment node
//
// "Everything in בדפוס is ready" — one press instead of eleven.
//
// The risk this file exists for is not that the button fails; it is that the
// button reaches an order it should not have. Every message it sends is an email
// and a text to a real customer, and neither can be recalled — so most of what
// follows is about who it must LEAVE ALONE.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';

let app;
let db;
let settings;
let sms;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-ready-batch-'));
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['db.js', 'settings.js', 'sms.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery']) settings.set('pricing', v + '_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  sms = require(path.join(serverDir, 'sms.js'));
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

beforeEach(() => {
  settings.set('sms', 'enabled', true);
  // Start each test from an empty board AND an empty outbox: these assertions
  // are about WHICH orders were taken and WHO was texted, so a leftover from a
  // previous test would mask exactly the mistake they exist to catch.
  for (const c of db.listAllCollections()) db.cancelCollection(c.id);
  sms._reset();
});

async function get(p) {
  const r = await fetch(base + p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function post(p, body) {
  const r = await fetch(base + p + (p.includes('?') ? '&' : '?') + 'key=' + ADMIN_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// An order at a chosen stage. `stage` walks it forward exactly as the admin
// does, so nothing here can be true of an order the real flow cannot produce.
// A delivery order cannot exist without somewhere to deliver to; the store
// refuses one, exactly as the checkout does.
const ADDRESS = { street: 'הרצל 5', city: 'תל אביב', postal: '6100000', apartment: '3' };

function makeOrder({
  name = 'שירה',
  version = 'pickup',
  phone = '0522441334',
  stage = 'printing',
} = {}) {
  const c = db.createCollection(name, { email: name + '@example.com', phone });
  const o = db.setOrder(c.id, c.owner_token, {
    version,
    address: version === 'delivery' ? ADDRESS : undefined,
  });
  // Fail loudly here rather than letting a test quietly assert on an order that
  // was never created.
  if (!o || o.error) throw new Error('could not create order: ' + (o && o.error));
  if (stage === 'unpaid') return db.getCollection(c.id);
  db.markPaid(c.id, { charged_total: 199 });
  if (stage === 'paid') return db.getCollection(c.id);
  db.setOrderSentToPrint(c.id, true);
  if (stage === 'printing') return db.getCollection(c.id);
  if (stage === 'ready') db.setOrderReady(c.id, true);
  return db.getCollection(c.id);
}

const pending = () => sms.list().filter((m) => m.event === 'order_ready');

describe('the preview, before anything is sent', () => {
  it('counts exactly what is sitting in בדפוס, both kinds', async () => {
    makeOrder({ name: 'איסוף', version: 'pickup' });
    makeOrder({ name: 'משלוח', version: 'delivery' });
    const { body } = await get('/api/admin/orders/ready-batch');
    expect(body.count).toBe(2);
    expect(body.pickup).toBe(1);
    expect(body.delivery).toBe(1);
    expect(body.sms_enabled).toBe(true);
  });

  // Each of these is a customer who would be told her game is ready when it is
  // not — or told twice.
  it('leaves out the unpaid, the not-yet-printed, the already-ready and the cancelled', async () => {
    makeOrder({ name: 'לא-שולם', stage: 'unpaid' });
    makeOrder({ name: 'טרם-נשלח', stage: 'paid' });
    makeOrder({ name: 'כבר-מוכן', stage: 'ready' });
    const doomed = makeOrder({ name: 'מבוטל' });
    db.cancelCollection(doomed.id);
    const live = makeOrder({ name: 'בדפוס' });

    const { body } = await get('/api/admin/orders/ready-batch');
    expect(body.count).toBe(1);
    expect(body.orders[0].id).toBe(live.id);
  });

  // Naming them beats counting them: three order numbers tell her which three
  // to phone; "3 without a phone" sends her hunting through the table.
  it('names the orders that will get no text, by order number', async () => {
    const silent = makeOrder({ name: 'בלי-טלפון', phone: '' });
    makeOrder({ name: 'עם-טלפון' });
    const { body } = await get('/api/admin/orders/ready-batch');
    expect(body.no_phone).toEqual([db.orderRef(db.getCollection(silent.id))]);
  });

  it('says when SMS is switched off, so the dialog cannot promise a text', async () => {
    settings.set('sms', 'enabled', false);
    makeOrder({});
    expect((await get('/api/admin/orders/ready-batch')).body.sms_enabled).toBe(false);
  });

  it('is admin-only, and changes nothing by being asked', async () => {
    const c = makeOrder({});
    expect((await fetch(base + '/api/admin/orders/ready-batch')).status).toBe(403);
    await get('/api/admin/orders/ready-batch');
    expect(db.getCollection(c.id).order.ready_at).toBeFalsy();
    expect(pending()).toHaveLength(0);
  });
});

describe('the press', () => {
  it('marks the whole pile ready and queues a text for each', async () => {
    const a = makeOrder({ name: 'א' });
    const b = makeOrder({ name: 'ב', version: 'delivery' });
    const { body } = await post('/api/admin/orders/ready-batch');
    expect(body.marked).toBe(2);
    expect(body.sms_queued).toBe(2);
    expect(db.getCollection(a.id).order.ready_at).toBeTruthy();
    expect(db.getCollection(b.id).order.ready_at).toBeTruthy();
    expect(pending()).toHaveLength(2);
  });

  // The delivery half of the answer: it becomes ready at the same moment as a
  // pickup one, so leaving it behind would only mean pressing it by hand after.
  it('takes delivery orders too, and moves them out of בדפוס', async () => {
    makeOrder({ name: 'משלוח', version: 'delivery' });
    await post('/api/admin/orders/ready-batch');
    expect((await get('/api/admin/orders/ready-batch')).body.count).toBe(0);
  });

  // Booking a courier is a real van and a real charge. It stays a button pressed
  // per order — the same rule the sticker sheet follows.
  it('books no courier on the way past', async () => {
    const d = makeOrder({ name: 'משלוח', version: 'delivery' });
    await post('/api/admin/orders/ready-batch');
    expect(db.getCollection(d.id).order.hfd).toBeUndefined();
  });

  it('marks an order with no phone, and simply queues nothing for it', async () => {
    const silent = makeOrder({ name: 'בלי-טלפון', phone: '' });
    const { body } = await post('/api/admin/orders/ready-batch');
    expect(body.marked).toBe(1);
    expect(body.sms_queued).toBe(0);
    expect(db.getCollection(silent.id).order.ready_at).toBeTruthy();
  });

  it('still marks everything when SMS is switched off entirely', async () => {
    settings.set('sms', 'enabled', false);
    const c = makeOrder({});
    const { body } = await post('/api/admin/orders/ready-batch');
    expect(body.marked).toBe(1);
    expect(body.sms_queued).toBe(0);
    expect(db.getCollection(c.id).order.ready_at).toBeTruthy();
    expect(pending()).toHaveLength(0);
  });

  // A second press — a double-click, a reload, a second tab — must not text
  // anybody twice. The pile is re-derived on the server, so by then it is empty.
  it('does nothing at all on a second press', async () => {
    makeOrder({});
    await post('/api/admin/orders/ready-batch');
    const again = await post('/api/admin/orders/ready-batch');
    expect(again.body.marked).toBe(0);
    expect(pending()).toHaveLength(1);
  });

  it('is admin-only', async () => {
    const c = makeOrder({});
    const r = await fetch(base + '/api/admin/orders/ready-batch', { method: 'POST' });
    expect(r.status).toBe(403);
    expect(db.getCollection(c.id).order.ready_at).toBeFalsy();
  });

  // One order refusing (cancelled in another tab a second ago) must not cost the
  // other ten their press.
  it('finishes the rest when one order is no longer eligible', async () => {
    const doomed = makeOrder({ name: 'ייבוטל' });
    const fine = makeOrder({ name: 'תקין' });
    db.cancelCollection(doomed.id);
    const { body } = await post('/api/admin/orders/ready-batch');
    expect(body.marked).toBe(1);
    expect(body.orders[0].id).toBe(fine.id);
  });
});
