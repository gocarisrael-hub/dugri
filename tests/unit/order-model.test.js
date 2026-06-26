import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// server/db.js is CommonJS and writes a JSON file under DATA_DIR. Point it at a
// throwaway temp dir (set before require) so the test never touches real data.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDbPath = path.join(__dirname, '..', '..', 'server', 'db.js');

let db;
let ORDER_PRICES;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-order-'));
  db = require(serverDbPath);
  ORDER_PRICES = db.ORDER_PRICES;
});

function freshCollection() {
  return db.createCollection('בדיקה', { design: 'יום הולדת', color: 'ירוק' });
}

describe('setOrder', () => {
  it('exports ORDER_PRICES with the agreed totals', () => {
    expect(ORDER_PRICES).toEqual({ pdf: 79, pickup: 149, delivery: 199 });
  });

  it('prices pdf/pickup/delivery from ORDER_PRICES', () => {
    const c1 = freshCollection();
    expect(db.setOrder(c1.id, c1.owner_token, { version: 'pdf' }).total).toBe(79);

    const c2 = freshCollection();
    expect(db.setOrder(c2.id, c2.owner_token, { version: 'pickup' }).total).toBe(149);

    const c3 = freshCollection();
    const o3 = db.setOrder(c3.id, c3.owner_token, {
      version: 'delivery',
      address: { street: 'הרצל 1', city: 'תל אביב', postal: '6100000' },
    });
    expect(o3.total).toBe(199);
  });

  it('stores design/color on the collection and the order is unpaid by default', () => {
    const c = freshCollection();
    expect(c.design).toBe('יום הולדת');
    expect(c.color).toBe('ירוק');
    const o = db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    expect(o.paid).toBe(false);
    expect(o.paid_at).toBe(null);
    expect(o.address).toBe(null);
  });

  it('rejects a wrong owner token', () => {
    const c = freshCollection();
    const r = db.setOrder(c.id, 'not-the-token', { version: 'pdf' });
    expect(r.error).toBe('forbidden');
    expect(db.getCollection(c.id).order).toBe(null);
  });

  it('rejects an unknown version', () => {
    const c = freshCollection();
    const r = db.setOrder(c.id, c.owner_token, { version: 'gold' });
    expect(r.error).toBe('bad version');
  });

  it('requires street/city/postal for delivery', () => {
    const c = freshCollection();
    expect(db.setOrder(c.id, c.owner_token, { version: 'delivery' }).error).toBe(
      'address required'
    );
    expect(
      db.setOrder(c.id, c.owner_token, {
        version: 'delivery',
        address: { street: 'הרצל 1', city: 'תל אביב' },
      }).error
    ).toBe('address required');
  });

  it('keeps optional apartment/floor on a delivery address', () => {
    const c = freshCollection();
    const o = db.setOrder(c.id, c.owner_token, {
      version: 'delivery',
      address: { street: 'הרצל 1', city: 'תל אביב', postal: '6100000', apartment: '4', floor: '2' },
    });
    expect(o.address.apartment).toBe('4');
    expect(o.address.floor).toBe('2');
  });
});

describe('chasers add-on', () => {
  it('stores chasers as a boolean when requested', () => {
    const c = db.createCollection('בדיקה', { design: 'יום הולדת', chasers: true });
    expect(c.chasers).toBe(true);
    // surfaced by listAllCollections (which spreads the collection)
    const listed = db.listAllCollections().find((x) => x.id === c.id);
    expect(listed.chasers).toBe(true);
  });

  it('defaults chasers to false and coerces truthy/falsy input', () => {
    const off = db.createCollection('בדיקה');
    expect(off.chasers).toBe(false);
    const coerced = db.createCollection('בדיקה', { chasers: 'yes' });
    expect(coerced.chasers).toBe(true);
    const zero = db.createCollection('בדיקה', { chasers: 0 });
    expect(zero.chasers).toBe(false);
  });
});

describe('markPaid', () => {
  it('flips paid and sets paid_at', () => {
    const c = freshCollection();
    db.setOrder(c.id, c.owner_token, { version: 'pdf' });
    expect(db.markPaid(c.id)).toBe(true);
    const order = db.getCollection(c.id).order;
    expect(order.paid).toBe(true);
    expect(typeof order.paid_at).toBe('string');
  });

  it('returns false when there is no order', () => {
    const c = freshCollection();
    expect(db.markPaid(c.id)).toBe(false);
  });
});
