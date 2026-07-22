// @vitest-environment node
// notify.js now reads each email's subject/body template (and the editable label
// maps / footer) from server/settings.js, interpolating the {tokens}. These
// tests pin TWO things:
//   1. With NO override, every builder's output is byte-identical to the strings
//      that used to be inline (the registry defaults reproduce them exactly).
//   2. An override changes the output and interpolates tokens.
// Both notify and settings are fresh-required against a temp DATA_DIR so the
// override store starts empty and stays isolated per test.
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

// Fresh copies of BOTH modules sharing one settings instance (notify requires
// settings, so deleting both caches then requiring settings first guarantees
// notify picks up this exact instance).
function loadFresh() {
  delete require.cache[require.resolve(notifyPath)];
  delete require.cache[require.resolve(settingsPath)];
  const settings = require(settingsPath);
  const notify = require(notifyPath);
  return { settings, notify };
}

const BASE = 'https://dugri.example';
const link = `${BASE}/collect.html?c=col-1&k=tok-abc`;
const collection = {
  id: 'col-1',
  honoree_name: 'שירה',
  owner_token: 'tok-abc',
  owner_email: 'buyer@example.com',
  design: 'קלאסי',
  color: 'ורוד',
  order: { version: 'delivery', total: 199 },
  count: 142,
};
const orderLines = [
  'מספר הזמנה: col-1',
  'גרסה: משלוח עד הבית',
  'סכום: 199 ₪',
  'מספר מילים: 142',
  'קישור לניהול: ' + link,
];

beforeEach(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-notify-settings-'));
});
afterEach(() => {
  delete process.env.DATA_DIR;
});

describe('defaults are byte-identical to the pre-refactor strings', () => {
  it('buildPaidMessage', () => {
    const { notify } = loadFresh();
    expect(notify.buildPaidMessage(collection, BASE)).toEqual({
      subject: 'דוגרי · התקבלה הזמנה חדשה — שירה',
      text: ['התקבלה הזמנה חדשה עבור שירה.', '', ...orderLines].join('\n'),
    });
  });

  it('buildCustomOrderAlert', () => {
    const { notify } = loadFresh();
    expect(notify.buildCustomOrderAlert(collection, BASE)).toEqual({
      subject: 'דוגרי · הזמנה בהתאמה אישית — צריך עיצוב ידני · שירה',
      text: [
        'התקבלה הזמנת עיצוב אישי (מותאם אישית) עבור שירה.',
        'ההזמנה דורשת עיצוב ידני — אין תבנית מוכנה, יש להכין עיצוב בהתאמה מלאה.',
        '',
        ...orderLines,
      ].join('\n'),
    });
  });

  it('buildBuyerConfirmation', () => {
    const { notify } = loadFresh();
    const { subject, text } = notify.buildBuyerConfirmation(collection, BASE);
    expect(subject).toBe('דוגרי · ההזמנה שלכם התקבלה — שירה');
    expect(text).toBe(
      [
        'תודה רבה על ההזמנה!',
        'קיבלנו את ההזמנה שלך למשחק של שירה.',
        '',
        'פרטי ההזמנה:',
        '· חבילה: משלוח עד הבית',
        'משחק מודפס ומוכן — חפיסת קלפים, לוח משחק ודף חוקים, שנשלח עד הבית.',
        '· מחיר: 199 ₪',
        '· עיצוב: קלאסי',
        '· צבע: ורוד',
        '',
        'המשחק יישלח אליך בדרך כלל תוך 5–7 ימי עסקים מרגע שרשימת המילים מוכנה.',
        '',
        'נשאר רק שלב אחד: הוסיפו את 70+ המילים על בעל/ת השמחה כאן:',
        link,
        '',
        'נתראה על הלוח,',
        'צוות דוגרי',
      ].join('\n')
    );
  });

  it('buildPdfReadyMessage', () => {
    const { notify } = loadFresh();
    const pdfLink = `${BASE}/api/admin/collections/col-1/pdf?key=SECRET`;
    const { subject, text } = notify.buildPdfReadyMessage(collection, pdfLink, BASE);
    expect(subject).toBe('דוגרי · הקובץ שלכם מוכן — שירה');
    expect(text).toBe(
      [
        'הקובץ המוכן להדפסה של המשחק עבור שירה מוכן!',
        '',
        'להורדת ה-PDF:',
        pdfLink,
        '',
        'נתראה על הלוח,',
        'צוות דוגרי',
      ].join('\n')
    );
  });

  it('buildFinishedMessage', () => {
    const { notify } = loadFresh();
    expect(notify.buildFinishedMessage(collection, BASE)).toEqual({
      subject: 'דוגרי · הזמנה מוכנה להפקה — שירה',
      text: ['ההזמנה של שירה נסגרה ומוכנה להפקה.', '', ...orderLines].join('\n'),
    });
  });

  it('buildProductionError', () => {
    const { notify } = loadFresh();
    const { subject, text } = notify.buildProductionError(collection, BASE, [
      'חסרות מילים',
      'שם חסר',
    ]);
    expect(subject).toBe('דוגרי · צריך תיקון לפני הפקה — שירה');
    expect(text).toBe(
      [
        'לא הצלחנו להפיק את הקובץ של שירה — יש לתקן את הנקודות הבאות:',
        '',
        '· חסרות מילים',
        '· שם חסר',
        '',
        'לעדכון ההזמנה:',
        link,
        '',
        'צוות דוגרי',
      ].join('\n')
    );
  });

  it('buildWordsReminder', () => {
    const { notify } = loadFresh();
    const { subject, text } = notify.buildWordsReminder(collection, BASE);
    expect(subject).toBe('דוגרי · עוד לא הוספתם מילים — שירה');
    expect(text).toBe(
      [
        'עוד לא קיבלנו את רשימת המילים עבור המשחק של שירה.',
        '',
        'ברגע שתוסיפו את המילים נתחיל להכין את הקובץ — זה לוקח כמה דקות בלבד.',
        '',
        'להוספת המילים:',
        link,
        '',
        'נתראה על הלוח,',
        'צוות דוגרי',
      ].join('\n')
    );
  });
});

describe('an override changes the output and interpolates tokens', () => {
  it('a custom subject/body template is used, with {honoree} interpolated', () => {
    const { settings, notify } = loadFresh();
    settings.set('email', 'order_paid', {
      subject: 'כסף נכנס: {honoree}',
      body: 'שילמו על המשחק של {honoree}. יאללה מתחילים!',
    });
    const { subject, text } = notify.buildPaidMessage(collection, BASE);
    expect(subject).toBe('כסף נכנס: שירה');
    // The new intro line replaces the default; the order-detail lines still follow.
    expect(text).toBe(['שילמו על המשחק של שירה. יאללה מתחילים!', '', ...orderLines].join('\n'));
  });

  it('an overridden field label + version label flow through the order details', () => {
    const { settings, notify } = loadFresh();
    settings.set('email', 'field_labels', { version: 'סוג' });
    settings.set('email', 'version_labels', { delivery: 'שליחת שליח' });
    const { text } = notify.buildFinishedMessage(collection, BASE);
    expect(text).toContain('סוג: שליחת שליח');
    // Untouched labels keep their defaults (deep-merge of the map).
    expect(text).toContain('מספר מילים: 142');
  });

  it('an overridden footer + CTA label appears in the branded email', () => {
    const { settings, notify } = loadFresh();
    settings.set('email', 'footer', { line1: 'להתראות,', line2: 'הצוות' });
    settings.set('email', 'cta_labels', { addWords: 'בואו נוסיף מילים' });
    const { text, html } = notify.buildWordsReminder(collection, BASE);
    expect(text).toContain('להתראות,');
    expect(text).toContain('הצוות');
    expect(html).toContain('בואו נוסיף מילים');
  });
});
