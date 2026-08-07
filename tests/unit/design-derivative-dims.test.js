// @vitest-environment node
//
// The srcset descriptor is `min(sourceWidth, rung)`. `sourceWidth` comes from a
// pure-JS header parse in server/image-thumbs.js, while the FILE is produced by
// Pillow — two different readers of the same bytes. If they ever disagree about
// how wide the source is, the descriptor lies, which is exactly the failure mode
// INVARIANT 1 exists to prevent.
//
// So this test crosses that bridge directly: for every format we accept and for
// all EIGHT EXIF orientations, it asserts the Node parser reports the SAME
// dimensions Pillow reports AFTER exif_transpose — which is the size
// thumb_image.py actually resizes from.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PY = process.env.PYTHON_BIN || 'python3';
const HAS_PILLOW = spawnSync(PY, ['-c', 'import PIL']).status === 0;
const d = HAS_PILLOW ? describe : describe.skip;

let tmp;
let derivatives;
// name → what Pillow reports AFTER exif_transpose, i.e. the size thumb_image.py
// actually resizes from. Built in ONE python process (a start-up is ~0.5 s, and
// this suite would otherwise need twenty of them).
let pillow;

const PLAIN = [
  ['png', 'png', 'RGB'],
  ['png-alpha', 'png', 'RGBA'],
  ['jpeg', 'jpg', 'RGB'],
  ['webp', 'webp', 'RGB'],
];
const ORIENTATIONS = [1, 2, 3, 4, 5, 6, 7, 8];

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dims-'));
  process.env.DATA_DIR = tmp;
  derivatives = require('../../server/image-thumbs.js');

  const r = spawnSync(
    PY,
    [
      '-c',
      `import json
from PIL import Image, ImageOps
tmp = ${JSON.stringify(tmp)}
out = {}
def record(name, im, **kw):
    p = tmp + "/" + name
    im.save(p, **kw)
    up = ImageOps.exif_transpose(Image.open(p))
    out[name] = [up.size[0], up.size[1]]
for label, ext, mode in ${JSON.stringify(PLAIN)}:
    fill = (7, 9, 11) + ((255,) if mode == "RGBA" else ())
    record("plain-%s.%s" % (label, ext), Image.new(mode, (913, 517), fill))
for o in ${JSON.stringify(ORIENTATIONS)}:
    im = Image.new("RGB", (800, 600), (30, 60, 90))
    ex = im.getexif()
    ex[274] = o
    record("orient-%d.jpg" % o, im, exif=ex)
print(json.dumps(out))`,
    ],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error('fixtures failed: ' + r.stderr);
  pillow = JSON.parse(r.stdout);
});

d('source dimensions — the JS header parser agrees with Pillow', () => {
  it.each(PLAIN)('%s: a plain %s file', (label, ext) => {
    const name = `plain-${label}.${ext}`;
    const f = path.join(tmp, name);
    expect(derivatives.dimsOfFile(f)).toEqual({ w: 913, h: 517 });
    const [w, h] = pillow[name];
    expect(derivatives.dimsOfFile(f)).toEqual({ w, h });
  });

  // Orientations 5..8 swap the axes. thumb_image.py runs exif_transpose BEFORE
  // fit(), so for those the descriptor must be built from the SWAPPED width. A
  // parser that returned the raw header width would advertise 800w for a file
  // Pillow writes at 600 — the same class of lie as the geometry bug.
  it.each(ORIENTATIONS)('a JPEG shot at EXIF orientation %i', (orientation) => {
    const name = `orient-${orientation}.jpg`;
    const got = derivatives.dimsOfFile(path.join(tmp, name));
    const [w, h] = pillow[name];
    expect(got, `orientation ${orientation}: parser said ${JSON.stringify(got)}`).toEqual({ w, h });
    // And the descriptor built from it must be producible: the top candidate can
    // never exceed the upright width.
    const cands = derivatives.candidatesForDims(got);
    expect(Math.max(...cands.map((c) => c.w))).toBeLessThanOrEqual(w);
  });

  it('returns null for bytes that are not a raster we can read', () => {
    const junk = path.join(tmp, 'junk.png');
    fs.writeFileSync(junk, Buffer.from('this is not an image at all, not even close'));
    expect(derivatives.dimsOfFile(junk)).toBe(null);
    expect(derivatives.dimsOfFile(path.join(tmp, 'does-not-exist.png'))).toBe(null);
    // An unreadable source yields NO candidates — so the client emits a plain
    // src and never a descriptor it cannot back up.
    expect(derivatives.candidatesForDims(null)).toEqual([]);
    expect(derivatives.candidatesForDims({ w: 0, h: 0 })).toEqual([]);
  });
});

d('the public URL carries the output revision (INVARIANT 2)', () => {
  it('puts REV in the path, so a bump cannot be masked by an immutable cache', () => {
    const url = derivatives.urlFor('0123456789abcdef.jpg', 400);
    expect(url).toContain(`/${derivatives.REV}/`);
    expect(url).toBe(`/design-img/${derivatives.REV}/400/0123456789abcdef.jpg`);
  });

  it('puts REV in the cache filename too, and sweeps the previous generation', () => {
    const dir = derivatives._cacheDir;
    fs.mkdirSync(dir, { recursive: true });
    // A file from an imagined previous revision, plus the pre-ladder format, plus
    // a live current-revision file.
    const stale = path.join(dir, 'aaaaaaaaaaaaaaaa-r0-400.der');
    const ancient = path.join(dir, 'aaaaaaaaaaaaaaaa-400.thumb');
    const current = path.join(dir, `bbbbbbbbbbbbbbbb-${derivatives.REV}-400.der`);
    for (const f of [stale, ancient, current]) fs.writeFileSync(f, 'x');

    expect(derivatives.sweepStale()).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(ancient)).toBe(false);
    // The current generation survives — a sweep must not cost a live cache.
    expect(fs.existsSync(current)).toBe(true);
  });
});
