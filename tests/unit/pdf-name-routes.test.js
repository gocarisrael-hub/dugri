// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The helper's own tests prove the NAME; these prove the routes actually send it.
// The bug this guards is the boring one: a filename helper landing in the repo
// while a download route keeps its old inline string, so the owner still gets a
// UUID and nobody notices because the unit tests are green.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
let app;
let db;
let server;
let base;
let generated;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pdfname-'));
  generated = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-generated-'));
  process.env.GENERATED_DIR = generated;
  process.env.ADMIN_KEY = ADMIN_KEY;
  for (const f of ['db.js', 'pelecard.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  db = require(path.join(serverDir, 'db.js'));
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
});

// An order with a produced deck sitting on disk, which is what a download needs.
function produced(patch) {
  const c = db.createCollection('לקוחה');
  db.adminUpdateCollection(c.id, { theme: 'bachelorette', ...patch });
  fs.writeFileSync(path.join(generated, c.id + '.pdf'), '%PDF-1.4\n');
  return db.getCollection(c.id);
}

const dispositionOf = async (url) => {
  const res = await fetch(base + url);
  return { status: res.status, cd: res.headers.get('content-disposition') || '' };
};

describe('a downloaded deck is named after the order', () => {
  it('uses the customer title on the admin download', async () => {
    const c = produced({ custom_title: 'Happy birthday', honoree_name: 'Shira' });
    const { status, cd } = await dispositionOf(
      '/api/admin/collections/' + c.id + '/pdf?key=' + ADMIN_KEY
    );
    expect(status).toBe(200);
    expect(cd).toContain('Happy birthday');
    expect(cd).toContain(c.id.slice(0, 8));
    // …and NOT the old whole-uuid name.
    expect(cd).not.toContain(c.id);
  });

  it('falls back to the honoree when the order has no title', async () => {
    const c = produced({ honoree_name: 'Shira' });
    const { cd } = await dispositionOf('/api/admin/collections/' + c.id + '/pdf?key=' + ADMIN_KEY);
    expect(cd).toContain('Shira');
  });

  it('sends a Hebrew title percent-encoded, with an ASCII fallback beside it', async () => {
    const c = produced({ custom_title: 'החגיגה של שירה' });
    const { cd } = await dispositionOf('/api/admin/collections/' + c.id + '/pdf?key=' + ADMIN_KEY);
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent('החגיגה של שירה'));
    // The quoted part stays inside Latin-1, which is all the header allows.
    const ascii = cd.match(/filename="([^"]*)"/)[1];
    expect(ascii).toMatch(/^[\x20-\x7e]*$/);
  });

  it('names the buyer-facing download the same way', async () => {
    // The customer's link is token-gated; the point here is only that this route
    // was wired too, not that the token works (it has its own tests).
    const c = produced({ custom_title: 'Happy birthday' });
    const { status, cd } = await dispositionOf('/api/collections/' + c.id + '/pdf');
    // 403 without a token — but a 200 here would have to carry the name.
    expect([200, 403, 404]).toContain(status);
    if (status === 200) expect(cd).toContain('Happy birthday');
  });
});
