// @vitest-environment node
//
// Every buyer-facing page must load GA4. This is a coverage guard, not a style
// check: products.html and pay-success.html shipped for months with no tag at
// all, so the shop page — the destination of nearly every CTA on the home page
// — recorded no pageview, and a completed order recorded nothing whatsoever.
// The result in GA4 was traffic that appeared to arrive and never buy.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(__dirname, '..', '..', 'site');

// The pages a buyer can land on or pass through. Admin screens are deliberately
// absent — the owner's own visits must not colour the numbers.
const BUYER_PAGES = [
  'index.html',
  'products.html',
  'product.html',
  'options.html',
  'collect.html',
  'how.html',
  'pay-success.html',
];

const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');

describe('GA4 covers every buyer-facing page', () => {
  for (const page of BUYER_PAGES) {
    it(`${page} defines gtag, loads consent.js and loads analytics.js`, () => {
      const html = read(page);
      // The inline stub must exist: consent.js and every track() call assume a
      // global gtag that queues into dataLayer before GA itself has loaded.
      expect(html).toContain('window.dataLayer = window.dataLayer || []');
      expect(html).toContain('function gtag()');
      expect(html).toMatch(/<script src="js\/consent\.js" defer><\/script>/);
      expect(html).toMatch(/<script type="module" src="js\/analytics\.js"><\/script>/);
    });
  }
});

describe('the money events carry money', () => {
  it('begin_checkout sends a value in ILS with the chosen design as the item', () => {
    const html = read('options.html');
    const call = html.slice(html.indexOf("track('begin_checkout'"));
    expect(call).toContain("currency: 'ILS'");
    expect(call).toContain('value: PLANS[plan].price');
    expect(call).toContain('items:');
  });

  it('pay-success fires a GA4 purchase, not a custom event name', () => {
    const html = read('pay-success.html');
    expect(html).toContain("gtag('event', 'purchase'");
    expect(html).toContain("currency: 'ILS'");
    expect(html).toContain('transaction_id:');
  });

  it('the purchase is guarded so a refresh cannot count the sale twice', () => {
    const html = read('pay-success.html');
    const fn = html.slice(html.indexOf('function reportPurchase'));
    expect(fn).toContain("'dugri:purchase:'");
    expect(fn).toContain('localStorage.getItem');
  });

  it('an unpaid order reports nothing', () => {
    const html = read('pay-success.html');
    const fn = html.slice(html.indexOf('function reportPurchase'));
    expect(fn).toContain('if (!s.order || !s.order.paid) return;');
  });
});
