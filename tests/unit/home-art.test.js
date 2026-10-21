// @vitest-environment node
// server/home-art.js — the homepage's pictures of an uploaded design, rendered by the generator. What these pin:
//   1. off unless HOME_ART=on or the deployed image (NODE_ENV=production): a local server and the E2E suite never render;
//   2. a design's art is served only for its artwork AS IT IS NOW: a change is a new rev, a new URL, a new render, and
//      the older rev is swept once the new one is ready;
//   3. renders run one at a time and a request never waits for one;
//   4. a failed render is remembered per (design, rev): not retried in a loop, retried after the next change;
//   5. the ladder never upscales, and the files are confined to the art dir by the shape of their URL;
//   6. /api/custom-designs carries `home` once the art is ready, and /home-art/ serves it immutable.
// The generator is faked (it is Chrome, ~15 s a render); the routes are the real ones from server/routes/catalog.js.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const { createHomeArt, enabled, sampleFor, boardScaleFor, LADDER } = require(
  path.join(serverDir, 'home-art.js')
);

// a real (tiny-bodied) PNG of a given size: the module reads the width from its header
function png(file, w, h) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(Buffer.alloc(h * (1 + w * 3)))),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(art) {
  for (let i = 0; i < 200 && !art.idle(); i++) await tick();
}

function rig({ fail = () => false, board = true, slowRender } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-home-art-'));
  const fp = { value: 'a' };
  const calls = [];
  let live = 0;
  let maxLive = 0;
  const art = createHomeArt({
    dataDir,
    on: true,
    fingerprint: () => fp.value,
    log: () => {},
    render: async (job) => {
      calls.push(job);
      live++;
      maxLive = Math.max(maxLive, live);
      try {
        if (slowRender) await slowRender();
        else await tick();
        if (fail(job)) throw new Error('uncalibrated');
        fs.mkdirSync(job.outDir, { recursive: true });
        const out = {
          card: path.join(job.outDir, 'card.png'),
          back: path.join(job.outDir, 'back.png'),
        };
        png(out.card, 1495, 2080);
        png(out.back, 1495, 2080);
        if (board) {
          out.board = path.join(job.outDir, 'board.png');
          png(out.board, 2500, 1768); // narrower than the top rung: that rung must collapse onto it
        }
        return out;
      } finally {
        live--;
      }
    },
    resize: async (src, dest) => {
      fs.copyFileSync(src, dest);
      return true;
    },
  });
  return { art, dataDir, fp, calls, maxLive: () => maxLive };
}

describe('home art: when it renders at all', () => {
  it('is off on a local server and in the E2E suite, on in the deployed image, and HOME_ART overrides both', () => {
    expect(enabled({})).toBe(false);
    expect(enabled({ NODE_ENV: 'test' })).toBe(false);
    expect(enabled({ NODE_ENV: 'production' })).toBe(true);
    expect(enabled({ NODE_ENV: 'production', HOME_ART: 'off' })).toBe(false);
    expect(enabled({ HOME_ART: 'on' })).toBe(true);
  });

  it('when off, answers nothing and renders nothing', async () => {
    const calls = [];
    const art = createHomeArt({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-home-art-')),
      on: false,
      fingerprint: () => 'a',
      render: async (j) => calls.push(j),
    });
    expect(art.artFor('my-custom', {})).toBeNull();
    await tick();
    expect(calls).toHaveLength(0);
  });
});

describe('home art: a design’s art follows its artwork', () => {
  let r;
  beforeEach(() => {
    r = rig();
  });

  it('answers null at once, renders in the background, then hands the page a srcset per picture', async () => {
    expect(r.art.artFor('my-custom', { language: 'english' })).toBeNull();
    await settle(r.art);
    const home = r.art.artFor('my-custom', { language: 'english' });
    expect(Object.keys(home)).toEqual(['front', 'back', 'board']);
    const rev = r.art.revFor('my-custom', { language: 'english' });
    expect(home.front.src).toBe(`/home-art/my-custom/${rev}/front-400.webp`);
    expect(home.front.srcset).toBe(
      LADDER.front.map((w) => `/home-art/my-custom/${rev}/front-${w}.webp ${w}w`).join(', ')
    );
    // the board's render is 2500 px: the 3000 rung is not invented, it collapses onto what exists
    expect(home.board.srcset.split(', ').map((p) => p.split(' ')[1])).toEqual([
      '1200w',
      '2000w',
      '2500w',
    ]);
    for (const p of home.board.srcset.split(', ')) {
      const [, , slug, rv, file] = p.split(' ')[0].split('/');
      expect(r.art.fileFor(slug, rv, file), p).toBeTruthy();
    }
    expect(r.calls).toHaveLength(1);
  });

  it('renders with the sample name of the design’s language and its extra fields', async () => {
    r.art.artFor('my-custom', { language: 'hebrew', extra_fields: ['AGE', 'NOPE'] });
    await settle(r.art);
    expect(r.calls[0].sample).toEqual({ name: 'נועה', gender: 'female', fields: { AGE: '30' } });
    expect(sampleFor({ language: 'english' }).name).toBe('Ben');
  });

  it('a change to the design is a new rev: the old art is no longer handed out, the new is rendered, the old swept', async () => {
    r.art.artFor('my-custom', {});
    await settle(r.art);
    const oldRev = r.art.revFor('my-custom', {});
    r.fp.value = 'b'; // the owner replaced a card
    // the fingerprint is trusted for a few seconds (a hot public route); a new module instance has no cache
    const again = createHomeArt({
      dataDir: r.dataDir,
      on: true,
      fingerprint: () => r.fp.value,
      log: () => {},
      render: async () => {
        throw new Error('not this one');
      },
    });
    const newRev = again.revFor('my-custom', {});
    expect(newRev).not.toBe(oldRev);
    expect(again.artFor('my-custom', {})).toBeNull(); // stale art is not shown; the template picture is, meanwhile
    await settle(again);
    // a render that fails keeps the old rev on disk (nothing newer is ready), and shows the template picture
    expect(fs.existsSync(path.join(r.dataDir, 'home-art', 'my-custom', oldRev))).toBe(true);
  });

  it('sweeps the older rev once the newer one is ready', async () => {
    let fp = 'a';
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-home-art-'));
    const make = () =>
      createHomeArt({
        dataDir,
        on: true,
        fingerprint: () => fp,
        log: () => {},
        render: async (job) => {
          fs.mkdirSync(job.outDir, { recursive: true });
          png(path.join(job.outDir, 'c.png'), 1495, 2080);
          return { card: path.join(job.outDir, 'c.png') };
        },
        resize: async (s, d) => (fs.copyFileSync(s, d), true),
      });
    const a = make();
    a.artFor('x', {});
    await settle(a);
    const first = a.revFor('x', {});
    fp = 'b';
    const b = make();
    b.artFor('x', {});
    await settle(b);
    const second = b.revFor('x', {});
    expect(fs.readdirSync(path.join(dataDir, 'home-art', 'x'))).toEqual([second]);
    expect(second).not.toBe(first);
    expect(b.artFor('x', {}).front.src).toContain(second);
  });

  it('renders one design at a time, and each design and rev once however often the page asks', async () => {
    let release;
    const gate = new Promise((ok) => (release = ok));
    const s = rig({ slowRender: () => gate });
    for (let i = 0; i < 5; i++) {
      s.art.artFor('one', {});
      s.art.artFor('two', {});
    }
    await tick();
    expect(s.calls).toHaveLength(1); // 'two' waits; nobody waits for either
    release();
    await settle(s.art);
    expect(s.calls.map((c) => c.slug)).toEqual(['one', 'two']);
    expect(s.maxLive()).toBe(1);
  });

  it('remembers a failed render for that design and rev, and tries again after the next change', async () => {
    const s = rig({ fail: () => true });
    s.art.artFor('broken', {});
    await settle(s.art);
    for (let i = 0; i < 3; i++) s.art.artFor('broken', {});
    await settle(s.art);
    expect(s.calls).toHaveLength(1);
    expect(s.art.artFor('broken', {})).toBeNull();
    expect(s.art.state('broken', s.art.revFor('broken', {})).failed).toBe(true);
  });

  it('serves only files shaped like its own URLs', async () => {
    r.art.artFor('my-custom', {});
    await settle(r.art);
    const rev = r.art.revFor('my-custom', {});
    expect(r.art.fileFor('my-custom', rev, 'front-400.webp')).toBeTruthy();
    for (const [slug, rv, file] of [
      ['..', rev, 'front-400.webp'],
      ['my-custom', '../../etc', 'front-400.webp'],
      ['my-custom', rev, 'manifest.json'],
      ['my-custom', rev, '../front-400.webp'],
      ['my-custom', rev, 'front-401.webp'],
      ['My-Custom', rev, 'front-400.webp'],
    ])
      expect(r.art.fileFor(slug, rv, file), `${slug}/${rv}/${file}`).toBeNull();
  });

  it('sizes the board’s render to ~3400 px from the board’s own width', () => {
    const svg = (head) => () => `${head}<g/></svg>`;
    expect(
      boardScaleFor('x', svg('<svg width="1123" height="794" viewBox="0 0 842.25 595.5">'))
    ).toBe(3.03);
    expect(boardScaleFor('x', svg('<svg viewBox="0 0 1190.25 842.25">'))).toBe(2.14);
    expect(
      boardScaleFor('x', () => {
        throw new Error('no board');
      })
    ).toBe(3);
  });
});

describe('home art: the routes', () => {
  it('/api/custom-designs carries `home` once the art is ready; /home-art/ serves it for a year', async () => {
    const express = require(require.resolve('express', { paths: [serverDir] }));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-home-art-root-'));
    fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'generator', 'themes.json'),
      JSON.stringify({
        'my-custom': {
          slug: 'my-custom',
          display_he: 'שלי',
          visibility: 'public',
          language: 'english',
        },
      })
    );
    const filled = path.join(root, 'resources', 'canva', 'templates', 'my-custom', 'filled');
    fs.mkdirSync(filled, { recursive: true });
    fs.writeFileSync(path.join(filled, 'fronts.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const prevData = process.env.DATA_DIR;
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-home-art-data-'));
    const templates = require(path.join(serverDir, 'templates.js'));
    const { registerStorefrontTemplates } = require(path.join(serverDir, 'routes', 'catalog.js'));
    const s = rig();
    const app = express();
    registerStorefrontTemplates(app, {
      requireAdmin: (req, res, next) => next(),
      fs,
      path,
      __dirname: serverDir,
      pathToFileURL,
      TEMPLATE_ROOT: root,
      templates,
      homeArt: s.art,
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const first = (await (await fetch(base + '/api/custom-designs')).json()).designs;
      expect(first.map((d) => d.id)).toEqual(['my-custom']);
      expect(first[0].home).toBeUndefined();
      await settle(s.art);
      const [d] = (await (await fetch(base + '/api/custom-designs')).json()).designs;
      expect(d.img.front).toBe('/api/template-image/my-custom/front'); // still there: the page's fallback
      expect(d.home.front.src).toMatch(/^\/home-art\/my-custom\/[a-f0-9]{16}\/front-400\.webp$/);
      const res = await fetch(base + d.home.front.src);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(
        (await fetch(base + '/home-art/my-custom/0000000000000000/front-400.webp')).status
      ).toBe(404);
      expect((await fetch(base + '/home-art/my-custom/..%2F..%2Fx/front-400.webp')).status).toBe(
        404
      );
    } finally {
      server.close();
      if (prevData === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevData;
    }
  });
});
