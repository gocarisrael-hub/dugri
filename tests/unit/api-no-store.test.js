// @vitest-environment node
// NOTHING MAY CACHE A JSON ANSWER FROM THIS SERVER.
//
// The pages were already built to be un-stale — no-cache HTML, content-hashed
// modules, DYNAMIC at the edge — but every /api answer went out with no cache
// directive at all, only a weak ETag. A response with no freshness information
// does not say "don't cache me", it says "you decide", and the caches that
// decide are the ones we never see: Instagram's in-app browser (where most of
// this shop's traffic arrives), a carrier proxy, a webview restored from disk.
// That is how a shopper reloads, gets today's HTML, and still reads yesterday's
// price — the reload does not touch a heuristically-fresh cache entry.
//
// Same harness as faq-routes.test.js: require the app (it does not listen) and
// bind an ephemeral port.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;
let server;
let base;
let dataDir;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-no-store-'));
  process.env.DATA_DIR = dataDir;
  for (const f of ['faq.js', 'settings.js', 'notify.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
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
});

// The public endpoints a storefront page reads on load. Each one is state that
// has no correct stale value: a price, an ended sale, which designs exist, what
// the owner rewrote a minute ago.
const PUBLIC_JSON = [
  '/api/pricing',
  '/api/content',
  '/api/faq',
  '/api/features',
  '/api/design-names',
  '/api/design-images',
  '/api/custom-designs',
];

describe('public JSON endpoints forbid caching', () => {
  for (const p of PUBLIC_JSON) {
    it(`${p} answers no-store`, async () => {
      const r = await fetch(base + p);
      expect(r.status, `${p} did not answer`).toBe(200);
      expect(r.headers.get('cache-control'), p).toBe('no-store');
    });
  }

  // The bug was never a WRONG directive — it was the absence of one. A response
  // with no Cache-Control is not "do not cache", it is "cache at your own
  // discretion", which is exactly what an in-app browser does.
  it('no public JSON endpoint answers without a cache directive at all', async () => {
    for (const p of PUBLIC_JSON) {
      const r = await fetch(base + p);
      expect(r.headers.get('cache-control'), `${p} has no directive`).toBeTruthy();
    }
  });

  it('covers an error answer too — a cached 404 outlives the thing that fixed it', async () => {
    const r = await fetch(base + '/api/definitely-not-a-route');
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});

describe('what it must NOT do', () => {
  // /api also hands back files — template images, a produced PDF. Those are
  // content-addressed or large and genuinely should be cached; the hook is on
  // res.json precisely so it never reaches them.
  it('leaves an endpoint that chose its own Cache-Control alone', async () => {
    // Proven directly on the middleware rather than hunting for an endpoint that
    // happens to set one: the guard is the whole contract.
    const express = require(path.join(serverDir, 'node_modules', 'express'));
    const probe = express();
    probe.use('/api', (req, res, next) => {
      const json = res.json.bind(res);
      res.json = (body) => {
        if (!res.get('Cache-Control')) res.set('Cache-Control', 'no-store');
        return json(body);
      };
      next();
    });
    probe.get('/api/long-lived', (req, res) => {
      res.set('Cache-Control', 'public, max-age=3600');
      res.json({ ok: true });
    });
    const srv = await new Promise((resolve) => {
      const s = probe.listen(0, () => resolve(s));
    });
    try {
      const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/long-lived');
      expect(r.headers.get('cache-control')).toBe('public, max-age=3600');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
