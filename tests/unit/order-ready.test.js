// @vitest-environment node
// The admin "מוכן" toggle: the owner presses it when a deck is printed. It flips
// the order to ready, emails the customer, and feeds the "הודפסו" tally on the
// dashboard. Pressing it again takes it back (and the owner asked that marking it
// ready a second time DOES re-send the mail).
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
let notify;
let app;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-ready-'));
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.PUBLIC_BASE_URL = 'https://test.dugri.example';
  for (const f of ['db.js', 'settings.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  for (const v of ['pdf', 'pickup', 'delivery', 'custom'])
    settings.set('pricing', v + '_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
  notify = require(path.join(serverDir, 'notify.js'));
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

async function post(urlPath, body) {
  const res = await realFetch(base + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const KEY = '?key=test-admin-key';
// An order that has NOT been near the print shop yet — the state every new order
// starts in, and the one the "מוכן" gate refuses.
function unsent(name = 'שירה') {
  const c = db.createCollection(name, { email: 'buyer@example.com' });
  db.setOrder(c.id, c.owner_token, { version: 'pickup' });
  return c;
}
// An order already sent to Galor. The default for the ready-toggle tests below,
// because "ready" means "back from print": reaching it any other way is exactly
// what the gate exists to stop, and is covered on its own further down.
function ordered(name = 'שירה') {
  const c = unsent(name);
  db.setOrderSentToPrint(c.id, true);
  return c;
}

describe('setOrderSentToPrint', () => {
  it('marks an order sent to the print shop and records when', () => {
    const c = unsent();
    const r = db.setOrderSentToPrint(c.id, true);
    expect(r.changed).toBe(true);
    expect(db.getCollection(c.id).order.sent_to_print_at).toBeTruthy();
  });

  it('takes it back', () => {
    const c = ordered();
    const r = db.setOrderSentToPrint(c.id, false);
    expect(r.changed).toBe(true);
    expect(db.getCollection(c.id).order.sent_to_print_at).toBe(null);
  });

  it('refuses to un-send an order already marked ready for the customer', () => {
    // "ready" is DEFINED as back from print, so pulling the print stamp out from
    // under it would leave a state the pipeline cannot reach.
    const c = ordered();
    db.setOrderReady(c.id, true);
    const r = db.setOrderSentToPrint(c.id, false);
    expect(r.error).toBe('ready');
    expect(r.changed).toBe(false);
    expect(db.getCollection(c.id).order.sent_to_print_at).toBeTruthy();
  });

  it('reports changed:false on a double-tap', () => {
    const c = ordered();
    expect(db.setOrderSentToPrint(c.id, true).changed).toBe(false);
  });

  it('is null for a collection with no order', () => {
    const c = db.createCollection('בלי הזמנה');
    expect(db.setOrderSentToPrint(c.id, true)).toBe(null);
    expect(db.setOrderSentToPrint('nope', true)).toBe(null);
  });
});

describe('the בדפוס tally', () => {
  it('counts what is OUT at the printer — an order that comes back drops out', () => {
    const before = db.countSentToPrintOrders();
    const a = ordered();
    const b = ordered();
    expect(db.countSentToPrintOrders()).toBe(before + 2);
    // ...back from Galor: still stamped as sent, but no longer at the printer.
    db.setOrderReady(a.id, true);
    expect(db.countSentToPrintOrders()).toBe(before + 1);
    expect(db.getCollection(a.id).order.sent_to_print_at).toBeTruthy();
    expect(b.id).toBeTruthy();
  });
});

describe('the מוכן gate: an order cannot be ready before it went to print', () => {
  it('refuses in the store, and changes nothing', () => {
    const c = unsent();
    const r = db.setOrderReady(c.id, true);
    expect(r.error).toBe('not_sent_to_print');
    expect(r.changed).toBe(false);
    expect(db.getCollection(c.id).order.ready_at).toBeFalsy();
  });

  it('refuses over HTTP with 409 and a message the owner can read', async () => {
    const c = unsent();
    const r = await post('/api/admin/collections/' + c.id + '/ready' + KEY, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('not_sent_to_print');
    expect(r.body.message).toBeTruthy();
  });

  it('sends NO customer email when it refuses', async () => {
    // The whole point of the gate: the one step that cannot be taken back must
    // not fire for a game that never went to the printer.
    const spy = vi.fn(async () => true);
    notify.sendOrderReady = spy;
    try {
      const c = unsent();
      await post('/api/admin/collections/' + c.id + '/ready' + KEY, {});
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete notify.sendOrderReady;
    }
  });

  it('lets it through once the order has been sent to print', async () => {
    const c = unsent();
    await post('/api/admin/collections/' + c.id + '/to-print' + KEY, {});
    const r = await post('/api/admin/collections/' + c.id + '/ready' + KEY, {});
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(true);
  });

  it('never gates the UNDO — a wrong press can always be taken back', () => {
    const c = ordered();
    db.setOrderReady(c.id, true);
    // Contrived, but this is the invariant: even with the print stamp somehow
    // gone, un-marking ready must still work rather than trapping the order.
    db.getCollection(c.id).order.sent_to_print_at = null;
    const r = db.setOrderReady(c.id, false);
    expect(r.changed).toBe(true);
    expect(db.getCollection(c.id).order.ready_at).toBe(null);
  });
});

describe('POST /api/admin/collections/:id/to-print', () => {
  it('requires the admin key', async () => {
    const c = unsent();
    const r = await post('/api/admin/collections/' + c.id + '/to-print?key=wrong', {});
    expect(r.status).toBe(403);
  });

  it('flips to sent and returns both fresh tallies', async () => {
    const c = unsent();
    const r = await post('/api/admin/collections/' + c.id + '/to-print' + KEY, {});
    expect(r.status).toBe(200);
    expect(r.body.sent_to_print).toBe(true);
    expect(r.body.sent_to_print_count).toBe(db.countSentToPrintOrders());
    expect(r.body.ready_count).toBe(db.countReadyOrders());
  });

  it('undoes with {undo:true}', async () => {
    const c = ordered();
    const r = await post('/api/admin/collections/' + c.id + '/to-print' + KEY, { undo: true });
    expect(r.body.sent_to_print).toBe(false);
    expect(db.getCollection(c.id).order.sent_to_print_at).toBe(null);
  });

  it('409s on un-sending an order already marked ready', async () => {
    const c = ordered();
    await post('/api/admin/collections/' + c.id + '/ready' + KEY, {});
    const r = await post('/api/admin/collections/' + c.id + '/to-print' + KEY, { undo: true });
    expect(r.status).toBe(409);
    expect(r.body.message).toBeTruthy();
    expect(db.getCollection(c.id).order.sent_to_print_at).toBeTruthy();
  });

  it('notifies nobody — it is a marker, not a message', async () => {
    const spy = vi.fn(async () => true);
    notify.sendOrderReady = spy;
    try {
      const c = unsent();
      await post('/api/admin/collections/' + c.id + '/to-print' + KEY, {});
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete notify.sendOrderReady;
    }
  });

  it('404s for an unknown collection', async () => {
    const r = await post('/api/admin/collections/nope/to-print' + KEY, {});
    expect(r.status).toBe(404);
  });
});

describe('setOrderReady', () => {
  it('marks an order ready and records when', () => {
    const c = ordered();
    const r = db.setOrderReady(c.id, true);
    expect(r.changed).toBe(true);
    expect(db.getCollection(c.id).order.ready_at).toBeTruthy();
  });

  it('takes it back', () => {
    const c = ordered();
    db.setOrderReady(c.id, true);
    const r = db.setOrderReady(c.id, false);
    expect(r.changed).toBe(true);
    expect(db.getCollection(c.id).order.ready_at).toBe(null);
  });

  it('reports changed:false on a double-tap, so nothing re-fires', () => {
    const c = ordered();
    db.setOrderReady(c.id, true);
    expect(db.setOrderReady(c.id, true).changed).toBe(false);
  });

  it('is null for a collection with no order — nothing to be ready', () => {
    const c = db.createCollection('בלי הזמנה');
    expect(db.setOrderReady(c.id, true)).toBe(null);
    expect(db.setOrderReady('nope', true)).toBe(null);
  });
});

describe('the הודפסו tally', () => {
  it('counts ready orders, and an undo lowers it', () => {
    const before = db.countReadyOrders();
    const a = ordered();
    const b = ordered();
    db.setOrderReady(a.id, true);
    db.setOrderReady(b.id, true);
    expect(db.countReadyOrders()).toBe(before + 2);
    db.setOrderReady(a.id, false);
    expect(db.countReadyOrders()).toBe(before + 1);
  });

  it('is derived from the orders, so it cannot drift from the list', () => {
    const c = ordered();
    db.setOrderReady(c.id, true);
    const counted = db.countReadyOrders();
    const listed = db.listAllCollections().filter((x) => x.order && x.order.ready_at).length;
    expect(counted).toBe(listed);
  });
});

describe('POST /api/admin/collections/:id/ready', () => {
  it('requires the admin key', async () => {
    const c = ordered();
    const r = await post('/api/admin/collections/' + c.id + '/ready?key=wrong', {});
    expect(r.status).toBe(403);
  });

  it('flips to ready and returns the fresh tally', async () => {
    const c = ordered();
    const r = await post('/api/admin/collections/' + c.id + '/ready' + KEY, {});
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(true);
    expect(r.body.ready_count).toBe(db.countReadyOrders());
  });

  it('undoes with {undo:true}', async () => {
    const c = ordered();
    await post('/api/admin/collections/' + c.id + '/ready' + KEY, {});
    const r = await post('/api/admin/collections/' + c.id + '/ready' + KEY, { undo: true });
    expect(r.body.ready).toBe(false);
    expect(db.getCollection(c.id).order.ready_at).toBe(null);
  });

  it('404s for an unknown collection', async () => {
    const r = await post('/api/admin/collections/nope/ready' + KEY, {});
    expect(r.status).toBe(404);
  });

  it('still works when the ready email has not shipped yet', async () => {
    // The mail lives in a separate change. A missing notify.sendOrderReady must
    // never cost the owner the ability to mark an order done.
    const had = notify.sendOrderReady;
    delete notify.sendOrderReady;
    try {
      const c = ordered();
      const r = await post('/api/admin/collections/' + c.id + '/ready' + KEY, {});
      expect(r.status).toBe(200);
      expect(r.body.ready).toBe(true);
    } finally {
      if (had) notify.sendOrderReady = had;
    }
  });

  it('emails the customer on the way in — and AGAIN after an undo + re-press', async () => {
    // The owner asked for the re-send: she only re-presses after fixing
    // something, and the customer should hear the corrected version.
    const spy = vi.fn(async () => true);
    notify.sendOrderReady = spy;
    try {
      const c = ordered();
      await post('/api/admin/collections/' + c.id + '/ready' + KEY, {});
      expect(spy).toHaveBeenCalledTimes(1);
      // A second press with nothing changed must NOT re-fire.
      await post('/api/admin/collections/' + c.id + '/ready' + KEY, {});
      expect(spy).toHaveBeenCalledTimes(1);
      // Undo sends nothing...
      await post('/api/admin/collections/' + c.id + '/ready' + KEY, { undo: true });
      expect(spy).toHaveBeenCalledTimes(1);
      // ...and marking it ready again does send.
      await post('/api/admin/collections/' + c.id + '/ready' + KEY, {});
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      delete notify.sendOrderReady;
    }
  });
});
