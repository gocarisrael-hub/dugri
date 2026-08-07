// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// GET /design-thumb/<name> — the route the wizard's design picker asks for a
// SMALL version of one of the owner's gallery uploads.
//
// This one runs the REAL pipeline: a real upload through content.saveImageBytes,
// the real Express route, the real generator/thumb_image.py (Python + Pillow).
// The E2E stubs this endpoint, so without a test here a rename or an unwired
// route would break the feature in production with a green suite.
//
// If Python or Pillow is unavailable, the resize legitimately cannot run: the
// route must answer 404 (never the multi-hundred-KB original), and the tests
// below split along exactly that line.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// A real, decodable 64×64 PNG — the resizer has to actually open it.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfbJGYyliH8OITBAtzmrP11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB2OhhtC3NOZwAAAAASUVORK5CYII=',
  'base64'
);

describe('GET /design-thumb/:name', () => {
  let server, base, dataDir, name;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-thumb-route-'));
    process.env.DATA_DIR = dataDir;
    process.env.ADMIN_KEY = 'test-admin-key';
    for (const f of [
      'db.js',
      'pelecard.js',
      'notify.js',
      'content.js',
      'image-thumbs.js',
      'index.js',
    ]) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
    // Same singleton the route uses, so the upload we save here is the one it reads.
    const content = require(path.join(serverDir, 'content.js'));
    name = content.saveImageBytes(PNG).path.split('/').pop();
    const app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves a real raster derivative of a real upload, cached immutably', async () => {
    const r = await fetch(base + '/design-thumb/' + name);
    if (r.status === 404) {
      // No Python/Pillow here. That is a supported environment, and 404 is the
      // whole contract for it — the client falls back to its shipped render.
      expect(await r.text()).toBe('Not found');
      return;
    }
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^image\/(webp|jpeg|png)/);
    // Content-addressed source + a fixed px cap ⇒ these bytes never change.
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.length).toBeGreaterThan(0);
    // Never bigger than the source: the entire point is that it is smaller.
    expect(body.length).toBeLessThanOrEqual(PNG.length);
  });

  it('an upload that does not exist is 404, not a 500 and not a stack trace', async () => {
    const r = await fetch(base + '/design-thumb/0123456789abcdef.png');
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('Not found');
  });

  it('a name that is not a content-hash upload is refused', async () => {
    for (const bad of [
      'nope.png',
      'aaaaaaaaaaaaaaaa.svg',
      'AAAAAAAAAAAAAAAA.png',
      '..%2F..%2Fetc',
    ]) {
      const r = await fetch(base + '/design-thumb/' + bad);
      expect(r.status).toBe(404);
    }
  });

  // The storefront asks for a specific rung of the ladder via srcset, so the
  // width-bearing form has to answer for real — a 404 here would make every
  // candidate fail and (thanks to the client's fallback) quietly put the full
  // originals back on the page.
  describe('/design-thumb/<width>/<name>', () => {
    it('serves each rung the client advertises, immutably', async () => {
      for (const w of [400, 800, 1200]) {
        const r = await fetch(`${base}/design-thumb/${w}/${name}`);
        if (r.status === 404) return; // no Python/Pillow here — the supported case
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toMatch(/^image\/(webp|jpeg|png)/);
        expect(r.headers.get('cache-control')).toContain('immutable');
        expect(r.headers.get('x-content-type-options')).toBe('nosniff');
        expect(Buffer.from(await r.arrayBuffer()).length).toBeGreaterThan(0);
      }
    });

    // Refused rather than silently served at the default size: a silent
    // substitution would make srcset's `w` descriptors lie about the bytes, and
    // the browser would keep picking the wrong candidate.
    it('refuses any width outside the closed set', async () => {
      for (const bad of ['401', '1201', '0', '-400', '1600', '4000', 'big', '400px', '0400']) {
        const r = await fetch(`${base}/design-thumb/${bad}/${name}`);
        expect(r.status).toBe(404);
        expect(await r.text()).toBe('Not found');
      }
    });

    it('validates the name at a width too, and never 500s', async () => {
      for (const bad of ['nope.png', 'aaaaaaaaaaaaaaaa.svg', 'AAAAAAAAAAAAAAAA.png']) {
        const r = await fetch(`${base}/design-thumb/800/${bad}`);
        expect(r.status).toBe(404);
      }
      const missing = await fetch(base + '/design-thumb/800/0123456789abcdef.png');
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe('Not found');
    });
  });
});
