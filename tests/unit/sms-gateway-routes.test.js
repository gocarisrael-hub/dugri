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
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  it('on the real domain, for exactly that message', async () => {
    const m = queue();
    const { body } = await poll();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ id: m.id, to: '0521234567', text: 'המשחק מוכן' });
    expect(body.messages[0].ack_url).toMatch(
      new RegExp(`^${PUBLIC}/api/sms/outbox/${m.id}/ack\\?t=[A-Za-z0-9-]+$`)
    );
  });

  // A URL is written into Railway's access log, Cloudflare's, and Automate's own
  // flow log on a phone that lives in a drawer. SMS_GATEWAY_KEY opens the whole
  // outbox — every customer's number and every text — so it must not be the
  // thing travelling in all of those. The link carries a key to ONE message.
  it('carries a per-message token, never the shared gateway key', async () => {
    queue();
    const { body } = await poll();
    expect(body.messages[0].ack_url).not.toContain(GW);
    // …and the raw token is not echoed as a field of its own either: the link is
    // the only place it needs to be.
    expect(body.messages[0].ack_token).toBeUndefined();
  });

  it('gives two messages two different tokens', async () => {
    queue('c-one');
    queue('c-two');
    const { body } = await poll();
    const t = body.messages.map((m) => new URL(m.ack_url).searchParams.get('t'));
    expect(t[0]).toBeTruthy();
    expect(t[0]).not.toBe(t[1]);
  });

  // paymentBaseUrl refuses to read the Host header, and so does this: a spoofed
  // or internal Host would hand the phone an address that answers nothing, every
  // report would 404 in silence, and the message would go out again on the next
  // lease — the exact loop this route was written to stop. With no base
  // configured the field is simply absent and the phone falls back to the
  // documented POST with the header, which needs no address from us.
  it('omits the link entirely rather than guessing one from the Host header', async () => {
    const had = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      queue();
      const { body } = await poll();
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].ack_url).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('127.0.0.1');
    } finally {
      process.env.PUBLIC_BASE_URL = had;
    }
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

  // The way the phone was first set up, before links came with the message.
  it('is still taken with the shared key and no token at all', async () => {
    const m = queue();
    await poll();
    const r = await fetch(base + `/api/sms/outbox/${m.id}/ack?key=${GW}`);
    expect(r.status).toBe(200);
    expect(stateOf(m.id)).toBe('sent');
  });

  it('refuses a token that belongs to a different message', async () => {
    const a = queue('c-a');
    const b = queue('c-b');
    const { body } = await poll();
    const other = body.messages.find((x) => x.id === b.id).ack_url;
    const stolen = new URL(other).searchParams.get('t');
    const r = await fetch(base + `/api/sms/outbox/${a.id}/ack?t=${stolen}`);
    expect(r.status).toBe(403);
    expect(stateOf(a.id)).toBe('taken');
  });

  it('refuses a made-up token', async () => {
    const m = queue();
    await poll();
    expect((await fetch(base + `/api/sms/outbox/${m.id}/ack?t=nope`)).status).toBe(403);
    expect(stateOf(m.id)).toBe('taken');
  });

  // The id comes out of the path, and a %0A in a path decodes to a real newline.
  // A newline in a log line is a SECOND log line: anyone who can reach this
  // route could otherwise write a convincing "[sms] sent" into the record the
  // owner reads when she is working out why a customer heard nothing.
  it('cannot be made to forge a second log line through the id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const forged = encodeURIComponent('x\n[sms] המשחק נשלח בהצלחה');
      const r = await fetch(base + `/api/sms/outbox/${forged}/ack?key=${GW}`);
      expect(r.status).toBe(404);
      const line = warn.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(line).toContain('[sms] report for an unknown message id');
      expect(line.split('\n')).toHaveLength(1);
      expect(line).not.toContain('נשלח בהצלחה');
    } finally {
      warn.mockRestore();
    }
  });
});

// A report that arrives after the cap gave up must not repaint the row green:
// the reason on that row is the only thing telling the owner her phone is
// broken. Covered at the module level in sms-outbox.test.js; here end to end,
// because it is the route the phone actually calls.
describe('a late report over the wire', () => {
  it('leaves a capped failure failed, with its reason intact', async () => {
    const m = queue();
    let url = null;
    for (let i = 0; i < sms.MAX_ATTEMPTS; i++) {
      const { body } = await poll();
      if (body.messages.length) url = local(body.messages[0].ack_url);
      // The lease runs out with no report; the file is reconciled on the next read.
      const rec = sms.list().find((x) => x.id === m.id);
      rec.taken_at = new Date(Date.now() - sms.LEASE_MS - 1000).toISOString();
    }
    sms.reconcile();
    expect(stateOf(m.id)).toBe('failed');
    const before = sms.list().find((x) => x.id === m.id).error;

    const r = await fetch(url);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: 'failed' });
    const after = sms.list().find((x) => x.id === m.id);
    expect(after.state).toBe('failed');
    expect(after.error).toBe(before);
  });
});

// The same report, for a phone whose flow cannot build a per-message address.
// One constant URL, pasted after the send block.
describe('the batch report', () => {
  it('marks everything the phone is holding as sent, on a plain GET', async () => {
    const m = queue();
    await poll();
    const r = await fetch(base + '/api/sms/outbox/ack-taken?key=' + GW);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, sent: 1 });
    expect(stateOf(m.id)).toBe('sent');
  });

  it('is taken as a POST as well', async () => {
    const m = queue();
    await poll();
    const r = await fetch(base + '/api/sms/outbox/ack-taken?key=' + GW, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(stateOf(m.id)).toBe('sent');
  });

  it('answers plainly when the phone is holding nothing', async () => {
    const r = await fetch(base + '/api/sms/outbox/ack-taken?key=' + GW);
    expect(await r.json()).toMatchObject({ ok: true, sent: 0 });
  });

  it('refuses a wrong key, leaving the message leased', async () => {
    const m = queue();
    await poll();
    expect((await fetch(base + '/api/sms/outbox/ack-taken?key=nope')).status).toBe(403);
    expect(stateOf(m.id)).toBe('taken');
  });
});
