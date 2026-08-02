// @vitest-environment node
// Which way the buyer emails point. The order confirmation fires at order
// CREATION — before any payment — so its closing line and its button send the
// buyer to the checkout, on a link that OPENS it (pay=1) rather than dropping
// them on the word list with the pay panel folded shut. The payment receipt is
// the mirror image: payment is done, so it still points at the word list.
//
// The failure this guards against is a wrong instruction reaching a real buyer:
// asking someone who already paid to pay again, or asking someone who hasn't paid
// to go add words. Both strings are owner-editable (email.next_step), so the
// tests assert the WIRING (which line + which button + which link) rather than
// re-asserting the exact wording, which the owner may change tomorrow.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const notifyPath = path.join(serverDir, 'notify.js');
const settingsPath = path.join(serverDir, 'settings.js');

const BASE = 'https://dugri.example';
const collectLink = `${BASE}/collect.html?c=col-1&k=tok-abc`;
const payLink = collectLink + '&pay=1';
// The `&` is HTML-escaped inside an href, so html assertions use that form.
const htmlUrl = (u) => u.replace(/&/g, '&amp;');

const unpaid = {
  id: 'col-1',
  honoree_name: 'שירה',
  owner_token: 'tok-abc',
  owner_email: 'buyer@example.com',
  design: 'קלאסי',
  order: { version: 'pickup', total: 199 },
};
const paid = { ...unpaid, order: { ...unpaid.order, paid: true } };

function loadFresh() {
  delete require.cache[require.resolve(notifyPath)];
  delete require.cache[require.resolve(settingsPath)];
  const settings = require(settingsPath);
  const notify = require(notifyPath);
  return { settings, notify };
}

describe('order confirmation — points at payment', () => {
  let notify;
  let settings;
  beforeEach(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-nextstep-'));
    ({ notify, settings } = loadFresh());
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
  });

  it('closes with the pay line and a pay button on a checkout-opening link', () => {
    const step = settings.get('email', 'next_step');
    const cta = settings.get('email', 'cta_labels');
    const { text, html } = notify.buildBuyerConfirmation(unpaid, BASE);

    expect(text).toContain(step.pay);
    expect(html).toContain(step.pay);
    // The button says "complete payment" and lands on the link that opens it.
    expect(html).toContain(cta.pay);
    expect(html).toContain(htmlUrl(payLink));
    expect(text).toContain(payLink);
    // The old destination is gone from BOTH bodies — not merely outranked.
    expect(text).not.toContain(step.words);
    expect(html).not.toContain(step.words);
    expect(html).not.toContain(cta.addWords);
  });

  it('follows the owner’s edited wording instead of a hardcoded sentence', () => {
    settings.set('email', 'next_step', { pay: 'קפצו לתשלום ונצא לדרך' });
    const { text, html } = notify.buildBuyerConfirmation(unpaid, BASE);
    expect(text).toContain('קפצו לתשלום ונצא לדרך');
    expect(html).toContain('קפצו לתשלום ונצא לדרך');
    // A partial override keeps the sibling line (deep-merge over the default).
    expect(settings.get('email', 'next_step').words).toContain('המילים');
  });

  it('an ALREADY-PAID order is never told to pay (100%-coupon path)', () => {
    const step = settings.get('email', 'next_step');
    const cta = settings.get('email', 'cta_labels');
    const { text, html } = notify.buildBuyerConfirmation(paid, BASE);

    expect(text).toContain(step.words);
    expect(html).toContain(cta.addWords);
    expect(text).not.toContain(step.pay);
    // ...and the link goes to the word list, with no checkout-opening flag.
    expect(text).toContain(collectLink);
    expect(text).not.toContain('pay=1');
    expect(html).not.toContain('pay=1');
  });

  it('omits the closing line entirely when there is no link to point at', () => {
    // No baseUrl -> no collect link. Better a mail with no CTA than a sentence
    // promising a button that isn't there.
    const step = settings.get('email', 'next_step');
    const { text } = notify.buildBuyerConfirmation(unpaid);
    expect(text).not.toContain(step.pay);
    expect(text).not.toContain('collect.html');
  });
});

describe('payment receipt — still points at the word list', () => {
  let notify;
  let settings;
  beforeEach(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-nextstep-r-'));
    ({ notify, settings } = loadFresh());
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
  });

  it('keeps the add-words line + button, and never a payment link', () => {
    const step = settings.get('email', 'next_step');
    const cta = settings.get('email', 'cta_labels');
    const { text, html } = notify.buildBuyerReceipt(paid, BASE, { amountCharged: 199 });

    expect(text).toContain(step.words);
    expect(html).toContain(step.words);
    expect(html).toContain(cta.addWords);
    expect(html).toContain(htmlUrl(collectLink));
    expect(text).not.toContain('pay=1');
    expect(text).not.toContain(step.pay);
  });

  it('shares the owner’s edited words line with the reminder-free confirmation', () => {
    settings.set('email', 'next_step', { words: 'עכשיו רק נשאר לשלוח מילים' });
    const { text } = notify.buildBuyerReceipt(paid, BASE, { amountCharged: 199 });
    expect(text).toContain('עכשיו רק נשאר לשלוח מילים');
  });
});
