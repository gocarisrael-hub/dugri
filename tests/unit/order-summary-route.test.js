// @vitest-environment node
// GET /api/collections/:id/summary — the payment confirmation page's "here is
// what you just bought" feed. Owner-token gated (it carries the amount actually
// charged, which the shared collect link must never leak to invited friends),
// and it hands the page everything it needs to re-render the buyer's own card.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;
let server;
let base;
let db;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-summary-'));
  for (const f of ['settings.js', 'db.js', 'notify.js', 'index.js']) {
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

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.DATA_DIR;
});

function paidCollection() {
  const c = db.createCollection('שירה', {
    design: 'קלאסי',
    color: 'ורוד',
    theme: 'birthday-girls',
    extra_fields: { AGE: '30' },
    chasers: true,
    gender: 'female',
  });
  db.setOrder(c.id, c.owner_token, { version: 'pickup' });
  db.markPaid(c.id, { method: 'card', charged_total: 149, coupon: 'SAVE25', discount_pct: 25 });
  return db.getCollection(c.id);
}

const summary = (id, k) =>
  fetch(base + '/api/collections/' + id + '/summary' + (k ? '?k=' + encodeURIComponent(k) : ''));

describe('GET /api/collections/:id/summary', () => {
  it('returns the order number, package, charged amount and design', async () => {
    const c = paidCollection();
    const res = await summary(c.id, c.owner_token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order_no).toBe(c.order_no);
    expect(body.order_no).toMatch(/^DG-\d+$/);
    expect(body.honoree_name).toBe('שירה');
    expect(body.design).toBe('קלאסי');
    expect(body.color).toBe('ורוד');
    expect(body.order.version).toBe('pickup');
    expect(body.order.version_label).toBe('איסוף עצמי');
    expect(body.order.description).toContain('איסוף עצמי');
    expect(body.order.paid).toBe(true);
    // The PACKAGE price and the amount actually CHARGED are both present, and
    // they differ — a 25% coupon was applied.
    expect(body.order.total).toBe(199);
    expect(body.order.charged).toBe(149);
    expect(body.order.coupon).toBe('SAVE25');
  });

  it('hands the page the exact inputs needed to re-render the buyer’s own card', async () => {
    const c = paidCollection();
    const body = await (await summary(c.id, c.owner_token)).json();
    // Field-for-field what POST /api/preview accepts, so the confirmation shows
    // the real card rather than a stock product photo.
    expect(body.preview).toEqual({
      theme: 'birthday-girls',
      name: 'שירה',
      extra_fields: { AGE: '30' },
      word_font: null,
      title: null,
      chasers: true,
      // The honoree's gender is one of those inputs: a Hebrew title carrying a
      // {m:בן|f:בת} marker renders a different word per gender, so leaving it out
      // would show a card whose title differs from the one being printed.
      gender: 'female',
    });
  });

  it('is owner-gated — the collection link alone is not enough', async () => {
    const c = paidCollection();
    expect((await summary(c.id)).status).toBe(403);
    expect((await summary(c.id, 'wrong-token')).status).toBe(403);
  });

  it('404s for an unknown collection', async () => {
    expect((await summary('no-such-id', 'tok')).status).toBe(404);
  });

  it('reports no charge for an order that has not been paid', async () => {
    const c = db.createCollection('דנה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    const body = await (await summary(c.id, c.owner_token)).json();
    expect(body.order.paid).toBe(false);
    expect(body.order.total).toBe(199);
    // null, not 0 — "not charged yet" and "charged nothing" are different states.
    expect(body.order.charged).toBe(null);
  });

  it('reads a fully-free (100%-coupon) order as charged 0, not as unknown', async () => {
    const c = db.createCollection('נועה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    db.markPaid(c.id, { method: 'coupon', charged_total: 0, coupon: 'FREE100' });
    const body = await (await summary(c.id, c.owner_token)).json();
    expect(body.order.charged).toBe(0);
  });

  it('still answers for a collection with no order and no theme', async () => {
    const c = db.createCollection('אורח');
    const body = await (await summary(c.id, c.owner_token)).json();
    expect(body.order).toBe(null);
    expect(body.preview).toBe(null);
    expect(body.order_no).toMatch(/^DG-\d+$/);
  });
});
