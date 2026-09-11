// @vitest-environment node
//
// The SMS settings the owner edits on the texts page.
//
// sms.order_ready is the one 'text' key that may run long and span lines: every
// other text key is a one-line storefront string. Her pickup message is 15 lines
// and about 670 characters, and she chose to send it whole — the phone splits it
// into SMS parts.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// Her message, as she wrote it.
const PICKUP = `היי!
אנחנו שמחות לכתוב לכם שההזמנה שלכם מוכנה ומחכה לכם בכתובת התחייה 14 ת״א, כניסה B, קומה ראשונה (פנייה ראשונה שמאלה ולעלות קומה במדרגות).
זמני האיסוף ודרך הגעה מצורפים בקישור!
https://dugri-israel.co.il/pickup.html

הדוגרי שלכם בקרוב אצלכם 🤍

בעת האיסוף חשוב להגיע עם פרטים מזהים כגון הכותרת שבחרתם למוצר שלכם, טלפון של המזמין ושם המזמין.
בבית הדפוס ההזמנות מסודרות בכניסה מתחת לשלט ״דוגרי איסוף עצמי״- עליכם לקחת את ההזמנה שלכם לפי הפרטים שלכם (כתובים באופן ברור על כל הזמנה) ולוודא כי ההזמנה שלקחתם אכן שלכם!

תודה רבה!! ואל תשכחו לצלם ולתייג 🥳
@dugri_israel

*החיילים שלכם הם באחד קלפי המשחק, רק צריך לגזור אותם החוצה🙂
*הטיימר הוא באתר שלנו, יש ברקוד בגב הלוח 😍`;

let settings;
let sms;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-sms-settings-'));
  for (const f of ['settings.js', 'sms.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  sms = require(path.join(serverDir, 'sms.js'));
});

describe('sms.order_ready', () => {
  it('accepts her whole pickup message, line breaks and all', () => {
    expect(PICKUP.length).toBeGreaterThan(600);
    expect(settings.validateValue('sms', 'order_ready', PICKUP)).toBeNull();
  });

  it('accepts up to 700 characters and refuses one more', () => {
    expect(settings.validateValue('sms', 'order_ready', 'א'.repeat(700))).toBeNull();
    expect(settings.validateValue('sms', 'order_ready', 'א'.repeat(701))).toMatch(/700/);
  });

  it('keeps its default when nothing is saved', () => {
    expect(settings.get('sms', 'order_ready')).toContain('{honoree}');
  });

  // Every OTHER text key is a one-line storefront string and must stay one: a
  // pasted paragraph would blow a banner's height apart.
  it('does not loosen the one-line rule for any other text key', () => {
    expect(settings.validateValue('pricing', 'sale_label', 'שורה\nשנייה')).toMatch(/single line/);
  });
});

describe('what is sent', () => {
  // The whole message must reach the phone. The old 480 cap on what is queued
  // would have cut her message a third of the way through its last paragraph.
  it('queues her whole message, untruncated, with its line breaks', () => {
    const m = sms.enqueue({ to: '0521234567', text: PICKUP, event: 'order_ready' });
    expect(m.text).toBe(PICKUP);
    expect(m.text.split('\n').length).toBe(PICKUP.split('\n').length);
  });

  it('still bounds a runaway template', () => {
    const m = sms.enqueue({ to: '0521234567', text: 'א'.repeat(5000), event: 'manual' });
    expect(m.text.length).toBe(sms.MAX_TEXT);
  });
});

describe('sms.enabled', () => {
  it('is a real boolean, never a truthy string', () => {
    expect(settings.validateValue('sms', 'enabled', true)).toBeNull();
    expect(settings.validateValue('sms', 'enabled', 'true')).toMatch(/boolean/);
  });
});
