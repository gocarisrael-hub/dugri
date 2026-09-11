// @vitest-environment node
//
// The SMS settings the owner now edits on the texts page. The text is a single
// line (the store rejects newlines) with a 300-character ceiling — longer than
// the 120 an ordinary 'text' key allows, because a real pickup message with a
// link outgrew that and her first wording was refused on save.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let settings;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-sms-settings-'));
  delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
  settings = require(path.join(serverDir, 'settings.js'));
});

describe('sms.order_ready', () => {
  it('accepts a message up to 300 characters', () => {
    expect(settings.validateValue('sms', 'order_ready', 'א'.repeat(300))).toBeNull();
  });

  it('refuses one character more', () => {
    expect(settings.validateValue('sms', 'order_ready', 'א'.repeat(301))).toMatch(/300/);
  });

  it('accepts the pickup wording the owner actually uses', () => {
    const text =
      'היי! ההזמנה שלכם מוכנה ומחכה לאיסוף בהתחייה 14 ת״א 🤍 שעות ודרך הגעה: https://dugri-israel.co.il/pickup.html';
    expect(settings.validateValue('sms', 'order_ready', text)).toBeNull();
  });

  it('is still one line', () => {
    expect(settings.validateValue('sms', 'order_ready', 'שורה\nשנייה')).toMatch(/single line/);
  });

  it('keeps its default when nothing is saved', () => {
    expect(settings.get('sms', 'order_ready')).toContain('{honoree}');
  });
});

describe('sms.enabled', () => {
  it('is a real boolean, never a truthy string', () => {
    expect(settings.validateValue('sms', 'enabled', true)).toBeNull();
    expect(settings.validateValue('sms', 'enabled', 'true')).toMatch(/boolean/);
  });
});
