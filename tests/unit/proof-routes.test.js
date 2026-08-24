// @vitest-environment node
//
// The proof ROUTES. Who may see a buyer's deck, and what happens when there
// isn't one yet.
//
// The capability token is the whole access story here: the proof shows every
// word of a private order, and the link travels over WhatsApp. Nothing in these
// tests renders anything — the manifest is written by hand, so the assertions
// are about the gate and the file resolution rather than about ghostscript.
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
let db;
let server;
let base;
let genDir;

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-proofroutes-'));
  genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-proofgen-'));
  process.env.GENERATED_DIR = genDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  // A python that cannot exist, so any test that accidentally triggers a BUILD
  // fails loudly instead of quietly shelling out on a CI box with no ghostscript.
  process.env.PYTHON = path.join(os.tmpdir(), 'no-such-python-for-proof-tests');

  for (const f of ['db.js', 'pelecard.js', 'notify.js', 'proof.js', 'index.js']) {
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

// A produced order with a proof already on disk: the state a buyer arrives in.
function produced(name, pages = 3) {
  const c = db.createCollection(name);
  db.addWords(c.id, ['אחת', 'שתיים']);
  db.setProduction(c.id, { state: 'generated' });
  const rec = db.getCollection(c.id);
  const prod = (rec.order && rec.order.production) || rec.production;
  fs.writeFileSync(path.join(genDir, c.id + '.pdf'), '%PDF-1.4 deck');
  const pd = path.join(genDir, c.id + '.proof');
  fs.mkdirSync(pd, { recursive: true });
  const files = [];
  for (let n = 1; n <= pages; n++) {
    const f = String(n).padStart(4, '0') + '.webp';
    fs.writeFileSync(path.join(pd, f), 'RIFFwebp');
    files.push(f);
  }
  fs.writeFileSync(path.join(pd, 'proof.json'), JSON.stringify({ pages, files, width: 320 }));
  return { c, token: prod && prod.pdf_token, pages };
}

const get = (p, opts) => fetch(base + p, opts);

describe('GET /api/collections/:id/proof', () => {
  it('hands over the manifest to the token that owns the order', async () => {
    const { c, token } = produced('הדר בת 30', 4);
    const r = await get('/api/collections/' + c.id + '/proof?t=' + token);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.pages).toBe(4);
    expect(body.name).toBe('הדר בת 30');
  });

  it('403 without a token', async () => {
    const { c } = produced('בלי אסימון');
    expect((await get('/api/collections/' + c.id + '/proof')).status).toBe(403);
  });

  it('403 for another order’s token', async () => {
    // The link travels over WhatsApp. One buyer holding a valid token must not
    // be able to read a different order by swapping the id.
    const mine = produced('שלי');
    const other = produced('של מישהי אחרת');
    const r = await get('/api/collections/' + other.c.id + '/proof?t=' + mine.token);
    expect(r.status).toBe(403);
  });

  it('404 for an order nobody has', async () => {
    expect((await get('/api/collections/nope/proof?t=x')).status).toBe(404);
  });

  it('never caches the manifest', async () => {
    // A deck can be re-produced under a buyer who left the tab open; the
    // manifest is how she would find out.
    const { c, token } = produced('ללא מטמון');
    const r = await get('/api/collections/' + c.id + '/proof?t=' + token);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/collections/:id/proof/:n', () => {
  it('serves a page as a picture', async () => {
    const { c, token } = produced('עמוד', 3);
    const r = await get('/api/collections/' + c.id + '/proof/2?t=' + token);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('image/webp');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('403 for a wrong token, before it looks at the page number', async () => {
    const { c } = produced('גישה');
    expect((await get('/api/collections/' + c.id + '/proof/1?t=wrong')).status).toBe(403);
  });

  it('404 past the end of the deck', async () => {
    const { c, token } = produced('מעבר לסוף', 3);
    expect((await get('/api/collections/' + c.id + '/proof/9?t=' + token)).status).toBe(404);
  });

  it('404s a traversal instead of reading up the tree', async () => {
    const { c, token } = produced('מסלול', 3);
    const r = await get(
      '/api/collections/' +
        c.id +
        '/proof/' +
        encodeURIComponent('../../proof.json') +
        '?t=' +
        token
    );
    expect(r.status).toBe(404);
  });

  it('404 when the order has no proof on disk', async () => {
    const c = db.createCollection('לא הופק');
    db.setProduction(c.id, { state: 'generated' });
    const rec = db.getCollection(c.id);
    const prod = (rec.order && rec.order.production) || rec.production;
    const r = await get('/api/collections/' + c.id + '/proof/1?t=' + prod.pdf_token);
    expect(r.status).toBe(404);
  });
});

describe('GET /api/admin/collections/:id/proof', () => {
  it('redirects the owner to the page the customer sees', async () => {
    const { c, token } = produced('דרך המנהלת');
    const r = await get('/api/admin/collections/' + c.id + '/proof?key=' + ADMIN_KEY, {
      redirect: 'manual',
    });
    expect(r.status).toBe(302);
    const to = r.headers.get('location');
    expect(to).toContain('/proof.html?c=' + c.id);
    expect(to).toContain('t=' + token);
  });

  it('403 without the admin key', async () => {
    const { c } = produced('בלי מפתח');
    expect((await get('/api/admin/collections/' + c.id + '/proof')).status).toBe(403);
  });

  it('409 for an order that was never produced', async () => {
    const c = db.createCollection('טרם הופק');
    const r = await get('/api/admin/collections/' + c.id + '/proof?key=' + ADMIN_KEY, {
      redirect: 'manual',
    });
    expect(r.status).toBe(409);
  });
});
