// @vitest-environment node
//
// The ad ledger (server/attribution.js). This is the file that answers "which ad
// produced this order" without asking Meta, so the tests are mostly about the
// two ways that answer can be wrong: a visit credited to the wrong campaign, and
// a sale counted twice.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function freshTmpDir() {
  const dir = path.join(
    os.tmpdir(),
    `dugri-attr-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadStore(dir, env = {}) {
  vi.resetModules();
  process.env.DATA_DIR = dir;
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
  return (await import('../../server/attribution.js')).default;
}

const dirs = [];
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
beforeEach(() => {
  delete process.env.ATTRIBUTION_MAX_EVENTS;
  delete process.env.ATTRIBUTION_SAVE_MS;
});
afterEach(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  delete process.env.ATTRIBUTION_MAX_EVENTS;
  delete process.env.ATTRIBUTION_SAVE_MS;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

async function store(env) {
  const dir = freshTmpDir();
  dirs.push(dir);
  return loadStore(dir, env);
}

describe('parseTouch — reading a landing URL', () => {
  it('takes the owner’s own utm tags over everything else', async () => {
    const a = await store();
    expect(
      a.parseTouch({
        landing:
          'https://dugri-israel.co.il/?utm_source=instagram&utm_medium=paid&utm_campaign=Rovakot&utm_content=reel_03',
        referrer: 'https://www.facebook.com/',
      })
    ).toEqual({
      source: 'instagram',
      medium: 'paid',
      campaign: 'rovakot',
      content: 'reel_03',
      term: '',
    });
  });

  // THE CASE THAT MATTERS MOST. A post boosted from the Instagram app carries no
  // utm tags at all — just ?fbclid=. Without this rule every such click lands in
  // "direct", which is exactly where paid traffic goes to become invisible.
  it('credits an untagged fbclid click to paid Meta traffic, not to direct', async () => {
    const a = await store();
    const t = a.parseTouch({ landing: 'https://dugri-israel.co.il/?fbclid=IwAR123', referrer: '' });
    expect(t.source).toBe('meta');
    expect(t.medium).toBe('paid');
    expect(a.isPaid(t)).toBe(true);
  });

  it('does not call an igshid share a paid click', async () => {
    const a = await store();
    const t = a.parseTouch({ landing: 'https://dugri-israel.co.il/?igshid=abc', referrer: '' });
    expect(t.source).toBe('instagram');
    expect(t.medium).toBe('social');
    expect(a.isPaid(t)).toBe(false);
  });

  it('falls back to the referrer, named and stripped of www', async () => {
    const a = await store();
    expect(
      a.parseTouch({ landing: 'https://dugri-israel.co.il/', referrer: 'https://l.instagram.com/' })
    ).toMatchObject({
      source: 'instagram',
      medium: 'referral',
    });
    expect(
      a.parseTouch({
        landing: 'https://dugri-israel.co.il/',
        referrer: 'https://www.somewhere.co.il/x',
      })
    ).toMatchObject({
      source: 'somewhere.co.il',
      medium: 'referral',
    });
  });

  it('is direct when there is nothing to go on, and never throws on junk', async () => {
    const a = await store();
    expect(a.parseTouch({ landing: 'not a url', referrer: 'also not a url' })).toMatchObject({
      source: 'direct',
      medium: 'none',
    });
    expect(a.parseTouch({})).toMatchObject({ source: 'direct', medium: 'none' });
    expect(a.parseTouch()).toMatchObject({ source: 'direct', medium: 'none' });
  });

  // THE POINT OF THE WHOLE TAGGING SCHEME: the owner pastes ONE fixed string
  // into Meta and never types a campaign name again. Meta substitutes each
  // placeholder as it delivers the ad.
  it('reads the names Meta substitutes into its own placeholders', async () => {
    const a = await store();
    const t = a.parseTouch({
      landing:
        'https://dugri-israel.co.il/?utm_source=ig&utm_medium=paid' +
        '&utm_campaign=Rovakot%20September&utm_content=Reel%2003&utm_term=Women%2025-34',
    });
    // 'ig' is Meta's shorthand; spelled out so a hand-tagged link and an
    // auto-tagged one land on the SAME row instead of two.
    expect(t.source).toBe('instagram');
    expect(t.campaign).toBe('rovakot september');
    expect(t.content).toBe('reel 03');
    expect(t.term).toBe('women 25-34');
  });

  it('spells out every one of Meta’s source shorthands', async () => {
    const a = await store();
    const src = (v) => a.parseTouch({ landing: 'https://x.co/?utm_source=' + v }).source;
    expect(src('ig')).toBe('instagram');
    expect(src('fb')).toBe('facebook');
    expect(src('msg')).toBe('messenger');
    expect(src('an')).toBe('audience_network');
    // Anything not on the list is left exactly as it was written.
    expect(src('newsletter')).toBe('newsletter');
  });

  // A placeholder that was never substituted — a link pasted into a story, or an
  // ad that never ran — must not become a row named "{{campaign.name}}" sitting
  // in the table looking like a real campaign.
  it('treats an unsubstituted placeholder as no answer at all', async () => {
    const a = await store();
    const raw = a.parseTouch({
      landing: 'https://dugri-israel.co.il/?utm_source=instagram&utm_campaign={{campaign.name}}',
    });
    expect(raw.campaign).toBe('');
    expect(raw.source).toBe('instagram');
    const encoded = a.parseTouch({
      landing: 'https://dugri-israel.co.il/?utm_campaign=%7B%7Bcampaign.name%7D%7D&utm_source=ig',
    });
    expect(encoded.campaign).toBe('');
    // And it does not swallow a campaign that merely CONTAINS a brace.
    expect(a.parseTouch({ landing: 'https://x.co/?utm_campaign=sale{summer}now' }).campaign).toBe(
      'sale{summer}now'
    );
  });

  it('normalises campaign labels so one campaign is one row', async () => {
    const a = await store();
    const upper = a.parseTouch({ landing: 'https://x.co/?utm_source=IG&utm_campaign=  Rovakot  ' });
    const lower = a.parseTouch({ landing: 'https://x.co/?utm_source=ig&utm_campaign=rovakot' });
    expect(upper.campaign).toBe(lower.campaign);
    expect(upper.source).toBe(lower.source);
  });
});

describe('recording and reporting', () => {
  it('groups by campaign and counts a repeat visitor once', async () => {
    const a = await store();
    const ad =
      'https://dugri-israel.co.il/?utm_source=instagram&utm_medium=paid&utm_campaign=rovakot';
    a.record({ kind: 'visit', landing: ad, visitor: 'v1' });
    a.record({ kind: 'visit', landing: ad, visitor: 'v1' });
    a.record({ kind: 'visit', landing: ad, visitor: 'v2' });
    a.record({ kind: 'checkout', landing: ad, visitor: 'v1' });
    a.record({ kind: 'purchase', landing: ad, visitor: 'v1', order_no: 'DG-1001', value: 199 });

    const { rows, totals } = a.report({ days: 30 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'instagram',
      medium: 'paid',
      campaign: 'rovakot',
      visits: 2,
      checkouts: 1,
      orders: 1,
      revenue: 199,
      conversion: 50,
    });
    expect(totals).toMatchObject({ visits: 2, orders: 1, revenue: 199, paid_orders: 1 });
  });

  // A confirmation page that is reloaded, bookmarked, or opened on a second
  // device would otherwise report the same sale again — and revenue that grows
  // when nobody bought anything is worse than no report at all.
  it('counts a sale once per order number, however many times it is reported', async () => {
    const a = await store();
    const ad = 'https://dugri-israel.co.il/?utm_campaign=x&utm_source=ig';
    expect(
      a.record({ kind: 'purchase', landing: ad, order_no: 'DG-1001', value: 199 })
    ).toBeTruthy();
    expect(a.record({ kind: 'purchase', landing: ad, order_no: 'DG-1001', value: 199 })).toBeNull();
    expect(a.report({ days: 30 }).totals).toMatchObject({ orders: 1, revenue: 199 });
  });

  it('refuses a purchase with no order number, and any unknown kind', async () => {
    const a = await store();
    expect(a.record({ kind: 'purchase', landing: 'https://x.co/', value: 199 })).toBeNull();
    expect(a.record({ kind: 'pageview', landing: 'https://x.co/' })).toBeNull();
    expect(a.report({ days: 30 }).rows).toHaveLength(0);
  });

  it('reports separate rows per ad creative, best-selling first', async () => {
    const a = await store();
    const url = (content) =>
      `https://dugri-israel.co.il/?utm_source=instagram&utm_medium=paid&utm_campaign=rovakot&utm_content=${content}`;
    a.record({ kind: 'visit', landing: url('reel_a'), visitor: 'v1' });
    a.record({ kind: 'visit', landing: url('reel_b'), visitor: 'v2' });
    a.record({ kind: 'purchase', landing: url('reel_b'), order_no: 'DG-1', value: 239 });
    const rows = a.report({ days: 30 }).rows;
    expect(rows.map((r) => r.content)).toEqual(['reel_b', 'reel_a']);
    // reel_a brought a visitor who did not buy: that IS 0%, and saying so is the
    // point of the column.
    expect(rows[1].conversion).toBe(0);
  });

  // "Nobody bought" and "there is nothing to divide by" are different answers,
  // and a table that prints 0% for the second one invents a failure.
  it('has no conversion rate for a row with no visits at all', async () => {
    const a = await store();
    a.record({
      kind: 'purchase',
      landing: 'https://x.co/?utm_source=ig&utm_campaign=c',
      order_no: 'DG-1',
      value: 199,
    });
    expect(a.report({ days: 30 }).rows[0].conversion).toBeNull();
  });

  it('leaves events outside the window out of the report', async () => {
    const a = await store();
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    a.record({ kind: 'visit', landing: 'https://x.co/?utm_source=ig', visitor: 'v1', at: old });
    a.record({ kind: 'visit', landing: 'https://x.co/?utm_source=ig', visitor: 'v2' });
    expect(a.report({ days: 7 }).totals.visits).toBe(1);
    expect(a.report({ days: 90 }).totals.visits).toBe(2);
  });
});

describe('the ledger stays small and survives a restart', () => {
  it('drops the oldest events past the cap', async () => {
    const a = await store({ ATTRIBUTION_MAX_EVENTS: 5 });
    for (let i = 0; i < 12; i++) {
      a.record({ kind: 'visit', landing: 'https://x.co/?utm_campaign=c' + i, visitor: 'v' + i });
    }
    const feed = a.recent(50);
    expect(feed).toHaveLength(5);
    expect(feed[0].c).toBe('c11');
  });

  it('writes to DATA_DIR and reads back what it wrote', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    const a = await loadStore(dir);
    a.record({
      kind: 'purchase',
      landing: 'https://x.co/?utm_source=instagram&utm_medium=paid&utm_campaign=rovakot',
      order_no: 'DG-1001',
      value: 199,
    });
    a.flush();
    expect(fs.existsSync(path.join(dir, 'attribution-events.json'))).toBe(true);

    const reloaded = await loadStore(dir);
    expect(reloaded.report({ days: 30 }).totals).toMatchObject({ orders: 1, revenue: 199 });
  });

  it('starts empty rather than throwing on a corrupt file', async () => {
    const dir = freshTmpDir();
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'attribution-events.json'), '{not json', 'utf8');
    const a = await loadStore(dir);
    expect(a.report({ days: 30 }).rows).toEqual([]);
  });
});
