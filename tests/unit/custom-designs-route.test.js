// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boots the real Express app to exercise the custom-designs routes:
//   GET /api/custom-designs              — uploaded templates that become products
//   GET /api/template-image/:slug/:slot  — serve a custom design's clean SVG
// A "custom design" is DERIVED from themes.json: a PUBLIC theme that is NOT one of
// the built-in catalog designs' themes (THEME_BY_DESIGN, from the REAL designs.js).
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const SVG = (label) => `<svg xmlns="http://www.w3.org/2000/svg">${label}</svg>`;

describe('custom designs (uploaded templates as products)', () => {
  let app, server, base, root;

  function writeTemplate(slug, roles) {
    const dir = path.join(root, 'resources', 'canva', 'templates', slug, 'clean');
    fs.mkdirSync(dir, { recursive: true });
    for (const role of roles)
      fs.writeFileSync(path.join(dir, role + '.svg'), SVG(slug + '-' + role));
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-custom-'));
    fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
    // themes.json: a built-in theme (excluded), a public custom (product), a private
    // custom (excluded), and a public shell with NO art (excluded).
    fs.writeFileSync(
      path.join(root, 'generator', 'themes.json'),
      JSON.stringify(
        {
          bachelorette: { slug: 'bachelorette', display_he: 'רווקות', calibrated: true },
          'my-custom': {
            slug: 'my-custom',
            display_he: 'עיצוב שלי',
            visibility: 'public',
            calibrated: false,
          },
          'hidden-one': { slug: 'hidden-one', display_he: 'מוסתר', visibility: 'private' },
          'shell-one': { slug: 'shell-one', display_he: 'ריק', visibility: 'public' },
        },
        null,
        1
      ),
      'utf8'
    );
    writeTemplate('my-custom', ['fronts', 'backs', 'board']);
    writeTemplate('hidden-one', ['fronts', 'backs', 'board']);
    // shell-one: registered but NO clean SVGs on disk.

    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-custom-data-'));
    process.env.TEMPLATE_ROOT = root;
    for (const f of [
      'db.js',
      'pelecard.js',
      'notify.js',
      'content.js',
      'templates.js',
      'index.js',
    ]) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
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
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists ONLY the public, non-built-in template that has card art', async () => {
    const r = await fetch(base + '/api/custom-designs');
    expect(r.status).toBe(200);
    const { designs } = await r.json();
    const ids = designs.map((d) => d.id);
    expect(ids).toContain('my-custom');
    expect(ids).not.toContain('bachelorette'); // built-in design's theme → excluded
    expect(ids).not.toContain('hidden-one'); // private → excluded
    expect(ids).not.toContain('shell-one'); // no art on disk → excluded

    const d = designs.find((x) => x.id === 'my-custom');
    expect(d).toMatchObject({
      id: 'my-custom',
      name: 'עיצוב שלי',
      theme: 'my-custom',
      custom: true,
      hasBoard: true,
    });
    expect(d.img).toEqual({
      front: '/api/template-image/my-custom/front',
      back: '/api/template-image/my-custom/back',
      board: '/api/template-image/my-custom/board',
    });
  });

  it('omits the board slot for a custom template that ships no board.svg', async () => {
    writeTemplate('no-board', ['fronts', 'backs']);
    fs.writeFileSync(
      path.join(root, 'generator', 'themes.json'),
      JSON.stringify(
        {
          bachelorette: { slug: 'bachelorette', calibrated: true },
          'no-board': { slug: 'no-board', display_he: 'בלי לוח', visibility: 'public' },
        },
        null,
        1
      ),
      'utf8'
    );
    const { designs } = await (await fetch(base + '/api/custom-designs')).json();
    const d = designs.find((x) => x.id === 'no-board');
    expect(d).toBeTruthy();
    expect(d.hasBoard).toBe(false);
    expect(d.img.board).toBeUndefined();
    expect(d.img.front).toBe('/api/template-image/no-board/front');
  });

  it('serves a custom design picture as the template clean SVG', async () => {
    const r = await fetch(base + '/api/template-image/my-custom/front');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/image\/svg\+xml/);
    expect(await r.text()).toContain('my-custom-fronts');
  });

  it('rejects a bad slot, an unsafe slug and a traversal attempt (404)', async () => {
    expect((await fetch(base + '/api/template-image/my-custom/cover')).status).toBe(404);
    expect((await fetch(base + '/api/template-image/..%2f..%2fetc/front')).status).toBe(404);
    expect((await fetch(base + '/api/template-image/Bad_Slug/front')).status).toBe(404);
    expect((await fetch(base + '/api/template-image/nope/front')).status).toBe(404);
  });
});
