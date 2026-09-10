// @vitest-environment node
//
// THE BUYER'S DEVICE DETAILS DO NOT LIVE FOREVER.
//
// Reporting a sale to Meta from the payment callback means holding a few things
// about the browser that the callback cannot see — the buyer's IP, their
// user-agent, Meta's cookies — from the moment the card form opens until the
// report is made. The deletion used to hang entirely off the report finishing,
// which quietly meant that the two most ordinary orders on the site kept those
// details for good:
//
//   • the abandoned checkout. Someone opens the card form and walks away. No
//     payment, so no report, so no deletion — ever. At any normal abandon rate
//     these are MOST of the stored rows, and collections are never purged;
//   • the report that failed transiently and then aged past the seven-day
//     window. Kept deliberately for a retry that will now never happen.
//
// So the details get a bounded life of their own, independent of the report they
// were captured for. These tests drive that directly on the store.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1';

let db;

/** What pay/init captures while the Conversions API is armed. */
function ctx(seenAt) {
  return { ip: '203.0.113.7', ua: UA, fbc: '', fbp: 'fb.1.111.222', fbclid: '', seen_at: seenAt };
}

/** A checkout started: an order, and one PeleCard handshake holding the ctx. */
function startedCheckout({ seenAt = Date.now(), paid = false } = {}) {
  const c = db.createCollection('שירה', { email: 'shira@example.com' });
  db.setOrder(c.id, c.owner_token, { version: 'pdf' });
  db.recordPaymentInit(c.id, {
    paramToken: 'tok-' + c.id.slice(0, 8),
    transactionId: 'tx-1',
    charged_total: 79,
    metaCtx: ctx(seenAt),
  });
  if (paid) db.markPaid(c.id, { charged_total: 79 });
  return c.id;
}

const storedCtx = (id) => {
  const o = db.getCollection(id).order;
  return o.pelecard && o.pelecard.meta_ctx;
};

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-capi-ret-'));
  for (const f of ['db.js', 'settings.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  const settings = require(path.join(serverDir, 'settings.js'));
  settings.set('pricing', 'pdf_enabled', true);
  db = require(path.join(serverDir, 'db.js'));
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('an abandoned checkout does not keep the buyer’s ip forever', () => {
  it('drops the details a day after the buyer walked away from the card form', () => {
    const id = startedCheckout({ seenAt: Date.now() - 25 * HOUR });
    // Nothing here will EVER finish a report: the order was never paid, so the
    // only deletion the old code had could not be reached.
    expect(db.getCollection(id).order.paid).toBeFalsy();
    expect(storedCtx(id).ip).toBe('203.0.113.7');

    expect(db.sweepMetaCtx()).toBe(1);
    expect(storedCtx(id)).toBeUndefined();
    // And the payment handshake itself survives — the sessions are what a late
    // callback verifies its amount against.
    expect(db.getCollection(id).order.pelecard.sessions).toHaveLength(1);
    expect(JSON.stringify(db.getCollection(id).order)).not.toContain(UA);
  });

  it('leaves a checkout that is still in progress alone', () => {
    const id = startedCheckout({ seenAt: Date.now() - 5 * 60 * 1000 });
    expect(db.sweepMetaCtx()).toBe(0);
    expect(storedCtx(id).ua).toBe(UA);
  });

  it('treats a row with no usable timestamp as already expired', () => {
    const id = startedCheckout();
    delete db.getCollection(id).order.pelecard.meta_ctx.seen_at;
    // The failure mode of a missing stamp must be deleting the data, never
    // keeping it indefinitely.
    expect(db.sweepMetaCtx()).toBe(1);
    expect(storedCtx(id)).toBeUndefined();
  });
});

describe('a paid order keeps them only as long as the retry can use them', () => {
  it('keeps them while the report is still owed and still sendable', () => {
    const id = startedCheckout({ seenAt: Date.now() - 2 * DAY, paid: true });
    db.claimMetaReport(id);
    db.finishMetaReport(id, { error: 'timeout' });
    // Transient: claimable again, and the retry has no other source for these.
    expect(db.staleMetaReports()).toContain(id);
    expect(db.sweepMetaCtx()).toBe(0);
    expect(storedCtx(id).ip).toBe('203.0.113.7');
  });

  it('drops them once the report has aged out of the sweep window', () => {
    const id = startedCheckout({ seenAt: Date.now() - 9 * DAY, paid: true });
    db.claimMetaReport(id);
    db.finishMetaReport(id, { error: 'timeout' });
    db.getCollection(id).order.paid_at = new Date(Date.now() - 9 * DAY).toISOString();
    // Nothing will ever send this now: too old for Meta to accept, so too old to
    // sweep — which is exactly when the details stop having any purpose at all.
    expect(db.staleMetaReports()).not.toContain(id);
    expect(db.sweepMetaCtx()).toBe(1);
    expect(storedCtx(id)).toBeUndefined();
  });

  it('still drops them the moment Meta accepts the sale', () => {
    const id = startedCheckout({ paid: true });
    db.claimMetaReport(id);
    db.finishMetaReport(id, { ok: true });
    expect(storedCtx(id)).toBeUndefined();
  });
});

describe('the boot sweep does not write the store once per order', () => {
  it('claims the whole batch under a single write', () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const id = startedCheckout({ paid: true });
      db.getCollection(id).order.meta_report = { error: 'timeout' };
      ids.push(id);
    }
    const stale = db.staleMetaReports();
    for (const id of ids) expect(stale).toContain(id);

    // One whole-store write per claim is what this replaces: at real order
    // counts that is hundreds of milliseconds each, back to back, on a box that
    // is already serving.
    const write = vi.spyOn(fs, 'writeFileSync');
    const claimed = db.claimMetaReports(stale);
    expect(claimed.length).toBe(stale.length);
    expect(write).toHaveBeenCalledTimes(1);

    // And they really are claimed — a second pass gets nothing.
    for (const id of ids) expect(db.getCollection(id).order.meta_report.at).toBeTruthy();
    expect(db.claimMetaReports(stale)).toEqual([]);
  });

  it('writes nothing at all when there is nothing to claim', () => {
    const write = vi.spyOn(fs, 'writeFileSync');
    expect(db.claimMetaReports([])).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});

// "The token was wrong and I fixed it" is a real recovery path, and a mark that
// nothing can clear turns the most likely arming mistake into lost sales.
describe('a report written off as final can be handed back', () => {
  it('makes a permanently-failed order claimable and sweepable again', () => {
    const id = startedCheckout({ paid: true });
    db.claimMetaReport(id);
    db.finishMetaReport(id, { permanent: true, error: 'Invalid OAuth access token' });
    expect(db.claimMetaReport(id)).toBe(false);
    expect(db.staleMetaReports()).not.toContain(id);

    expect(db.clearPermanentMetaReports({ id })).toEqual([id]);
    expect(db.getCollection(id).order.meta_report.permanent).toBeUndefined();
    expect(db.getCollection(id).order.meta_report.error).toContain('Invalid OAuth access token');
    expect(db.staleMetaReports()).toContain(id);
    expect(db.claimMetaReport(id)).toBe(true);
  });

  it('never touches a report that succeeded, or one still being tried', () => {
    const ok = startedCheckout({ paid: true });
    db.claimMetaReport(ok);
    db.finishMetaReport(ok, { ok: true });
    const flight = startedCheckout({ paid: true });
    db.claimMetaReport(flight);

    expect(db.clearPermanentMetaReports()).not.toContain(ok);
    expect(db.clearPermanentMetaReports()).not.toContain(flight);
    expect(db.getCollection(ok).order.meta_report.ok).toBe(true);
  });
});

// The first cut of this feature stamped `meta_reported_at` — a flag that says a
// send was CLAIMED, with nothing to say whether Meta ever answered. The current
// code reads such an order as never-claimed, so one reload of the confirmation
// page would send Meta a sale it already has.
describe('an order stamped by the old build is not reported twice', () => {
  it('carries the old flag across as a finished report', () => {
    const id = startedCheckout({ paid: true });
    const stamped = new Date(Date.now() - 3 * DAY).toISOString();
    delete db.getCollection(id).order.meta_report;
    db.getCollection(id).order.meta_reported_at = stamped;

    expect(db.migrateMetaReports()).toBeGreaterThanOrEqual(1);
    expect(db.getCollection(id).order.meta_report).toEqual({ at: stamped, ok: true });
    expect(db.getCollection(id).order.meta_reported_at).toBeUndefined();
    // Which is what stops the second send.
    expect(db.claimMetaReport(id)).toBe(false);
    expect(db.staleMetaReports()).not.toContain(id);
    // And it is idempotent: nothing left to do, nothing written.
    const write = vi.spyOn(fs, 'writeFileSync');
    expect(db.migrateMetaReports()).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });
});
