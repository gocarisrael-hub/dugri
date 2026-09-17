// @vitest-environment node
//
// WHO A RATE LIMIT COUNTS. Every IP-keyed limiter on the site funnels through one
// function — clientKey() in server/index.js — and it USED TO return req.ip. With
// app.set('trust proxy', true) Express reads req.ip as the LEFTMOST
// X-Forwarded-For entry, which is the entry the CLIENT wrote: proxies APPEND, so
// the forgeable entries are on the left and our own proxy's is on the right.
//
// So a caller sending a fresh X-Forwarded-For per request got a fresh bucket per
// request, and every limiter keyed this way — preview, coupon validation,
// design-code validation and /api/track — counted to sixty over and over. Four of
// the five cases below failed that way before the one-line change that ships with
// this file; they are written as the bug rather than around it, so deleting the
// fix brings them straight back.
//
// The payment limiters were never in this set: pay/init and shipping/init key off
// paymentClientIp (server/payment-client-ip.js), which already counts hops from
// the right, and tests/unit/pay-init-rate.test.js already pins that. clientKey
// now derives through the same function, so there is one derivation rather than
// two that can drift.
//
// THE OPPOSITE MISTAKE IS WORSE THAN THIS BUG, and nothing in the repo guarded it
// before this file. Trusting one hop too many buckets every visitor together, and
// then one person hitting a limiter locks out the whole site. A test that only
// proves "spoofed headers share a bucket" passes happily in that world, so every
// case here has a partner: different real clients must stay in DIFFERENT buckets.
//
// Both environment shapes are covered, because they differ and the difference is
// configuration rather than something to detect at runtime: production is behind
// Cloudflare (which appends, and sets CF-Connecting-IP itself), staging is direct
// to Railway with no Cloudflare in front of it at all.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// Small enough that a bucket is exhausted in a handful of requests, so each case
// reads as "these shared a bucket" or "these did not" rather than as a load test.
const LIMIT = 4;

let app;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-client-ip-'));
  process.env.TRACK_RATE_LIMIT = String(LIMIT);
  // One proxy appends in front of this process on Railway — the same hop count
  // the payment path already runs with.
  process.env.PAYMENT_PROXY_HOPS = '1';
  for (const f of ['db.js', 'settings.js', 'attribution.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  require(path.join(serverDir, 'settings.js'));
  require(path.join(serverDir, 'db.js'));
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
  delete process.env.TRACK_RATE_LIMIT;
  delete process.env.PAYMENT_PROXY_HOPS;
});

// /api/track is the limiter used here because it is D's own route: the property
// under test belongs to clientKey, and proving it needs no other domain's
// endpoint. 204 is success, 429 is refused.
async function track(headers) {
  const res = await fetch(base + '/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ kind: 'visit', landing: 'https://dugri-israel.co.il/', visitor: 'v' }),
  });
  return res.status;
}

// n requests from one caller, as status codes, so a test can say exactly where
// the refusals begin instead of asserting a count.
async function burst(n, headersFor) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await track(headersFor(i)));
  return out;
}

describe('a limiter counts the client, not the header the client wrote', () => {
  // THE BUG. Railway appends one entry, so the rightmost is the address it saw;
  // everything to its left arrived from the caller. Rotating the left entry must
  // change nothing about which bucket this is.
  it('one client rotating X-Forwarded-For still shares one bucket', async () => {
    const statuses = await burst(LIMIT + 2, (i) => ({
      'X-Forwarded-For': `${10 + i}.${i}.${i * 7}.${200 - i}, 203.0.113.50`,
    }));
    expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(204));
    expect(statuses.slice(LIMIT)).toEqual([429, 429]);
  });

  // THE PARTNER CASE, and the one that fails if the hop count is too generous:
  // two genuinely different clients must not share a budget. Without it,
  // "bucket everyone together" passes the test above and locks out the site.
  //
  // WHICH ENTRY IS THE CLIENT matters here, and it is the RIGHTMOST one. Railway
  // appends the address it received the request from, so with one trusted hop the
  // last entry IS the visitor and everything left of it is whatever she sent. Two
  // different visitors therefore differ in the LAST entry; two requests that
  // differ only on the left are one visitor with a rotating forgery, which is the
  // case above. (An earlier draft of this test had it backwards — it gave both
  // "clients" the same last entry and expected two buckets, which is asserting
  // the bug rather than the fix.)
  it('two different clients keep separate buckets', async () => {
    const a = await burst(LIMIT, () => ({ 'X-Forwarded-For': '6.6.6.6, 198.51.100.10' }));
    expect(a).toEqual(Array(LIMIT).fill(204));
    // A's budget is spent — including when she forges a different left entry.
    expect(await track({ 'X-Forwarded-For': '7.7.7.7, 198.51.100.10' })).toBe(429);
    // B is a different visitor and must be untouched by A's spending.
    expect(await track({ 'X-Forwarded-For': '6.6.6.6, 198.51.100.11' })).toBe(204);
  });

  // An IPv6 allocation is 2^64 addresses; a limit per address is no limit. One
  // /64 is one client.
  it('an IPv6 client using a fresh address of its /64 each time shares one bucket', async () => {
    const statuses = await burst(LIMIT + 2, (i) => ({
      'X-Forwarded-For': `9.9.9.${i}, 2001:db8:abcd:99::${(i + 1).toString(16)}`,
    }));
    expect(statuses.slice(0, LIMIT)).toEqual(Array(LIMIT).fill(204));
    expect(statuses.slice(LIMIT)).toEqual([429, 429]);
    // …and a DIFFERENT /64 is a different client, so the /64 is not simply
    // bucketing all of IPv6 together.
    expect(await track({ 'X-Forwarded-For': '9.9.9.9, 2001:db8:abcd:aa::1' })).toBe(204);
  });

  // PRODUCTION SHAPE: Cloudflare in front of Railway. Cloudflare appends its edge
  // address and writes CF-Connecting-IP itself, overwriting whatever arrived
  // under that name — so for a request that really came through Cloudflare, that
  // header is the visitor.
  it('behind Cloudflare, the visitor is CF-Connecting-IP and not what she sent', async () => {
    const cf = { 'X-Forwarded-For': '6.6.6.6, 172.64.10.20', 'CF-Connecting-IP': '198.51.100.77' };
    const spent = await burst(LIMIT, () => cf);
    expect(spent).toEqual(Array(LIMIT).fill(204));
    // Same visitor, a different forged left-hand entry: still her bucket.
    expect(
      await track({
        'X-Forwarded-For': '7.7.7.7, 172.64.10.20',
        'CF-Connecting-IP': '198.51.100.77',
      })
    ).toBe(429);
    // A different visitor through the same Cloudflare edge is a different bucket.
    expect(
      await track({
        'X-Forwarded-For': '6.6.6.6, 172.64.10.20',
        'CF-Connecting-IP': '198.51.100.78',
      })
    ).toBe(204);
  });

  // STAGING SHAPE: no Cloudflare at all. A CF-Connecting-IP arriving here is
  // something the caller typed, and believing it would hand every caller a
  // bucket of their choosing — the same bug in a different hat.
  it('with no Cloudflare in front, a forged CF-Connecting-IP buys nothing', async () => {
    const real = '203.0.113.99';
    const spent = await burst(LIMIT, (i) => ({
      'X-Forwarded-For': `5.5.5.${i}, ${real}`,
      'CF-Connecting-IP': `198.51.100.${100 + i}`,
    }));
    expect(spent).toEqual(Array(LIMIT).fill(204));
    expect(
      await track({ 'X-Forwarded-For': `5.5.5.200, ${real}`, 'CF-Connecting-IP': '198.51.100.250' })
    ).toBe(429);
  });
});
