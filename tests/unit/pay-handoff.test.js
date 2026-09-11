// @vitest-environment node
//
// THE HANDOFF OUT OF A CARD PAYMENT — the step that was silently throwing away
// five sales in six.
//
// PeleCard returns the payment frame to PUBLIC_BASE_URL, which is not
// necessarily the address the buyer is browsing. While those two differed
// (Railway hostname vs the real domain), the browser refused to deliver the
// frame's "payment done" message and the checkout never heard it: the buyer
// paid, the window sat on "returning you…", and they closed it by hand. 35 of
// 41 paid orders in one twelve-day stretch never reached the confirmation page
// — which is also the only place a sale is reported to Google and to Meta.
//
// These are source-level guards. The behaviour itself is exercised in
// tests/e2e/pay-handoff.spec.js with a real cross-origin frame; what is checked
// here is that neither of the two mistakes can quietly come back.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(__dirname, '..', '..', 'site');
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');

describe('the frame announces the payment so it can actually arrive', () => {
  const html = read('pay-done.html');

  // Naming our own origin as the target is the bug: when the two addresses
  // differ the browser drops the message, with no error anywhere.
  it('does not target its own origin', () => {
    expect(html).not.toContain("postMessage({ type: 'dugri-pay', ok: ok }, location.origin)");
    expect(html).toMatch(/postMessage\(\s*\{\s*type:\s*'dugri-pay'[\s\S]*?\},\s*'\*'\s*\)/);
  });

  // '*' is only acceptable because the payload is a type and a boolean. An order
  // id, a token or an amount in here would be readable by any page that framed
  // us.
  it('puts nothing in the message that could not be shouted', () => {
    const call = html.slice(html.indexOf('postMessage('), html.indexOf('postMessage(') + 200);
    for (const secret of ['owner_token', 'ownerToken', 'order_no', 'total', 'charged', 'id:']) {
      expect(call).not.toContain(secret);
    }
  });
});

describe('the checkout identifies the frame by window, not by address', () => {
  const html = read('collect.html');

  it('no longer refuses a message for coming from another origin', () => {
    expect(html).not.toContain('if (e.origin !== location.origin) return;');
  });

  // e.source is the window object this page put in the frame itself. No other
  // page can present itself as that window, so it is a STRONGER check than the
  // origin comparison was — and unlike it, no setting can break it.
  it('accepts only the window it opened', () => {
    expect(html).toContain('e.source !== frame.contentWindow');
  });
});

describe('and a route home that needs no message at all', () => {
  const html = read('collect.html');

  it('watches the order after a payment window opens', () => {
    expect(html).toContain('function watchForPayment');
    expect(html).toContain('payAwaiting = true');
  });

  it('finishes the checkout itself once the order reads as paid', () => {
    const fn = html.slice(html.indexOf('function watchForPayment'));
    const body = fn.slice(0, fn.indexOf('function openPayFrame'));
    expect(body).toContain('isPaid()');
    expect(body).toContain('closeModal()');
    expect(body).toContain('goPaySuccess()');
  });

  // A watcher with no end would poll from a phone in somebody's pocket all
  // evening. A card payment that has not landed in ten minutes never will.
  it('gives up after a bounded time', () => {
    const fn = html.slice(html.indexOf('function watchForPayment'));
    expect(fn.slice(0, 400)).toMatch(/tries > \d+/);
  });

  // The case the whole change exists for: they closed the window in confusion,
  // and they had already paid.
  it('keeps watching after the buyer closes the window by hand', () => {
    const fn = html.slice(html.indexOf('function closeModal'));
    const body = fn.slice(0, fn.indexOf("$('#payModalClose')"));
    expect(body).not.toContain('clearTimeout(payWatchTimer)');
    expect(body).not.toContain('payAwaiting = false');
  });

  // …AND IT REPORTS THE SALE. This is now the primary way home for the buyers
  // the change rescues, so a silent one would go on under-reporting the very
  // funnel step the fix exists to repair. The behaviour is asserted in
  // tests/e2e/pay-handoff.spec.js; this is the guard against it being dropped.
  it('fires the same funnel event the message path fires', () => {
    const fn = html.slice(html.indexOf('function watchForPayment'));
    const body = fn.slice(0, fn.indexOf('function openPayFrame'));
    expect(body).toContain("track('card_pay_done')");
  });

  // render() tears down a focused word editor, and the detach fires
  // blur → commit with half-typed text. The five-second background poll has
  // always skipped a refresh for that reason; this watcher outlives the modal by
  // up to ten minutes, so it has to skip one too.
  it('does not re-render on top of a word being edited', () => {
    const fn = html.slice(html.indexOf('function watchForPayment'));
    const body = fn.slice(0, fn.indexOf('function openPayFrame'));
    expect(body).toContain('if (wordEditOpen)');
  });

  // THE DELIVERY UPGRADE OPENS THE SAME MODAL, on an order that is already paid
  // (db.shippingUpgrade refuses with 'no paid order' otherwise). An unconditional
  // watcher would see isPaid() on its first tick and blank the live gateway
  // frame 2.5 seconds in, so the upgrade could never be bought.
  it('arms the watcher only for the charge that is being waited on', () => {
    const fn = html.slice(html.indexOf('function openPayFrame'));
    const body = fn.slice(0, fn.indexOf('function releasePaySession'));
    expect(body).toContain('watchForPaid');
    expect(body).toContain('!isPaid()');
    // The checkout asks for it; the shipping upgrade's openPayFrameRef call
    // does not, and must not.
    expect(html).toContain('openPayFrame(res.url, { watchForPaid: true })');
    expect(html).toContain('openPayFrameRef(res.url)');
  });
});
