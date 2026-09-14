// @vitest-environment node
// Every link in a BUYER email is tagged utm_source=email, so the ad report shows
// our emails as their own row (email / email / <which mail>) instead of folding
// them into order_link / own_link with WhatsApp, SMS and friends' word links.
// Owner alerts stay untagged: those clicks are the owner's, not a buyer's.
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
const tag = (mail) => `&utm_source=email&utm_medium=email&utm_campaign=${mail}`;
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

  const cases = [
    [
      'order confirmation (unpaid, opens checkout)',
      (n) => n.buildBuyerConfirmation(unpaid, BASE),
      collectLink + '&pay=1' + tag('buyer_confirmation'),
    ],
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
      'payment reminder',
      (n) => n.buildPaymentReminder(unpaid, BASE),
      collectLink + tag('payment_reminder'),
    ],
    [
      'free limit reached',
      (n) => n.buildFreeLimitReached(unpaid, BASE, 30),
      collectLink + tag('free_limit_reached'),
    ],
    [
      'reminder list',
      (n) => n.buildReminderEmail(paid, 'עוד מילים על {honoree}\n{link}', BASE),
      collectLink + tag('reminder'),
    ],
    [
      'production problem',
      (n) => n.buildProductionError(paid, BASE, ['חסרות מילים']),
      collectLink + tag('production_error'),
    ],
  ];

  for (const [name, build, expected] of cases) {
    it(`${name}: text and button both use the tagged link`, () => {
      const { text, html } = build(notify);
      expect(text).toContain(expected);
      expect(html).toContain(htmlUrl(expected));
      // No untagged copy of the link is left behind anywhere in the mail.
      const bare = text.split(collectLink).length - 1;
      const tagged = text.split(expected).length - 1;
      expect(bare).toBe(tagged);
    });
  }

  it('owner alerts are not tagged', () => {
    const alerts = [
      notify.buildPaidMessage(paid, BASE),
      notify.buildPaymentReceipt(paid, BASE),
      notify.buildFinishedMessage(paid, BASE),
    ];
    for (const { text } of alerts) {
      expect(text).toContain(collectLink);
      expect(text).not.toContain('utm_source=email');
    }
  });

  it('no link means no tag, not a dangling query string', () => {
    const { text, html } = notify.buildPaymentReminder(unpaid, '');
    expect(text).not.toContain('utm_');
    expect(html).not.toContain('utm_');
  });
});

describe('the report reads a tagged email click as email, not order_link', () => {
  it('parses to email / email / <mail>', () => {
    const attribution = require(path.join(serverDir, 'attribution.js'));
    const touch = attribution.parseTouch({
      landing: `${BASE}/collect.html?pay=1&utm_source=email&utm_medium=email&utm_campaign=payment_reminder`,
      referrer: 'https://mail.google.com/',
    });
    expect(touch).toMatchObject({
      source: 'email',
      medium: 'email',
      campaign: 'payment_reminder',
    });
  });
});
