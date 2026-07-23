// @vitest-environment node
// The webhook shape diagnostic: isGroupWebhook scopes the "unhandled shape" log to
// group/participant events (not status receipts), and webhookShape emits field
// NAMES only — never content — so an unrecognized participant-add reveals its
// structure without leaking message text / phone numbers / names.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;
beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-wh-shape-'));
  for (const f of ['db.js', 'settings.js', 'wa-state.js', 'whatsapp.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  app = require(path.join(serverDir, 'index.js'));
});

describe('isGroupWebhook', () => {
  it('is true for group/participant keys', () => {
    expect(app.isGroupWebhook({ groups: [] })).toBe(true);
    expect(app.isGroupWebhook({ groups_participants: [] })).toBe(true);
    expect(app.isGroupWebhook({ chat_participants: [] })).toBe(true);
  });

  it('is true for an inbound NON-text message (a system/action event we dropped)', () => {
    // A "member added" delivered as a messages action — captured too.
    expect(app.isGroupWebhook({ messages: [{ type: 'action', from_me: false }] })).toBe(true);
    expect(app.isGroupWebhook({ messages: [{ type: 'notification', from_me: false }] })).toBe(true);
  });

  it('is false for routine traffic (statuses, our echoes, plain text)', () => {
    expect(app.isGroupWebhook({ statuses: [] })).toBe(false);
    expect(app.isGroupWebhook({ messages: [{ type: 'text', from_me: false }] })).toBe(false);
    expect(app.isGroupWebhook({ messages: [{ type: 'action', from_me: true }] })).toBe(false); // our echo
    expect(app.isGroupWebhook({ messages: [] })).toBe(false);
    expect(app.isGroupWebhook(null)).toBe(false);
    expect(app.isGroupWebhook([])).toBe(false);
  });
});

describe('webhookShape', () => {
  it('reports field NAMES only — never values/content', () => {
    const body = {
      groups: [{ id: '123@g.us', participants: [{ id: '972500000000' }], subject: 'secret name' }],
      event: { type: 'groups', event: 'patch' },
    };
    const shape = app.webhookShape(body);
    const json = JSON.stringify(shape);
    // structure captured
    expect(shape.groups).toBe('[{id,participants,subject}]');
    expect(shape.event).toBe('{type,event}');
    // NO content leaked
    expect(json).not.toContain('123@g.us');
    expect(json).not.toContain('972500000000');
    expect(json).not.toContain('secret name');
  });
});
