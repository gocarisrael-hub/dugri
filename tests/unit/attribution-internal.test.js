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
const ORIGINAL = {
  dir: process.env.DATA_DIR,
  base: process.env.PUBLIC_BASE_URL,
  hosts: process.env.ATTRIBUTION_INTERNAL_HOSTS,
  customers: process.env.ATTRIBUTION_CUSTOMER_HOSTS,
};

async function store({ base = PUBLIC, hosts, customers } = {}) {
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
  if (hosts === undefined) delete process.env.ATTRIBUTION_INTERNAL_HOSTS;
  else process.env.ATTRIBUTION_INTERNAL_HOSTS = hosts;
  if (customers === undefined) delete process.env.ATTRIBUTION_CUSTOMER_HOSTS;
  else process.env.ATTRIBUTION_CUSTOMER_HOSTS = customers;
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
  if (ORIGINAL.hosts === undefined) delete process.env.ATTRIBUTION_INTERNAL_HOSTS;
  else process.env.ATTRIBUTION_INTERNAL_HOSTS = ORIGINAL.hosts;
  if (ORIGINAL.customers === undefined) delete process.env.ATTRIBUTION_CUSTOMER_HOSTS;
  else process.env.ATTRIBUTION_CUSTOMER_HOSTS = ORIGINAL.customers;
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
    expect(r.internal).toMatchObject({ visits: 0, checkouts: 0, orders: 0, revenue: 0 });
  });

  it('keeps the SAME link opened on the founders’ address out of the report', async () => {
    const a = await store();
    a.record({ kind: 'visit', landing: bioLink(RAILWAY), visitor: 'owner' });
    a.record({ kind: 'checkout', landing: bioLink(RAILWAY), visitor: 'owner' });
    const r = a.report({ days: 30 });
    expect(r.rows).toEqual([]);
    expect(r.totals).toMatchObject({ visits: 0, checkouts: 0, orders: 0 });
    expect(r.internal).toMatchObject({ visits: 1, checkouts: 1, orders: 0, revenue: 0 });
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

// Every purchase in this ledger is a PAID order — /api/track records nothing for
// an order it cannot see money on — so whatever this rule calls internal is real
// money held out of the report. That is what makes "any address but the public
// one" too wide a net to hold it in.
describe('an address that is nobody’s back door', () => {
  it('counts a paid order that landed on a host the rule does not own', async () => {
    const a = await store({ base: 'https://dugri-isreal.co.il' }); // the domain, mistyped
    a.record({
      kind: 'visit',
      landing: bioLink(PUBLIC),
      visitor: 'buyer',
    });
    a.record({
      kind: 'purchase',
      landing: PUBLIC + '/pay-success.html',
      visitor: 'buyer',
      order_no: 'dg-9003',
      value: 139,
    });
    const r = a.report({ days: 30 });
    // A stale PUBLIC_BASE_URL used to mis-build links. It must not silence the
    // whole report on top of that.
    expect(r.totals).toMatchObject({ visits: 1, orders: 1, revenue: 139 });
    expect(r.internal).toMatchObject({ visits: 0, orders: 0, revenue: 0 });
  });

  it('is unmoved by an address on the far side of the internet', async () => {
    const a = await store();
    expect(a.isInternalLanding('https://some-blog.example.com/post')).toBe(false);
    expect(a.isInternalLanding('http://10.0.0.4:3000/')).toBe(false);
  });

  it('treats a host named by hand as ours', async () => {
    const a = await store({ hosts: 'old.dugri.co.il, 10.0.0.4' });
    expect(a.isInternalLanding('https://old.dugri.co.il/products.html')).toBe(true);
    expect(a.isInternalLanding('http://10.0.0.4:3000/')).toBe(true);
    expect(a.internalHosts()).toEqual(['old.dugri.co.il', '10.0.0.4', '*.up.railway.app']);
  });

  it('names no address at all when there is no public one to differ from', async () => {
    const a = await store({ base: '' });
    expect(a.internalHosts()).toEqual([]);
  });
});

describe('what the page is told about the money it cannot see', () => {
  // orders alone say "one sale went somewhere". The shekels are what let her tell
  // a founder's test from a customer who used the address that used to be in the
  // bio, and add it back by hand.
  it('reports the revenue it set aside, not just the count', async () => {
    const a = await store();
    a.record({
      kind: 'purchase',
      landing: RAILWAY + '/pay-success.html',
      visitor: 'owner',
      order_no: 'dg-9101',
      value: 139,
    });
    a.record({
      kind: 'purchase',
      landing: RAILWAY + '/pay-success.html',
      visitor: 'owner',
      order_no: 'dg-9102',
      value: 79.5,
    });
    const r = a.report({ days: 30 });
    expect(r.internal).toMatchObject({ orders: 2, revenue: 218.5 });
    expect(r.internal.hosts).toContain('*.up.railway.app');
    expect(r.totals).toMatchObject({ orders: 0, revenue: 0 });
  });
});

describe('somebody else’s Railway-hosted page', () => {
  // The railway heuristic exists for rows written BEFORE this change, which carry
  // no landing URL. Applied to a new event it would swallow a genuine referral
  // from a stranger's Railway app — a real visitor, bucketed as ours and invisible
  // for good.
  it('is a referral like any other, not one of ours', async () => {
    const a = await store();
    a.record({
      kind: 'visit',
      landing: PUBLIC + '/',
      referrer: 'https://someone-else.up.railway.app/post',
      visitor: 'stranger',
    });
    const r = a.report({ days: 30 });
    expect(r.rows.map((x) => x.source)).toEqual(['someone-else.up.railway.app']);
    expect(r.totals.visits).toBe(1);
    expect(r.internal.visits).toBe(0);
  });

  it('records the judgement on the event, which is what fences the guess off', async () => {
    const a = await store();
    a.record({ kind: 'visit', landing: PUBLIC + '/', visitor: 'buyer' });
    expect(a.recent(10)[0].i).toBe(0);
  });
});

describe('a malformed row in the ledger', () => {
  // The ledger is a JSON file on a volume and load() validates no kinds. Indexing
  // a per-kind map by e.k answered for 'constructor' with a function that has no
  // .has — one such row took /api/admin/ads AND /api/admin/ads/meta down with a
  // TypeError, on data the customer path beside it survives.
  it('does not take the whole report down with it', async () => {
    const a = await store();
    const t = new Date().toISOString();
    a._setEvents([
      { t, k: 'constructor', v: 'x', i: 1 },
      { t, k: 'toString', v: 'y', i: 1 },
      { t, v: 'z', i: 1 }, // no kind at all
      { t, k: '__proto__', v: 'w', i: 1 },
      { t, k: 'visit', v: 'buyer', s: 'instagram', m: 'social', c: '', ct: '', i: 0 },
    ]);
    const r = a.report({ days: 30 });
    expect(r.internal).toMatchObject({ visits: 0, checkouts: 0, orders: 0, revenue: 0 });
    expect(r.totals.visits).toBe(1);
    expect(() => a.report({ days: 1 })).not.toThrow();
  });
});

describe('the row she could not explain', () => {
  // "instagram / social / link_in_bio — 19 visits, 3 checkouts, 0 orders." Those
  // events carry the CAMPAIGN source, not the Railway hostname: the browser
  // replays its stored touch with every later event (site/js/attribution.js), so
  // nothing in the row says which address it was opened at. The only mark left is
  // the browser itself — and it becomes available the first time that browser is
  // seen at the internal door.
  const legacy = (v, k = 'visit') => ({
    t: new Date().toISOString(),
    k,
    v,
    s: 'instagram',
    m: 'social',
    c: '',
    ct: 'link_in_bio',
  });
  const legacyBuy = (v, val) => ({ ...legacy(v, 'purchase'), o: 'dg-' + v + val, val });

  it('collapses into internal once that browser is seen at the internal door', async () => {
    const a = await store();
    a._setEvents([legacy('owner'), legacy('owner', 'checkout'), legacy('buyer')]);
    // Nothing to go on yet: both browsers look the same.
    expect(a.report({ days: 30 }).totals).toMatchObject({ visits: 2, checkouts: 1 });

    a.record({ kind: 'visit', landing: RAILWAY + '/', visitor: 'owner' });
    const r = a.report({ days: 30 });
    expect(r.rows.map((x) => x.visits)).toEqual([1]); // the buyer's, alone
    expect(r.totals).toMatchObject({ visits: 1, checkouts: 0 });
    expect(r.internal).toMatchObject({ visits: 1, checkouts: 1 });
  });

  // THE GUESS STOPS AT TRAFFIC. Both halves of it, measured: a purchase is a paid
  // order, and a guess about which browser made it is not evidence enough to take
  // real money out of the report.
  it('never drags a paid order out with the browser that made it', async () => {
    const a = await store();
    a._setEvents([legacy('cust'), legacy('cust', 'checkout'), legacyBuy('cust', 139)]);
    // The buyer comes back, once, on the address that used to be in the bio.
    a.record({ kind: 'visit', landing: RAILWAY + '/', visitor: 'cust' });
    const r = a.report({ days: 30 });
    expect(r.totals).toMatchObject({ orders: 1, revenue: 139 });
    expect(r.internal).toMatchObject({ orders: 0, revenue: 0 });
    expect(r.rows.map((x) => [x.source, x.orders, x.revenue])).toEqual([['instagram', 1, 139]]);
  });

  it('does not let one old referral off a railway page cost an ad its sale', async () => {
    const a = await store();
    // No return visit at all: rule 1 marks the referral, rule 2 would have swept
    // the rest of that browser's history the moment this deployed.
    a._setEvents([
      {
        t: new Date().toISOString(),
        k: 'visit',
        v: 'cust',
        s: 'someone-else.up.railway.app',
        m: 'referral',
        c: '',
        ct: '',
      },
      {
        t: new Date().toISOString(),
        k: 'purchase',
        v: 'cust',
        s: 'instagram',
        m: 'paid',
        c: 'summer',
        ct: 'ad1',
        o: 'dg-9201',
        val: 249,
      },
    ]);
    const r = a.report({ days: 30 });
    expect(r.totals).toMatchObject({ orders: 1, revenue: 249, paid_orders: 1 });
    expect(r.internal).toMatchObject({ visits: 1, orders: 0, revenue: 0 });
  });

  it('leaves a customer’s older rows alone, whoever else was on that address', async () => {
    const a = await store();
    a._setEvents([legacy('buyer')]);
    a.record({ kind: 'visit', landing: RAILWAY + '/', visitor: 'owner' });
    a.record({ kind: 'visit', landing: PUBLIC + '/', visitor: 'buyer' });
    const r = a.report({ days: 30 });
    expect(r.totals.visits).toBe(1);
    expect(r.internal.visits).toBe(1);
  });
});

describe('the feed and the note must not disagree', () => {
  // The note asks her to go and check the rows it set aside. An event reclassified
  // by the visitor-id rule carries no mark of its own, so the feed would have shown
  // the one row she was told to verify looking exactly like a customer's.
  it('marks an event the report has set aside, even with nothing on the record', async () => {
    const a = await store();
    a._setEvents([
      {
        t: new Date().toISOString(),
        k: 'visit',
        v: 'owner',
        s: 'instagram',
        m: 'social',
        c: '',
        ct: 'link_in_bio',
      },
    ]);
    expect(a.recent(10)[0].i).toBeUndefined(); // nothing to go on yet
    a.record({ kind: 'visit', landing: RAILWAY + '/', visitor: 'owner' });
    expect(a.report({ days: 30 }).internal.visits).toBe(1);
    for (const ev of a.recent(10)) expect(ev.i).toBe(1);
    // and the ledger still says only what the door said
    expect(a.report({ days: 30 }).internal.visits).toBe(1);
  });

  it('leaves a customer’s event unmarked', async () => {
    const a = await store();
    a.record({ kind: 'visit', landing: PUBLIC + '/', visitor: 'buyer' });
    expect(a.recent(10)[0].i).toBe(0);
  });
});

describe('the lever when one of our addresses turns out to be a customer’s', () => {
  // The *.up.railway.app link that once sat in the Instagram bio is the case: the
  // default rule owns that host, and naming it here hands its traffic AND its paid
  // orders back to the report — without having to make PUBLIC_BASE_URL a railway
  // name to do it.
  it('hands a host named as a customer’s back to the report', async () => {
    const a = await store({ customers: 'dugri-production.up.railway.app' });
    expect(a.isInternalLanding(RAILWAY + '/')).toBe(false);
    a.record({ kind: 'visit', landing: bioLink(RAILWAY), visitor: 'buyer' });
    a.record({
      kind: 'purchase',
      landing: RAILWAY + '/pay-success.html',
      visitor: 'buyer',
      order_no: 'dg-9301',
      value: 139,
    });
    const r = a.report({ days: 30 });
    expect(r.totals).toMatchObject({ visits: 1, orders: 1, revenue: 139 });
    expect(r.internal).toMatchObject({ visits: 0, orders: 0, revenue: 0 });
  });

  it('wins over a host named as ours, and never makes the public domain internal', async () => {
    const a = await store({
      hosts: 'old.dugri.co.il, dugri-israel.co.il',
      customers: 'old.dugri.co.il',
    });
    expect(a.isInternalLanding('https://old.dugri.co.il/')).toBe(false);
    expect(a.isInternalLanding(PUBLIC + '/')).toBe(false);
    expect(a.internalHosts()).toEqual(['*.up.railway.app']);
  });
});
