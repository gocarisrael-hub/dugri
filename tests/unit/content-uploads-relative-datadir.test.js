// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// GET /content-uploads/<hash>.<ext> with a RELATIVE DATA_DIR.
//
// The bug: server/content.js built UPLOAD_DIR with path.join(DATA_DIR, ...), so a
// relative DATA_DIR produced a relative upload path, and res.sendFile refuses one
// ("path must be absolute or specify root to res.sendFile") — every uploaded
// image 500s. Production sets an absolute DATA_DIR so the live site was fine, but
// the E2E server runs with DATA_DIR='.e2e-data' (playwright.config.js), so E2E
// rendered no uploaded image at all and no test noticed: nothing asserted that
// these bytes come back. Reported from PR #249 (admin order-edit dialog).
//
// This suite therefore sets DATA_DIR to a RELATIVE path on purpose. That is the
// whole point — with an absolute one it passes either way.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const repoRoot = path.join(__dirname, '..', '..');

// Relative to the process CWD (vitest runs at the repo root), mirroring how the
// E2E server is configured. Unique per run so parallel suites can't collide.
const RELATIVE_DATA_DIR = '.test-data-rel-' + process.pid;

// A tiny real PNG (magic bytes + a tail), the shape saveImageBytes accepts.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('relative-datadir'),
]);

describe('uploaded images with a RELATIVE DATA_DIR', () => {
  let app;
  let server;
  let base;
  let content;
  let stored;

  beforeAll(async () => {
    process.env.DATA_DIR = RELATIVE_DATA_DIR;
    process.env.ADMIN_KEY = 'test-admin-key';
    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'content.js', 'index.js']) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
    content = require(path.join(serverDir, 'content.js'));
    app = require(path.join(serverDir, 'index.js'));
    // Store through the real code path, so the name is exactly what the route
    // validates and the file lands wherever content.js decided to put it.
    stored = content.saveImageBytes(PNG);
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) server.close();
    fs.rmSync(path.join(repoRoot, RELATIVE_DATA_DIR), { recursive: true, force: true });
  });

  it('resolves the upload dir to an absolute path', () => {
    // The fix at its source: every consumer of _uploadDir (this route, and
    // pawnPhotoFiles feeding the generator's photo card) gets an absolute path.
    expect(path.isAbsolute(content._uploadDir)).toBe(true);
  });

  it('serves the file — 200, not a 500 from sendFile', async () => {
    // stored.path is the public "/content-uploads/<hash>.<ext>" the store hands
    // the page — exactly the URL a browser would request.
    const res = await fetch(base + stored.path);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PNG)).toBe(true);
  });

  it('still 404s an unknown name (the guard is unaffected)', async () => {
    const res = await fetch(base + '/content-uploads/' + 'a'.repeat(16) + '.png');
    expect(res.status).toBe(404);
  });
});
