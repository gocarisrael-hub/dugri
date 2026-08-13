import { test, expect } from '@playwright/test';

// The endpoints an Android phone with the owner's SIM talks to: poll for what to
// send, report back. Gated by SMS_GATEWAY_KEY — a secret the phone carries, kept
// separate from ADMIN_KEY so a handset left in a drawer is not the whole admin.
//
// The E2E server sets that key (playwright.config.js) along with the feature
// switch, so this spec exercises the real routes rather than a stub.
const KEY = 'dugri-admin';
const SMS_KEY = 'e2e-sms-gateway-key';
const uniq = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

// The feature switch is OFF by default — a phone that is not set up yet must not
// leave customers waiting for a text that never comes — so this spec turns it on.
// That is global state on a shared server, which is also why the spec runs on ONE
// device project: two of them toggling the same switch would race.
test.beforeEach(async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'Desktop Chrome', 'flips a global switch: runs once');
  const r = await request.post(`/api/admin/settings?key=${KEY}`, {
    data: { section: 'sms', key: 'enabled', value: true },
  });
  expect(r.ok()).toBeTruthy();
});

// Seed an order and take it to the point where "מוכן" can be pressed.
async function seedReadyable(request, phone = '0521234567') {
  const name = uniq('סמס');
  const create = await request.post('/api/collections', {
    data: { honoree_name: name, email: 'sms@example.com', phone },
  });
  const { id, owner_token } = await create.json();
  const o = await request.post(`/api/collections/${id}/order`, {
    data: { owner_token, version: 'pickup' },
  });
  expect(o.ok()).toBeTruthy();
  const p = await request.post(`/api/admin/collections/${id}/to-print?key=${KEY}`, { data: {} });
  expect(p.ok()).toBeTruthy();
  return { id, name };
}

const poll = (request) =>
  request.get('/api/sms/outbox', { headers: { 'x-sms-key': SMS_KEY } }).then((r) => r.json());

test('the gateway is closed to anyone without the phone’s key', async ({ request }) => {
  expect((await request.get('/api/sms/outbox')).status()).toBe(403);
  expect(
    (await request.get('/api/sms/outbox', { headers: { 'x-sms-key': 'wrong' } })).status()
  ).toBe(403);
  // …and the admin key is NOT the phone's key: two secrets, two blast radii.
  expect((await request.get(`/api/sms/outbox?key=${KEY}`)).status()).toBe(403);
});

test('pressing מוכן queues a text, the phone collects it and reports back', async ({ request }) => {
  const { id, name } = await seedReadyable(request);

  const before = await poll(request);
  expect(before.messages.some((m) => m.text.includes(name))).toBe(false);

  const ready = await request.post(`/api/admin/collections/${id}/ready?key=${KEY}`, { data: {} });
  expect(ready.ok()).toBeTruthy();

  // The queue now holds one message, addressed in the local form a SIM dials,
  // with the honoree's name interpolated into the owner's own template.
  const batch = await poll(request);
  const mine = batch.messages.find((m) => m.text.includes(name));
  expect(mine, 'no SMS queued for the order just marked ready').toBeTruthy();
  expect(mine.to).toBe('0521234567');
  expect(mine.text).toContain('מוכן');

  // Leased: a second poll (the app restarting) does not resend the same text.
  const again = await poll(request);
  expect(again.messages.some((m) => m.id === mine.id)).toBe(false);

  // The phone reports it sent, and the admin view agrees.
  const ack = await request.post(`/api/sms/outbox/${mine.id}/ack`, {
    headers: { 'x-sms-key': SMS_KEY },
    data: { ok: true },
  });
  expect(ack.ok()).toBeTruthy();
  const admin = await request.get(`/api/admin/sms?key=${KEY}`);
  const body = await admin.json();
  expect(body.messages.find((m) => m.id === mine.id).state).toBe('sent');
  expect(body.last_poll_at).toBeTruthy();
});

test('a buyer with no mobile simply gets no text, and nothing errors', async ({ request }) => {
  // A landline is not a mobile: the press must still succeed, and queue nothing.
  const { id, name } = await seedReadyable(request, '03-1234567');
  const ready = await request.post(`/api/admin/collections/${id}/ready?key=${KEY}`, { data: {} });
  expect(ready.ok()).toBeTruthy();
  const batch = await poll(request);
  expect(batch.messages.some((m) => m.text.includes(name))).toBe(false);
});

test('a failure the phone reports is kept, with its reason, for the owner to see', async ({
  request,
}) => {
  const { id, name } = await seedReadyable(request);
  await request.post(`/api/admin/collections/${id}/ready?key=${KEY}`, { data: {} });
  const mine = (await poll(request)).messages.find((m) => m.text.includes(name));
  expect(mine).toBeTruthy();

  await request.post(`/api/sms/outbox/${mine.id}/ack`, {
    headers: { 'x-sms-key': SMS_KEY },
    data: { ok: false, error: 'SIM has no credit' },
  });
  const body = await (await request.get(`/api/admin/sms?key=${KEY}`)).json();
  const rec = body.messages.find((m) => m.id === mine.id);
  expect(rec.state).toBe('failed');
  expect(rec.error).toBe('SIM has no credit');
});

test('the admin view is behind the admin key', async ({ request }) => {
  expect((await request.get('/api/admin/sms?key=nope')).status()).toBe(403);
  expect((await request.get(`/api/admin/sms?key=${KEY}`)).status()).toBe(200);
});
