// Human-quotable order numbers (DG-1001, DG-1002, …).
//
// A collection id is a UUID: fine as a key, useless the moment a customer has to
// quote it back at us. Every collection therefore also carries a short sequential
// number — assigned at creation, backfilled onto rows that predate the feature,
// and printed by the emails in place of the UUID.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// Load server/db.js fresh against a throwaway DATA_DIR, optionally seeding the
// data file first so the boot-time backfill has something to work on.
function loadDb(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-orderno-'));
  process.env.DATA_DIR = dir;
  if (seed) fs.writeFileSync(path.join(dir, 'dugri-data.json'), JSON.stringify(seed), 'utf8');
  delete require.cache[require.resolve(path.join(serverDir, 'db.js'))];
  delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
  return { db: require(path.join(serverDir, 'db.js')), dir };
}

describe('order numbers', () => {
  it('assigns a short sequential number starting at DG-1001', () => {
    const { db } = loadDb();
    expect(db.createCollection('שירה').order_no).toBe('DG-1001');
    expect(db.createCollection('דנה').order_no).toBe('DG-1002');
    expect(db.createCollection('נועה').order_no).toBe('DG-1003');
  });

  it('never reuses a number after a collection is deleted', () => {
    const { db } = loadDb();
    const a = db.createCollection('שירה');
    db.deleteCollection(a.id);
    // The counter is a high-water mark, not a count of live rows: the next
    // order must not inherit the deleted order's number.
    expect(db.createCollection('דנה').order_no).toBe('DG-1002');
  });

  it('survives a restart — the counter is persisted, not derived from the rows', () => {
    const { db, dir } = loadDb();
    db.createCollection('שירה');
    db.createCollection('דנה');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'dugri-data.json'), 'utf8'));

    process.env.DATA_DIR = dir;
    delete require.cache[require.resolve(path.join(serverDir, 'db.js'))];
    const reloaded = require(path.join(serverDir, 'db.js'));
    expect(saved.order_seq).toBe(1002);
    expect(reloaded.createCollection('נועה').order_no).toBe('DG-1003');
  });

  it('backfills collections created before order numbers existed, oldest first', () => {
    const { db, dir } = loadDb({
      collections: [
        { id: 'c-new', honoree_name: 'חדשה', created_at: '2026-03-02T00:00:00.000Z' },
        { id: 'c-old', honoree_name: 'ישנה', created_at: '2026-01-05T00:00:00.000Z' },
        { id: 'c-mid', honoree_name: 'אמצע', created_at: '2026-02-01T00:00:00.000Z' },
      ],
      words: [],
    });
    // Numbering follows the order the collections were actually placed in, not
    // the order they happen to sit in the file.
    expect(db.getCollection('c-old').order_no).toBe('DG-1001');
    expect(db.getCollection('c-mid').order_no).toBe('DG-1002');
    expect(db.getCollection('c-new').order_no).toBe('DG-1003');
    // ...and the backfill is written to disk, so it happens exactly once.
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'dugri-data.json'), 'utf8'));
    expect(saved.collections.map((c) => c.order_no).sort()).toEqual([
      'DG-1001',
      'DG-1002',
      'DG-1003',
    ]);
    // A collection created after the backfill continues the same sequence.
    expect(db.createCollection('אחרי').order_no).toBe('DG-1004');
  });

  it('leaves already-numbered collections alone', () => {
    const { db } = loadDb({
      collections: [
        { id: 'c-1', order_no: 'DG-1007', created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'c-2', created_at: '2026-01-02T00:00:00.000Z' },
      ],
      words: [],
      order_seq: 1007,
    });
    expect(db.getCollection('c-1').order_no).toBe('DG-1007');
    expect(db.getCollection('c-2').order_no).toBe('DG-1008');
  });

  it('orderRef prints the order number, falling back to the id', () => {
    const { db } = loadDb();
    expect(db.orderRef({ order_no: 'DG-1042', id: 'uuid' })).toBe('DG-1042');
    expect(db.orderRef({ id: 'uuid' })).toBe('uuid');
    expect(db.orderRef(null)).toBe('');
  });
});

describe('emails quote the order number, not the UUID', () => {
  let notify;
  beforeAll(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-orderno-mail-'));
    for (const f of ['settings.js', 'notify.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    notify = require(path.join(serverDir, 'notify.js'));
  });

  const collection = (extra = {}) => ({
    id: '8f3c1a2e-0000-4000-8000-000000000000',
    order_no: 'DG-1042',
    honoree_name: 'שירה',
    design: 'קלאסי',
    owner_token: 'tok',
    order: { version: 'pickup', total: 199, paid: true },
    ...extra,
  });

  it('the owner order email prints the short number', () => {
    const msg = notify.buildPaidMessage(collection(), 'https://dugri.test', {});
    expect(msg.text).toContain('מספר הזמנה: DG-1042');
    // The UUID still appears inside the owner's management link — but never as
    // the order reference itself.
    expect(msg.text).not.toContain('מספר הזמנה: 8f3c1a2e');
  });

  it("the buyer's payment receipt prints the short number", () => {
    const msg = notify.buildBuyerReceipt(collection(), 'https://dugri.test', {
      amountCharged: 199,
    });
    expect(msg.text).toContain('מספר הזמנה: DG-1042');
  });

  it('the buyer order confirmation now carries a reference too', () => {
    // It used to go out with no order reference at all, so a customer replying
    // to it had nothing to quote.
    const msg = notify.buildBuyerConfirmation(collection(), 'https://dugri.test', {});
    expect(msg.text).toContain('מספר הזמנה: DG-1042');
  });

  it('the {orderId} template token resolves to the short number', () => {
    const settings = require(path.join(serverDir, 'settings.js'));
    settings.set('email', 'order_paid', { subject: 'הזמנה {orderId}', body: '{orderId}' });
    try {
      const msg = notify.buildPaidMessage(collection(), 'https://dugri.test', {});
      expect(msg.subject).toBe('הזמנה DG-1042');
    } finally {
      settings.reset('email', 'order_paid');
    }
  });

  it('falls back to the collection id for a row that has no order number', () => {
    const msg = notify.buildPaidMessage(collection({ order_no: undefined }), 'https://dugri.test', {
      amountCharged: 199,
    });
    expect(msg.text).toContain('מספר הזמנה: 8f3c1a2e-0000-4000-8000-000000000000');
  });
});
