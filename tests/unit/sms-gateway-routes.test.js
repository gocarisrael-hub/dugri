// @vitest-environment node
//
// The two routes the owner's phone talks to, against the real app.
//
// The report step used to be built on the phone — "…/outbox/" ++ m["id"] ++
// "/ack?key=…" in an Automate formula — and when that went wrong the phone never
// knew: its request succeeded (an HTTP block does not fail on a 404), the message
// stayed leased, and the customer got the same text again when the lease ran out.
// Now every message arrives with its own ready-made report link, and the report is
// taken whichever method the app happens to send.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const GW = 'gw-test-key';
const PUBLIC = 'https://dugri-israel.co.il';

let app;
let sms;
let server;
let base;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-sms-routes-'));
  process.env.SMS_GATEWAY_KEY = GW;
  process.env.PUBLIC_BASE_URL = PUBLIC;
  process.env.ADMIN_KEY = 'test-admin-key';
  for (const f of ['sms.js', 'settings.js', 'db.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  sms = require(path.join(serverDir, 'sms.js'));
  app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
  delete process.env.SMS_GATEWAY_KEY;
});

beforeEach(() => sms._reset());

const queue = (collection_id = 'c-' + Math.random()) =>
  sms.enqueue({ to: '0521234567', text: 'המשחק מוכן', event: 'order_ready', collection_id });

async function poll(key = GW) {
  const r = await fetch(base + '/api/sms/outbox?key=' + key);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
// The link names the PUBLIC address; the test server answers on its own port.
const local = (url) => url.replace(PUBLIC, base);
const stateOf = (id) => sms.list().find((m) => m.id === id).state;

describe('every message comes with its own report link', () => {
  it('on the real domain, carrying the key, for exactly that message', async () => {
    const m = queue();
    const { body } = await poll();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ id: m.id, to: '0521234567', text: 'המשחק מוכן' });
    expect(body.messages[0].ack_url).toBe(`${PUBLIC}/api/sms/outbox/${m.id}/ack?key=${GW}`);
  });
});

describe('the report', () => {
  // THE DEFAULT an automation app sends when nobody picks a method.
  it('is taken as a plain GET of that link', async () => {
    const m = queue();
    const { body } = await poll();
    const r = await fetch(local(body.messages[0].ack_url));
    expect(r.status).toBe(200);
    expect(stateOf(m.id)).toBe('sent');
  });

  it('is still taken as a POST, as the phone was first set up', async () => {
    const m = queue();
    const { body } = await poll();
    const r = await fetch(local(body.messages[0].ack_url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    expect(r.status).toBe(200);
    expect(stateOf(m.id)).toBe('sent');
  });

  it('carries a failure and its reason on a GET, having no body', async () => {
    const m = queue();
    const { body } = await poll();
    const url =
      local(body.messages[0].ack_url) + '&ok=false&error=' + encodeURIComponent('אין יתרה');
    await fetch(url);
    const after = sms.list().find((x) => x.id === m.id);
    expect(after.state).toBe('failed');
    expect(after.error).toBe('אין יתרה');
  });

  it('answers 404 for an id it does not know, and leaves the real message leased', async () => {
    const m = queue();
    await poll();
    const r = await fetch(base + `/api/sms/outbox/not-a-real-id/ack?key=${GW}`);
    expect(r.status).toBe(404);
    expect(stateOf(m.id)).toBe('taken');
  });

  it('refuses a wrong key on either method', async () => {
    const m = queue();
    await poll();
    expect((await fetch(base + `/api/sms/outbox/${m.id}/ack?key=wrong`)).status).toBe(403);
    expect(
      (await fetch(base + `/api/sms/outbox/${m.id}/ack?key=wrong`, { method: 'POST' })).status
    ).toBe(403);
    expect(stateOf(m.id)).toBe('taken');
  });
});
