// @vitest-environment node
// server/template-pics.js — the shop's pictures of an uploaded design as a WebP ladder of its template SVGs. What these pin:
//   1. off unless TEMPLATE_PICS=on or the deployed image; a local server and the E2E suite never render;
//   2. the render is handed exactly the SVGs /api/template-image serves, each at its ladder's top rung;
//   3. a change to the artwork is a new rev: a new URL, a new render, the old rev swept;
//   4. the pictures and the home art share ONE render lane: never two Chrome renders at once;
//   5. /api/custom-designs carries `pics`, /template-pics/ serves them for a year, and /api/template-image still serves
//      the original SVG, byte for byte (the deck and the print read the template files, which are never touched).
// Chrome is faked here (generator/test_svg_picture.py renders for real).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const { createTemplatePics, LADDER } = require(path.join(serverDir, 'template-pics.js'));
const { createHomeArt, createLane, enabled } = require(path.join(serverDir, 'home-art.js'));

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
async function settle(...arts) {
  for (let i = 0; i < 400 && !arts.every((a) => a.idle()); i++) await tick();
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// A fake generator: records each spawn's argv and "renders" every role=<svg>:<width> it was given as a PNG that wide.
function fakeSpawn(log) {
  return (bin, args) => {
    log.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      const [, outDir, ...specs] = args;
      fs.mkdirSync(outDir, { recursive: true });
      const out = {};
      for (const s of specs) {
        const [, role, , w] = /^(front|back|board)=(.+):(\d+)$/.exec(s);
        const file = path.join(outDir, role + '.png');
        png(file, Number(w), Math.round(Number(w) * 1.4));
        out[role === 'front' ? 'card' : role] = file;
      }
      child.stdout.emit('data', JSON.stringify(out) + '\n');
      child.emit('close', 0);
    }, 0);
    return child;
  };
}

// A template root with one uploaded (sheet-layout) design whose filled SVGs are the shop's pictures.
function templateRoot({ board = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-pics-root-'));
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify({
      'my-custom': { slug: 'my-custom', display_he: 'שלי', visibility: 'public' },
    })
  );
  const filled = path.join(root, 'resources', 'canva', 'templates', 'my-custom', 'filled');
  fs.mkdirSync(filled, { recursive: true });
  const svg = (fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="299" height="416" viewBox="0 0 223.92 312"><rect width="223.92" height="312" fill="${fill}"/></svg>`;
  fs.writeFileSync(path.join(filled, 'fronts.svg'), svg('#f00'));
  fs.writeFileSync(path.join(filled, 'backs.svg'), svg('#0f0'));
  if (board) fs.writeFileSync(path.join(filled, 'board.svg'), svg('#00f'));
  return { root, filled, svg };
}

describe('template pictures: when they render at all', () => {
  it('is off on a local server and in the E2E suite, on in the deployed image, and TEMPLATE_PICS overrides both', () => {
    expect(enabled({}, 'TEMPLATE_PICS')).toBe(false);
    expect(enabled({ NODE_ENV: 'production' }, 'TEMPLATE_PICS')).toBe(true);
    expect(enabled({ NODE_ENV: 'production', TEMPLATE_PICS: 'off' }, 'TEMPLATE_PICS')).toBe(false);
    expect(enabled({ TEMPLATE_PICS: 'on' }, 'TEMPLATE_PICS')).toBe(true);
    // its own switch: turning the home art off does not turn the shop pictures off
    expect(enabled({ NODE_ENV: 'production', HOME_ART: 'off' }, 'TEMPLATE_PICS')).toBe(true);
  });
});

describe('template pictures: the render and its revisions', () => {
  it('rasterizes exactly the SVGs the shop shows, each at its top rung, and hands back a WebP ladder', async () => {
    const t = templateRoot();
    const templates = require(path.join(serverDir, 'templates.js'));
    const spawns = [];
    const pics = createTemplatePics({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-pics-data-')),
      on: true,
      log: () => {},
      fingerprint: () => sha(path.join(t.filled, 'fronts.svg')),
      imagePath: (slug, slot) => templates.templateImagePath(t.root, slug, slot),
      spawnRender: fakeSpawn(spawns),
      resize: async (src, dest) => (fs.copyFileSync(src, dest), true),
    });
    expect(pics.artFor('my-custom', {})).toBeNull(); // never waits for a render
    await settle(pics);
    expect(spawns).toHaveLength(1);
    const [script, , ...specs] = spawns[0];
    expect(path.basename(script)).toBe('svg_picture.py');
    expect(specs).toEqual([
      `front=${templates.templateImagePath(t.root, 'my-custom', 'front')}:${Math.max(...LADDER.front)}`,
      `back=${templates.templateImagePath(t.root, 'my-custom', 'back')}:${Math.max(...LADDER.back)}`,
      `board=${templates.templateImagePath(t.root, 'my-custom', 'board')}:${Math.max(...LADDER.board)}`,
    ]);
    const art = pics.artFor('my-custom', {});
    expect(art.front.src).toMatch(/^\/template-pics\/my-custom\/[a-f0-9]{16}\/front-400\.webp$/);
    expect(art.front.srcset.split(', ').map((p) => p.split(' ')[1])).toEqual([
      '400w',
      '800w',
      '1200w',
    ]);
    expect(art.board.srcset.split(', ').map((p) => p.split(' ')[1])).toEqual([
      '800w',
      '1400w',
      '2000w',
    ]);
  });

  it('names only the pictures the template has', async () => {
    const t = templateRoot({ board: false });
    const templates = require(path.join(serverDir, 'templates.js'));
    const spawns = [];
    const pics = createTemplatePics({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-pics-data-')),
      on: true,
      log: () => {},
      fingerprint: () => 'a',
      imagePath: (slug, slot) => templates.templateImagePath(t.root, slug, slot),
      spawnRender: fakeSpawn(spawns),
      resize: async (src, dest) => (fs.copyFileSync(src, dest), true),
    });
    pics.artFor('my-custom', {});
    await settle(pics);
    expect(spawns[0].slice(2).map((s) => s.split('=')[0])).toEqual(['front', 'back']);
    expect(pics.artFor('my-custom', {}).board).toBeUndefined();
  });

  it('a replaced card is a new rev: new URLs, a new render, the old rev swept', async () => {
    const t = templateRoot();
    const templates = require(path.join(serverDir, 'templates.js'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-pics-data-'));
    const clock = { t: 0 };
    const spawns = [];
    const pics = createTemplatePics({
      dataDir,
      on: true,
      log: () => {},
      now: () => clock.t,
      // the artwork as it is on disk, the way index.js templateFingerprint reads it
      fingerprint: () => sha(path.join(t.filled, 'fronts.svg')),
      imagePath: (slug, slot) => templates.templateImagePath(t.root, slug, slot),
      spawnRender: fakeSpawn(spawns),
      resize: async (src, dest) => (fs.copyFileSync(src, dest), true),
    });
    pics.artFor('my-custom', {});
    await settle(pics);
    const before = pics.artFor('my-custom', {});
    const oldRev = before.front.src.split('/')[3];

    fs.writeFileSync(path.join(t.filled, 'fronts.svg'), t.svg('#123456')); // the owner replaces the card
    clock.t += 60 * 1000; // past the fingerprint's trust window
    expect(pics.artFor('my-custom', {})).toBeNull(); // the old ladder is no longer handed out
    await settle(pics);
    const after = pics.artFor('my-custom', {});
    expect(spawns).toHaveLength(2);
    expect(after.front.src).not.toBe(before.front.src);
    expect(fs.existsSync(path.join(dataDir, 'template-pics', 'my-custom', oldRev))).toBe(false);
    expect(pics.fileFor('my-custom', oldRev, 'front-400.webp')).toBeNull();
  });

  it('shares one lane with the home art: never two renders at once', async () => {
    const lane = createLane();
    let live = 0;
    let maxLive = 0;
    const slow = async (job) => {
      live++;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, 5));
      fs.mkdirSync(job.outDir, { recursive: true });
      const card = path.join(job.outDir, 'card.png');
      png(card, 1200, 1669);
      live--;
      return { card };
    };
    const base = {
      on: true,
      log: () => {},
      fingerprint: () => 'a',
      lane,
      render: slow,
      resize: async (src, dest) => (fs.copyFileSync(src, dest), true),
    };
    const home = createHomeArt({
      ...base,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-pics-lane-')),
    });
    const pics = createTemplatePics({
      ...base,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-pics-lane-')),
      imagePath: () => null,
    });
    for (const slug of ['a-one', 'b-two', 'c-three']) {
      home.artFor(slug, {});
      pics.artFor(slug, {});
    }
    await settle(home, pics);
    expect(maxLive).toBe(1);
    expect(pics.artFor('a-one', {})).not.toBeNull();
    expect(home.artFor('a-one', {})).not.toBeNull();
  });

  it('keeps the home art’s revisions as they were, so production renders nothing again for this change', () => {
    // the rev of a home art built with no new options is the one main computed: same inputs, same hash
    const home = createHomeArt({
      dataDir: os.tmpdir(),
      on: false,
      fingerprint: () => 'fp',
    });
    const { REV, sampleFor } = require(path.join(serverDir, 'home-art.js'));
    const expected = crypto
      .createHash('sha256')
      .update([REV, 'my-custom', 'fp', JSON.stringify(sampleFor({}))].join('\n'))
      .digest('hex')
      .slice(0, 16);
    expect(home.revFor('my-custom', {})).toBe(expected);
  });
});

describe('template pictures: the routes', () => {
  it('/api/custom-designs carries `pics` beside `img`; /template-pics/ serves them for a year; the SVG is untouched', async () => {
    const express = require(require.resolve('express', { paths: [serverDir] }));
    const t = templateRoot();
    const prevData = process.env.DATA_DIR;
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-pics-env-'));
    const templates = require(path.join(serverDir, 'templates.js'));
    const { registerStorefrontTemplates } = require(path.join(serverDir, 'routes', 'catalog.js'));
    const frontSvg = templates.templateImagePath(t.root, 'my-custom', 'front');
    const original = fs.readFileSync(frontSvg);
    const spawns = [];
    const pics = createTemplatePics({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tpl-pics-data-')),
      on: true,
      log: () => {},
      fingerprint: () => sha(frontSvg),
      imagePath: (slug, slot) => templates.templateImagePath(t.root, slug, slot),
      spawnRender: fakeSpawn(spawns),
      resize: async (src, dest) => (fs.copyFileSync(src, dest), true),
    });
    const app = express();
    registerStorefrontTemplates(app, {
      requireAdmin: (req, res, next) => next(),
      fs,
      path,
      __dirname: serverDir,
      pathToFileURL,
      TEMPLATE_ROOT: t.root,
      templates,
      templatePics: pics,
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const [first] = (await (await fetch(base + '/api/custom-designs')).json()).designs;
      expect(first.img.front).toBe('/api/template-image/my-custom/front');
      expect(first.pics).toBeUndefined(); // not rendered yet: the shop keeps the SVG
      await settle(pics);
      const [d] = (await (await fetch(base + '/api/custom-designs')).json()).designs;
      expect(d.img.front).toBe('/api/template-image/my-custom/front'); // still the fallback
      expect(d.pics.front.src).toMatch(
        /^\/template-pics\/my-custom\/[a-f0-9]{16}\/front-400\.webp$/
      );
      const res = await fetch(base + d.pics.front.src);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/webp');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(
        (await fetch(base + '/template-pics/my-custom/0000000000000000/front-400.webp')).status
      ).toBe(404);
      expect(
        (await fetch(base + '/template-pics/my-custom/..%2F..%2Fx/front-400.webp')).status
      ).toBe(404);
      // the original picture is still what /api/template-image serves, and the file the deck prints from is unchanged
      const svg = await fetch(base + '/api/template-image/my-custom/front');
      expect(svg.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
      expect(await svg.text()).toContain('fill="#f00"');
      expect(fs.readFileSync(frontSvg).equals(original)).toBe(true);
    } finally {
      server.close();
      if (prevData === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevData;
    }
  });
});
