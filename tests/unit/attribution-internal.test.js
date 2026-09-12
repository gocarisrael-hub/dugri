// @vitest-environment node
//
// The founders' door.
//
// The site answers to two addresses: dugri-israel.co.il, which customers are
// given, and the Railway hostname, which the owner and her partner use on
// purpose so their own browsing and test orders stay out of the numbers. Before
// this, every one of their visits sat in the report — and worse, STUCK there:
// attribution is last-non-direct-touch, so a founder who once opened the site
// through the bio link on the Railway address had every later visit credited to
// that campaign. A row reading "19 visits, 3 checkouts, 0 orders" was mostly the
// two of them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PUBLIC = 'https://dugri-israel.co.il';
const RAILWAY = 'https://dugri-production.up.railway.app';

const dirs = [];
const ORIGINAL = { dir: process.env.DATA_DIR, base: process.env.PUBLIC_BASE_URL };

async function store({ base = PUBLIC } = {}) {
  const dir = path.join(
    os.tmpdir(),
    `dugri-internal-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  vi.resetModules();
  process.env.DATA_DIR = dir;
  if (base) process.env.PUBLIC_BASE_URL = base;
  else delete process.env.PUBLIC_BASE_URL;
  return (await import('../../server/attribution.js')).default;
}

beforeEach(() => {
  process.env.ATTRIBUTION_SAVE_MS = '100000'; // no disk writes during these tests
});
afterEach(() => {
  delete process.env.ATTRIBUTION_SAVE_MS;
  if (ORIGINAL.dir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL.dir;
  if (ORIGINAL.base === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = ORIGINAL.base;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

const bioLink = (host) => `${host}/?utm_source=instagram&utm_medium=social&utm_content=link_in_bio`;

describe('which address a visit landed on', () => {
  it('counts a visit to the public domain, whatever it is tagged with', async () => {
    const a = await store();
    a.record({ kind: 'visit', landing: bioLink(PUBLIC), visitor: 'buyer' });
    const r = a.report({ days: 30 });
    expect(r.totals.visits).toBe(1);
    expect(r.rows[0]).toMatchObject({ source: 'instagram', content: 'link_in_bio', visits: 1 });
    expect(r.internal).toEqual({ visits: 0, checkouts: 0, orders: 0 });
  });

  it('keeps the SAME link opened on the founders’ address out of the report', async () => {
    const a = await store();
    a.record({ kind: 'visit', landing: bioLink(RAILWAY), visitor: 'owner' });
    a.record({ kind: 'checkout', landing: bioLink(RAILWAY), visitor: 'owner' });
    const r = a.report({ days: 30 });
    expect(r.rows).toEqual([]);
    expect(r.totals).toMatchObject({ visits: 0, checkouts: 0, orders: 0 });
    expect(r.internal).toEqual({ visits: 1, checkouts: 1, orders: 0 });
  });

  it('leaves a founder’s test order out of the orders and the revenue', async () => {
    const a = await store();
    a.record({
      kind: 'purchase',
      landing: RAILWAY + '/pay-success.html',
      visitor: 'owner',
      order_no: 'dg-9001',
      value: 139,
    });
    a.record({
      kind: 'purchase',
      landing: PUBLIC + '/pay-success.html',
      visitor: 'buyer',
      order_no: 'dg-9002',
      value: 139,
    });
    const r = a.report({ days: 30 });
    expect(r.totals).toMatchObject({ orders: 1, revenue: 139 });
    expect(r.internal.orders).toBe(1);
  });

  // One founder, several pages: one internal visit, the same way a customer's
  // browse is one visit.
  it('counts one founder browsing as one internal visit, not six', async () => {
    const a = await store();
    for (let i = 0; i < 6; i += 1) {
      a.record({ kind: 'visit', landing: RAILWAY + '/products.html', visitor: 'owner' });
    }
    expect(a.report({ days: 30 }).internal.visits).toBe(1);
  });
});

describe('what was already in the ledger', () => {
  // Events recorded before this change carry no mark and no landing URL. The one
  // that CAN still be recognised is an internal page-to-page move, whose referrer
  // parsed to the Railway hostname — that is the row she actually saw.
  it('drops an old row whose source is the railway hostname', async () => {
    const a = await store();
    a._setEvents([
      {
        t: new Date().toISOString(),
        k: 'visit',
        v: 'owner',
        s: 'dugri-production.up.railway.app',
        m: 'referral',
        c: '',
        ct: '',
      },
      {
        t: new Date().toISOString(),
        k: 'visit',
        v: 'buyer',
        s: 'instagram',
        m: 'social',
        c: '',
        ct: 'link_in_bio',
      },
    ]);
    const r = a.report({ days: 30 });
    expect(r.rows.map((x) => x.source)).toEqual(['instagram']);
    expect(r.internal.visits).toBe(1);
    expect(r.totals.visits).toBe(1);
  });
});

describe('on staging, whose own address is a railway name', () => {
  // The rule is "not the public address", never "railway.app": on staging that
  // hostname IS the site, and treating it as internal would empty the report.
  it('counts its own traffic like any other site', async () => {
    const a = await store({ base: 'https://dugri-staging.up.railway.app' });
    a.record({
      kind: 'visit',
      landing: 'https://dugri-staging.up.railway.app/',
      visitor: 'tester',
    });
    a._setEvents([
      ...a.recent(10),
      {
        t: new Date().toISOString(),
        k: 'visit',
        v: 'tester2',
        s: 'dugri-staging.up.railway.app',
        m: 'referral',
        c: '',
        ct: '',
      },
    ]);
    const r = a.report({ days: 30 });
    expect(r.totals.visits).toBe(2);
    expect(r.internal.visits).toBe(0);
  });
});

describe('with no public address configured', () => {
  // Local development and the test server have no PUBLIC_BASE_URL. Nothing is
  // internal then — a missing variable must never make real traffic vanish.
  it('counts everything, wherever it landed', async () => {
    const a = await store({ base: '' });
    a.record({ kind: 'visit', landing: RAILWAY + '/', visitor: 'someone' });
    a.record({ kind: 'visit', landing: PUBLIC + '/', visitor: 'someone-else' });
    const r = a.report({ days: 30 });
    expect(r.totals.visits).toBe(2);
    expect(r.internal.visits).toBe(0);
  });

  it('judges an address it cannot parse as a customer’s', async () => {
    const a = await store();
    expect(a.isInternalLanding('')).toBe(false);
    expect(a.isInternalLanding('not a url')).toBe(false);
    expect(a.isInternalLanding(PUBLIC + '/index.html')).toBe(false);
    expect(a.isInternalLanding('https://www.dugri-israel.co.il/index.html')).toBe(false);
    expect(a.isInternalLanding(RAILWAY + '/index.html')).toBe(true);
  });
});

describe('the live feed', () => {
  // The feed is how a founder checks that the site is even recording — so their
  // own visit still appears there, marked.
  it('still shows an internal event, flagged', async () => {
    const a = await store();
    a.record({ kind: 'visit', landing: RAILWAY + '/', visitor: 'owner' });
    const [ev] = a.recent(10);
    expect(ev.i).toBe(1);
  });
});
