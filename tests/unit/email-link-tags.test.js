// @vitest-environment node
// Every link in a BUYER email is tagged utm_source=email, so the ad report shows
// our emails as their own rows instead of folding them into order_link /
// own_link with WhatsApp, SMS and friends' word links. Mails whose button is the
// checkout read email / email_payment; the rest read email / email_other. Owner alerts
// (and the owner's copy of a shared mail) stay untagged: those clicks are hers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const payTag = (mail) => `&utm_source=email&utm_medium=email_payment&utm_campaign=${mail}`;
const tag = (mail) => `&utm_source=email&utm_medium=email_other&utm_campaign=${mail}`;
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
  require(settingsPath);
  return require(notifyPath);
}

describe('buyer email links carry the email tag', () => {
  let notify;
  beforeEach(() => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-emailtag-'));
    notify = loadFresh();
  });
  afterEach(() => {
    delete process.env.DATA_DIR;
  });

  const toPayment = [
    [
      'order confirmation (unpaid, opens checkout)',
      (n) => n.buildBuyerConfirmation(unpaid, BASE),
      collectLink + '&pay=1' + payTag('buyer_confirmation'),
    ],
    [
      'payment reminder',
      (n) => n.buildPaymentReminder(unpaid, BASE),
      collectLink + payTag('payment_reminder'),
    ],
    [
      'free limit reached',
      (n) => n.buildFreeLimitReached(unpaid, BASE, 30),
      collectLink + payTag('free_limit_reached'),
    ],
  ];
  const toOther = [
    [
      'order confirmation (already paid)',
      (n) => n.buildBuyerConfirmation(paid, BASE),
      collectLink + tag('buyer_confirmation'),
    ],
    [
      'payment receipt',
      (n) => n.buildBuyerReceipt(paid, BASE),
      collectLink + tag('buyer_payment_received'),
    ],
    ['order ready', (n) => n.buildOrderReady(paid, BASE), collectLink + tag('order_ready')],
    [
      'words reminder',
      (n) => n.buildWordsReminder(paid, BASE),
      collectLink + tag('words_reminder'),
    ],
    [
      'reminder list',
      (n) => n.buildReminderEmail(paid, 'עוד מילים על {honoree}\n{link}', BASE),
      collectLink + tag('reminder'),
    ],
    [
      'production problem, buyer copy',
      (n) => n.buildProductionError(paid, BASE, ['חסרות מילים'], { buyer: true }),
      collectLink + tag('production_error'),
    ],
  ];

  const expectTagged = (msg, expected) => {
    expect(msg.text).toContain(expected);
    expect(msg.html).toContain(htmlUrl(expected));
    // No untagged copy of the link is left behind anywhere in the mail.
    const bare = msg.text.split(collectLink).length - 1;
    const tagged = msg.text.split(expected).length - 1;
    expect(bare).toBe(tagged);
  };

  for (const [name, build, expected] of toPayment) {
    it(`${name}: reads email_payment`, () => expectTagged(build(notify), expected));
  }
  for (const [name, build, expected] of toOther) {
    it(`${name}: reads email_other`, () => {
      const msg = build(notify);
      expectTagged(msg, expected);
      expect(msg.text).not.toContain('email_payment');
    });
  }

  it('owner alerts are not tagged', () => {
    const alerts = [
      notify.buildPaidMessage(paid, BASE),
      notify.buildPaymentReceipt(paid, BASE),
      notify.buildFinishedMessage(paid, BASE),
      notify.buildProductionError(paid, BASE, ['חסרות מילים']),
    ];
    for (const { text } of alerts) {
      expect(text).toContain(collectLink);
      expect(text).not.toContain('utm_source=email');
    }
  });

  // The production-problem mail goes to Dugri AND the buyer. Only the buyer's
  // copy is tagged, or the owner's own clicks would fill the buyer row.
  it('the production-problem sender tags the buyer copy only', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.NOTIFY_FROM = 'Dugri <hello@dugri.example>';
    process.env.NOTIFY_TO = 'owner@dugri.example';
    const sent = [];
    vi.stubGlobal('fetch', async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ id: 'x' }), text: async () => '' };
    });
    try {
      const fresh = loadFresh();
      await fresh.sendProductionError(paid, BASE, ['חסרות מילים']);
      const to = (m) => [].concat(m.to).join(',');
      const owner = sent.find((m) => to(m).includes('owner@dugri.example'));
      const buyer = sent.find((m) => to(m).includes('buyer@example.com'));
      expect(owner.text).not.toContain('utm_source=email');
      expect(buyer.text).toContain(collectLink + tag('production_error'));
    } finally {
      vi.unstubAllGlobals();
      delete process.env.RESEND_API_KEY;
      delete process.env.NOTIFY_FROM;
      delete process.env.NOTIFY_TO;
    }
  });

  it('no link means no tag, not a dangling query string', () => {
    const { text, html } = notify.buildPaymentReminder(unpaid, '');
    expect(text).not.toContain('utm_');
    expect(html).not.toContain('utm_');
  });
});

describe('the report reads a tagged email click as email, not order_link', () => {
  it('parses the payment and the other mails to separate rows', () => {
    const attribution = require(path.join(serverDir, 'attribution.js'));
    const pay = attribution.parseTouch({
      landing: `${BASE}/collect.html?pay=1${payTag('payment_reminder')}`,
      referrer: 'https://mail.google.com/',
    });
    expect(pay).toMatchObject({
      source: 'email',
      medium: 'email_payment',
      campaign: 'payment_reminder',
    });
    const other = attribution.parseTouch({
      landing: `${BASE}/collect.html?x=1${tag('order_ready')}`,
      referrer: '',
    });
    expect(other).toMatchObject({
      source: 'email',
      medium: 'email_other',
      campaign: 'order_ready',
    });
    // Neither is ad spend.
    expect(attribution.isPaid(pay)).toBe(false);
    expect(attribution.isPaid(other)).toBe(false);
  });
});
