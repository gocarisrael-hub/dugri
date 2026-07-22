// @vitest-environment node
// Guards the RTL WhatsApp link-clickability fix: a URL placed inline right after
// Hebrew (RTL) text often isn't auto-linked by WhatsApp, so every trigger whose
// default text carries a {link} must place it on its OWN line (preceded by a
// newline). Regression guard against re-inlining a link when the defaults change.
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
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wa-link-'));
  delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
  settings = require(path.join(serverDir, 'settings.js'));
});

describe('WhatsApp trigger default texts', () => {
  it('place {link} on its own line so WhatsApp linkifies it in RTL messages', () => {
    const wa = settings.REGISTRY.wa;
    const withLink = [];
    for (const key of Object.keys(wa)) {
      const text = (wa[key].default && wa[key].default.text) || '';
      if (text.includes('{link}')) {
        withLink.push(key);
        expect(text, `${key}: {link} must start its own line`).toMatch(/\n\{link\}/);
        // and never sit inline right after non-newline text
        expect(text, `${key}: {link} must not be inline`).not.toMatch(/[^\n]\{link\}/);
      }
    }
    // Sanity: we actually exercised several triggers (group_opened, dailies, etc.).
    expect(withLink.length).toBeGreaterThanOrEqual(5);
  });
});
