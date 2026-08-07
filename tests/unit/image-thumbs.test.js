// @vitest-environment node
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';

// server/image-thumbs.js — the DOWNSCALED DERIVATIVES of a gallery upload.
//
// It exists to keep camera-resolution owner photographs off surfaces that paint
// them 163 px wide. The contract that matters most is the failure one: when the
// resize cannot run — no Python, no Pillow, an undecodable upload — it must yield
// NOTHING for THAT picture, so the caller 404s and the client falls back.
// Falling back to the original would put the multi-MB page back; failing globally
// would take the whole catalog down with one bad file.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-thumbs-'));
process.env.DATA_DIR = tmpRoot;
const imageThumbs = require(path.join(__dirname, '..', '..', 'server', 'image-thumbs.js'));

const uploadDir = path.join(tmpRoot, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

/** A PNG whose IHDR really says WxH — the module reads the source's dimensions
 *  to decide the ladder, so a header of zeroes is not a usable fixture. Only the
 *  header matters here: the resizer itself is stubbed. */
function pngOf(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    len,
    Buffer.from('IHDR'),
    ihdr,
    Buffer.alloc(4), // CRC — never checked
  ]);
}
const PNG = pngOf(2400, 1600);
// Derivative bytes only need to be TYPEABLE by magic (the module sniffs the
// written file for its content type).
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(16),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]);

// The rung every test asks for unless it cares about a specific one.
const RUNG = 400;

let name = '';
function upload(bytes = PNG) {
  // A distinct 16-hex name per test so no test can be served another's cache.
  name = Math.random().toString(16).slice(2).padEnd(16, '0').slice(0, 16) + '.png';
  fs.writeFileSync(path.join(uploadDir, name), bytes);
  return name;
}

// A stub in the shape of child_process.spawn: writes `out` to the DEST argument
// (argv is [script, src, dest, width]) and exits with `code`. `runs` counts the
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

const get = (n, opts, rung = RUNG) => imageThumbs.get(n, rung, { uploadDir, ...opts });

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

  // The in-flight map must be EMPTY once a request settles, on every path. The
  // missing-source path is the one that finishes without ever awaiting, and it
  // used to leave its resolved promise behind — a leak any client could drive by
  // asking for well-formed names that aren't there.
  it('leaves nothing behind in the in-flight map, however a request ends', async () => {
    await get('0123456789abcdef.png', { runner: fakeSpawn({}) });
    await get(name, { runner: fakeSpawn({}) });
    await get(upload(), { runner: fakeSpawn({ code: 1, out: null }) });
    await Promise.all([get(upload(), { runner: fakeSpawn({}) }), get(name, {})]);
    expect(imageThumbs._inflight.size).toBe(0);
  });

  // …and a missing source is NOT blacklisted: uploads are content-addressed, so
  // the same bytes always land on the same name and it can legitimately appear.
  it('a missing source is retried once the file exists', async () => {
    const later = Math.random().toString(16).slice(2).padEnd(16, '0').slice(0, 16) + '.png';
    expect(await get(later, { runner: fakeSpawn({}) })).toBe(null);
    fs.writeFileSync(path.join(uploadDir, later), PNG);
    expect(await get(later, { runner: fakeSpawn({}) })).toBeTruthy();
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

// INVARIANT 3. An earlier attempt turned the per-image failure memo into a
// module-global streak that also aborted already-queued jobs, so three unrelated
// bad uploads 404'd the entire catalog. These tests pin the isolation directly:
// they prove a healthy picture still resolves WHILE a broken one is failing.
describe('image-thumbs — a failure is scoped to ONE picture', () => {
  it('a broken upload does not stop a healthy one, however many fail first', async () => {
    const broken = [upload(), upload(), upload(), upload(), upload()];
    for (const b of broken) {
      expect(await get(b, { runner: fakeSpawn({ code: 1, out: null }) })).toBe(null);
    }
    // A different picture, resized by a working resizer, must still come back.
    const healthy = upload();
    const ok = await get(healthy, { runner: fakeSpawn({}) });
    expect(ok, 'a healthy picture was taken down by other pictures failing').toBeTruthy();
    expect(ok.type).toBe('image/webp');
  });

  it('failing at one rung does not blacklist the OTHER rungs of the same picture', async () => {
    const n = upload();
    // 1600 fails (say, an OOM on the biggest resize)…
    expect(await get(n, { runner: fakeSpawn({ code: 1, out: null }) }, 1600)).toBe(null);
    // …but the small rung, which is what the grid actually asks for, still works.
    expect(await get(n, { runner: fakeSpawn({}) }, 400)).toBeTruthy();
  });

  it('a child killed by a SIGNAL is recorded, so it cannot re-spawn forever', async () => {
    // `close` with a null code and a signal is how a timeout kill / OOM arrives.
    const killed = (runs) => () => {
      runs.n++;
      const child = new EventEmitter();
      setTimeout(() => child.emit('close', null, 'SIGKILL'), 0);
      return child;
    };
    const runs = { n: 0 };
    const n = upload();
    expect(await get(n, { runner: killed(runs) })).toBe(null);
    expect(await get(n, { runner: killed(runs) })).toBe(null);
    expect(await get(n, { runner: killed(runs) })).toBe(null);
    // Recorded after the FIRST kill — a pathological image must not keep
    // spawning Python on every request.
    expect(runs.n).toBe(1);
  });

  it('never runs more than MAX_PARALLEL resizes at once, and drops none of them', async () => {
    // The load valve is a QUEUE, not a breaker: pressure must delay work, never
    // shed it. Twelve distinct pictures, all of which must come back.
    let live = 0;
    let peak = 0;
    const slow = (_bin, argv) => {
      live++;
      peak = Math.max(peak, live);
      const child = new EventEmitter();
      setTimeout(() => {
        fs.writeFileSync(argv[2], WEBP);
        live--;
        child.emit('close', 0);
      }, 5);
      return child;
    };
    const names = Array.from({ length: 12 }, () => upload());
    const all = await Promise.all(names.map((n) => get(n, { runner: slow })));
    expect(all.every(Boolean), 'a queued resize was dropped instead of delayed').toBe(true);
    expect(peak).toBeLessThanOrEqual(2); // DESIGN_THUMB_PARALLEL default
    expect(imageThumbs._inflight.size).toBe(0);
  });
});

describe('image-thumbs — the ladder', () => {
  it('only serves rungs the module publishes', async () => {
    const runs = { n: 0 };
    // 137 is not a rung. Serving arbitrary widths would let any client spawn an
    // unbounded number of distinct resizes.
    expect(await get(name, { runner: fakeSpawn({ runs }) }, 137)).toBe(null);
    expect(runs.n).toBe(0);
  });

  it('two rungs ABOVE the source width share one file rather than duplicating it', async () => {
    const small = upload(pngOf(300, 200));
    const runs = { n: 0 };
    const a = await get(small, { runner: fakeSpawn({ runs }) }, 800);
    const b = await get(small, { runner: fakeSpawn({ runs }) }, 1600);
    expect(a).toBeTruthy();
    expect(b.file).toBe(a.file); // same effective width (300) ⇒ same cache entry
    expect(runs.n).toBe(1);
    expect(a.width).toBe(300);
  });

  it('asks the resizer for exactly the width it advertises', async () => {
    const seen = [];
    const spy = (_bin, argv) => {
      seen.push(Number(argv[3]));
      const child = new EventEmitter();
      setTimeout(() => {
        fs.writeFileSync(argv[2], WEBP);
        child.emit('close', 0);
      }, 0);
      return child;
    };
    const n = upload(pngOf(2400, 1600));
    const cands = imageThumbs.candidatesForDims({ w: 2400, h: 1600 });
    for (const c of cands) await get(n, { runner: spy }, c.rung);
    // The width handed to Python IS the descriptor published for that rung.
    expect(seen).toEqual(cands.map((c) => c.w));
  });
});

describe('image-thumbs — the real resizer', () => {
  it('generator/thumb_image.py is where the module says it is', () => {
    expect(fs.existsSync(imageThumbs._script)).toBe(true);
  });
});
