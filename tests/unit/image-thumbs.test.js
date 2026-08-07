// @vitest-environment node
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// server/image-thumbs.js — the SMALL on-demand derivative of a gallery upload.
//
// It exists to keep a heavy owner photograph off a thumbnail-sized surface (the
// wizard's design picker). The contract that matters most is the failure one:
// when the resize cannot run — no Python, no Pillow, an undecodable upload — it
// must yield NOTHING, so the caller 404s and the client falls back to the shipped
// render. Falling back to the original would put the multi-MB page back.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-thumbs-'));
process.env.DATA_DIR = tmpRoot;
const imageThumbs = require(path.join(__dirname, '..', '..', 'server', 'image-thumbs.js'));

const uploadDir = path.join(tmpRoot, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

// Bytes only need to be TYPEABLE by magic (the module sniffs the derivative's
// own bytes for its content type) — the resizer itself is stubbed here.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(16),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]);

let name = '';
function upload(bytes = PNG) {
  // A distinct 16-hex name per test so no test can be served another's cache.
  name = Math.random().toString(16).slice(2).padEnd(16, '0').slice(0, 16) + '.png';
  fs.writeFileSync(path.join(uploadDir, name), bytes);
  return name;
}

// A stub in the shape of child_process.spawn: writes `out` to the DEST argument
// (argv is [script, src, dest, maxpx]) and exits with `code`. `runs` counts the
// spawns, so we can prove the cache and the in-flight de-duplication really do
// prevent them rather than merely appearing to.
function fakeSpawn({ code = 0, out = WEBP, runs } = {}) {
  return (_bin, argv) => {
    if (runs) runs.n++;
    const child = new EventEmitter();
    setTimeout(() => {
      if (code === 0 && out) fs.writeFileSync(argv[2], out);
      child.emit('close', code);
    }, 0);
    return child;
  };
}

beforeEach(() => {
  upload();
});
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const get = (n, opts) => imageThumbs.get(n, { uploadDir, ...opts });

describe('image-thumbs — generating a derivative', () => {
  it('produces a cached file and types it from its own bytes', async () => {
    const runs = { n: 0 };
    const thumb = await get(name, { runner: fakeSpawn({ runs }) });
    expect(thumb).toBeTruthy();
    expect(thumb.type).toBe('image/webp');
    expect(path.isAbsolute(thumb.file)).toBe(true);
    expect(fs.readFileSync(thumb.file)).toEqual(WEBP);
    expect(runs.n).toBe(1);
  });

  // Pillow is not guaranteed to be built with WebP everywhere, so the resizer
  // may legitimately hand back a JPEG. The bytes decide the content type.
  it('serves a JPEG derivative as image/jpeg', async () => {
    const thumb = await get(name, { runner: fakeSpawn({ out: JPEG }) });
    expect(thumb.type).toBe('image/jpeg');
  });

  it('a second request is served from the cache without spawning again', async () => {
    const runs = { n: 0 };
    const first = await get(name, { runner: fakeSpawn({ runs }) });
    const second = await get(name, { runner: fakeSpawn({ runs }) });
    expect(second).toEqual(first);
    expect(runs.n).toBe(1);
  });

  // A picker paints a dozen tiles at once and two shoppers can arrive together.
  it('concurrent requests for the same picture share ONE resize', async () => {
    const runs = { n: 0 };
    const runner = fakeSpawn({ runs });
    const all = await Promise.all([
      get(name, { runner }),
      get(name, { runner }),
      get(name, { runner }),
    ]);
    expect(all[0]).toEqual(all[1]);
    expect(all[1]).toEqual(all[2]);
    expect(runs.n).toBe(1);
  });

  it('leaves no temp file behind', async () => {
    await get(name, { runner: fakeSpawn({}) });
    expect(fs.readdirSync(imageThumbs._cacheDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('image-thumbs — every failure yields NOTHING, never the original', () => {
  it('a non-zero exit (broken Pillow, a corrupt upload) resolves to null', async () => {
    expect(await get(name, { runner: fakeSpawn({ code: 1, out: null }) })).toBe(null);
  });

  it('a MISSING interpreter resolves to null', async () => {
    const runner = () => {
      const child = new EventEmitter();
      setTimeout(() => child.emit('error', new Error('ENOENT python3')), 0);
      return child;
    };
    expect(await get(name, { runner })).toBe(null);
  });

  it('a spawn that throws outright resolves to null', async () => {
    expect(
      await get(name, {
        runner: () => {
          throw new Error('no child processes');
        },
      })
    ).toBe(null);
  });

  it('an exit-0 that wrote nothing usable is NOT cached as a thumbnail', async () => {
    // Exit 0 but garbage bytes: unrecognizable by magic, so there is no honest
    // content type to serve it with.
    expect(
      await get(name, { runner: fakeSpawn({ out: Buffer.from('not an image at all') }) })
    ).toBe(null);
  });

  it('a failure is remembered, so a dead resizer is not re-spawned per request', async () => {
    const runs = { n: 0 };
    expect(await get(name, { runner: fakeSpawn({ code: 1, out: null, runs }) })).toBe(null);
    expect(await get(name, { runner: fakeSpawn({ code: 0, out: WEBP, runs }) })).toBe(null);
    expect(runs.n).toBe(1);
  });

  it('an upload that does not exist resolves to null without spawning', async () => {
    const runs = { n: 0 };
    expect(await get('0123456789abcdef.png', { runner: fakeSpawn({ runs }) })).toBe(null);
    expect(runs.n).toBe(0);
  });

  // The name reaches this module straight off a URL, so it is validated to
  // EXACTLY the shape content.saveImageBytes produces — no traversal, no
  // arbitrary read, no spawn.
  it('refuses any name that is not a content-hash upload', async () => {
    const runs = { n: 0 };
    for (const bad of [
      '',
      '../../etc/passwd',
      'aaaaaaaaaaaaaaaa.svg',
      'aaaaaaaaaaaaaaa.png',
      'AAAAAAAAAAAAAAAA.png',
      'aaaaaaaaaaaaaaaa.png/../x',
      null,
      undefined,
    ]) {
      expect(await get(bad, { runner: fakeSpawn({ runs }) })).toBe(null);
    }
    expect(runs.n).toBe(0);
  });
});

describe('image-thumbs — the real resizer', () => {
  it('generator/thumb_image.py is where the module says it is', () => {
    expect(fs.existsSync(imageThumbs._script)).toBe(true);
  });
});
