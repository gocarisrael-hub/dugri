// @vitest-environment node
// The FAQ over the real Express app: the PUBLIC GET /api/faq projection, and the
// admin write path that feeds it. The two are tested together because the whole
// point of validateFaq is that it stands between an admin POST and an
// unauthenticated response — a rejected write must be observable as "the public
// endpoint never changed".
//
// Same harness as settings-routes.test.js: require the app (it does not listen —
// guarded by require.main===module) and bind an ephemeral port for the test.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
let app;
let server;
let base;
let dataDir;
let DEFAULT_FAQ;

const item = (over = {}) => ({
  id: 'q1',
  enabled: true,
  q: 'שאלה?',
  a: 'תשובה.',
  link_text: '',
  link_url: '',
  ...over,
});

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-faq-routes-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['faq.js', 'settings.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  ({ DEFAULT_FAQ } = require(path.join(serverDir, 'faq.js')));
  app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.DATA_DIR;
  delete process.env.ADMIN_KEY;
});

const url = (p) => base + p;
const getFaq = async () => (await fetch(url('/api/faq'))).json();
const save = (value) =>
  fetch(url('/api/admin/settings?key=' + ADMIN_KEY), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'faq', key: 'list', value }),
  });
const reset = () =>
  fetch(url('/api/admin/settings?section=faq&settingKey=list&key=' + ADMIN_KEY), {
    method: 'DELETE',
  });

describe('GET /api/faq — public, unauthenticated', () => {
  it('needs no admin key and returns the shipped defaults out of the box', async () => {
    const res = await fetch(url('/api/faq'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((r) => r.id)).toEqual(DEFAULT_FAQ.map((r) => r.id));
  });

  it('exposes only the display fields — no settings section can leak through it', async () => {
    const { items } = await getFaq();
    for (const it of items) {
      expect(Object.keys(it).sort()).toEqual(['a', 'id', 'link_text', 'link_url', 'q']);
    }
  });
});

describe('the admin write path feeds the public endpoint', () => {
  it('a saved list replaces what visitors see, in order', async () => {
    const res = await save([
      item({ id: 'first', q: 'ראשונה' }),
      item({ id: 'second', q: 'שנייה' }),
    ]);
    expect(res.status).toBe(200);
    const { items } = await getFaq();
    expect(items.map((r) => r.q)).toEqual(['ראשונה', 'שנייה']);
    await reset();
  });

  it('a DISABLED question is stored for the owner but never served to visitors', async () => {
    await save([item({ id: 'shown' }), item({ id: 'hidden', enabled: false, q: 'מוסתרת' })]);

    // The owner still sees it through the admin API…
    const admin = await (await fetch(url('/api/admin/settings?key=' + ADMIN_KEY))).json();
    expect(admin.effective.faq.list.map((r) => r.id)).toEqual(['shown', 'hidden']);

    // …but the public projection does not carry it at all.
    const { items } = await getFaq();
    expect(items.map((r) => r.id)).toEqual(['shown']);
    expect(JSON.stringify(items)).not.toContain('מוסתרת');
    await reset();
  });

  it('an EMPTY list is honoured (the home page hides the section)', async () => {
    expect((await save([])).status).toBe(200);
    expect((await getFaq()).items).toEqual([]);
    await reset();
  });

  it('DELETE restores the shipped defaults', async () => {
    await save([item({ id: 'only-one' })]);
    expect((await getFaq()).items).toHaveLength(1);
    expect((await reset()).status).toBe(200);
    expect((await getFaq()).items).toHaveLength(DEFAULT_FAQ.length);
  });

  it('the saved list survives a settings reload (it is persisted, not in-memory)', async () => {
    await save([item({ id: 'persisted', q: 'נשמרה לדיסק' })]);
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    expect(raw.faq.list[0].q).toBe('נשמרה לדיסק');
    await reset();
  });
});

describe('a rejected write never reaches visitors', () => {
  it('400s a javascript: link and leaves the public list untouched', async () => {
    const before = await getFaq();
    const res = await save([item({ link_text: 'לחצו', link_url: 'javascript:alert(1)' })]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/link_url must start with https:\/\/ or \//);
    expect(await getFaq()).toEqual(before);
  });

  it('400s an over-long answer, an empty question and a non-array', async () => {
    for (const bad of [
      [item({ a: 'א'.repeat(2001) })],
      [item({ q: '' })],
      [item({ enabled: 'yes' })],
      'not-an-array',
    ]) {
      const res = await save(bad);
      expect(res.status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    // Still the defaults after four refused writes.
    expect((await getFaq()).items).toHaveLength(DEFAULT_FAQ.length);
  });

  it('403s a write with no admin key — and the list is unchanged', async () => {
    const res = await fetch(url('/api/admin/settings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'faq', key: 'list', value: [item({ q: 'פרוץ' })] }),
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await getFaq())).not.toContain('פרוץ');
  });
});
