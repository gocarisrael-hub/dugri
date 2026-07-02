// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';

// Boot the real Express app and drive it over a raw HTTP client. We use the
// low-level http module (not fetch) on purpose: it does NOT transparently
// decompress or strip Content-Encoding, so the header assertions below observe
// exactly what the server put on the wire.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;
let server;
let port;

// Raw GET returning { status, headers } — no auto-decompression so
// Content-Encoding survives for inspection.
function rawGet(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      // Drain the body so the socket can close; we only assert on headers.
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
  });
}

beforeAll(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-perf-'));
  for (const f of ['db.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  app = require(path.join(serverDir, 'index.js'));
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
});

describe('response compression', () => {
  it('gzips a large compressible SVG board when the client accepts gzip', async () => {
    const r = await rawGet('/assets/designs/marriage/board.svg', { 'Accept-Encoding': 'gzip' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('gzip');
  });

  it('gzips a JS asset when the client accepts gzip', async () => {
    const r = await rawGet('/js/collect.js', { 'Accept-Encoding': 'gzip' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBe('gzip');
  });

  it('does NOT gzip when the client does not advertise gzip support', async () => {
    const r = await rawGet('/js/collect.js', { 'Accept-Encoding': 'identity' });
    expect(r.status).toBe(200);
    expect(r.headers['content-encoding']).toBeUndefined();
  });
});

describe('cache-control policy', () => {
  it('serves HTML with no-cache so visitors always get the latest page', async () => {
    const r = await rawGet('/', { 'Accept-Encoding': 'gzip' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['cache-control']).toBe('no-cache');
  });

  it('gives static media a moderate 1-day public max-age', async () => {
    const r = await rawGet('/assets/logo.png', { 'Accept-Encoding': 'gzip' });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('gives an SVG (media) the same moderate 1-day max-age', async () => {
    const r = await rawGet('/assets/designs/marriage/board.svg', { 'Accept-Encoding': 'gzip' });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('does NOT long-cache JS/CSS — keeps express.static default (max-age=0) + ETag', async () => {
    const r = await rawGet('/js/collect.js', { 'Accept-Encoding': 'gzip' });
    expect(r.status).toBe(200);
    // express.static's default: public, max-age=0 means the browser must
    // revalidate every load (via ETag), so a deploy's code changes are seen
    // immediately — no moderate/long max-age is applied to JS/CSS.
    expect(r.headers['cache-control']).toBe('public, max-age=0');
    expect(r.headers['etag']).toBeDefined();
  });
});
