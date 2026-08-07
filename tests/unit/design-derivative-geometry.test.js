// @vitest-environment node
//
// INVARIANT 1 — the srcset `w` descriptor and the file it points at can never
// disagree.
//
// This is the bug that came back three times in the closed attempts: the
// descriptor was asserted independently of the resizer, so a rule change on one
// side (cap the longest side / add a height cap) silently made every portrait
// derivative NARROWER than the width it was advertised as. A browser handed
// `x.webp 400w` for a file that is 185 px wide picks the wrong candidate and
// renders it soft — and a test that only checked `size[0] <= 400` could not see it.
//
// So this test does not restate the rule. It runs REAL images through the REAL
// resizer (generator/thumb_image.py `build`) at EVERY rung the server would
// advertise, reads the pixel width back out of the bytes that were actually
// written, and asserts it equals the number the server put in the srcset. If the
// two ever drift, this fails.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATOR = path.join(REPO, 'generator');
const PY = process.env.PYTHON_BIN || 'python3';

// Pillow is what the resizer runs on. Without it there is nothing to measure, so
// skip rather than pass — a green run must mean the invariant was checked.
const HAS_PILLOW = spawnSync(PY, ['-c', 'import PIL']).status === 0;
const d = HAS_PILLOW ? describe : describe.skip;

let tmp;
let derivatives;

/**
 * Run a Python snippet with `thumb_image` importable and Pillow loaded, and
 * parse its JSON stdout. ONE process per test rather than one per rung — a
 * Python start-up is ~0.5 s and this suite would otherwise dominate CI.
 */
function py(snippet) {
  const r = spawnSync(
    PY,
    [
      '-c',
      `import json, sys
sys.path.insert(0, ${JSON.stringify(GENERATOR)})
from PIL import Image
import thumb_image
${snippet}`,
    ],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error('python failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-deriv-'));
  process.env.DATA_DIR = tmp;
  derivatives = require('../../server/image-thumbs.js');
});

d('derivative geometry — descriptor equals the produced file', () => {
  // A portrait, a landscape, a square, a very tall strip and a wide banner — the
  // ASPECT RATIOS of the owner's real uploads. The portrait (585x1266) is the
  // shape every previous attempt got wrong.
  const SHAPES = [
    ['portrait', 585, 1266],
    ['landscape', 1890, 1512],
    ['square', 1400, 1400],
    ['tall', 400, 1600],
    ['wide', 1774, 887],
  ];

  it.each(SHAPES)('%s (%ix%i): every advertised rung matches the real file', (name, w, h) => {
    // The server's OWN candidate list for a source of these dimensions — the
    // exact `w` descriptors it would put in the srcset.
    const cands = derivatives.candidatesForDims({ w, h });
    expect(cands.length).toBeGreaterThan(0);

    // Build the source, then push it through the REAL resizer once per rung, and
    // report the dimensions of each file that was actually written.
    const out = py(`
src = ${JSON.stringify(path.join(tmp, name + '.png'))}
# Real detail, not a flat fill: a flat image can encode to a handful of bytes and
# would hide an encoder that silently skipped the resize. Built by blowing up a
# small noise tile, which is far cheaper than a per-pixel Python loop.
tile = Image.merge("RGB", [Image.effect_noise((48, 48), 90) for _ in range(3)])
im = tile.resize((${w}, ${h}), Image.NEAREST)
im.save(src)
res = {}
for rung in ${JSON.stringify(cands.map((c) => c.w))}:
    dest = src + "." + str(rung) + ".out"
    thumb_image.build(src, dest, rung)
    o = Image.open(dest)
    res[str(rung)] = [o.size[0], o.size[1]]
print(json.dumps(res))`);

    for (const c of cands) {
      const [gotW, gotH] = out[String(c.w)];
      // THE invariant. Not "<= c.w" — EQUAL. A file narrower than its descriptor
      // is the bug this test exists for.
      expect(gotW, `${name} advertised ${c.w}w but the file is ${gotW}x${gotH}`).toBe(c.w);
      // The aspect ratio must survive too: a descriptor that matches because the
      // picture was squashed to fit is not a fix.
      expect(Math.abs(gotH - Math.round((h * gotW) / w))).toBeLessThanOrEqual(1);
    }
  });

  it('never advertises a rung wider than the source, and clamps one that is', () => {
    // A 250 px-wide upload must never be offered as 400w/800w/1200w/1600w: the
    // browser would pick it for a box it cannot fill sharply, and the file would
    // be 250 px regardless. The 200 rung is genuine and stays.
    const cands = derivatives.candidatesForDims({ w: 250, h: 180 });
    expect(cands.map((c) => c.w)).toEqual([200, 250]);

    const out = py(`
src = ${JSON.stringify(path.join(tmp, 'small.png'))}
Image.new("RGB", (250, 180), (12, 34, 56)).save(src)
res = {}
# Asked at its own width, and asked at a rung far ABOVE it (the public URL
# carries a fixed rung, so this request really happens): both must yield 250.
for rung in (250, 1600):
    dest = src + "." + str(rung) + ".out"
    thumb_image.build(src, dest, rung)
    res[str(rung)] = list(Image.open(dest).size)
print(json.dumps(res))`);
    expect(out['250'][0]).toBe(250);
    expect(out['1600'][0]).toBe(250);
  });
});

d('INVARIANT 4 — a transparent PNG is not composited onto black', () => {
  it('keeps the alpha channel through the resize', () => {
    // Half transparent, half opaque red. Composited onto black (the old
    // convert("RGB")) the transparent half comes back as solid black pixels.
    const out = py(`
src = ${JSON.stringify(path.join(tmp, 'alpha.png'))}
im = Image.new("RGBA", (800, 600), (255, 0, 0, 255))
# Left half fully transparent, right half opaque red.
im.paste((255, 0, 0, 0), (0, 0, 400, 600))
im.save(src)
dest = src + ".out"
thumb_image.build(src, dest, 400)
o = Image.open(dest).convert("RGBA")
print(json.dumps({"px": list(o.getpixel((o.size[0] // 5, o.size[1] // 2)))}))`);
    const [r, g, b, a] = out.px;
    // The pixel must still be TRANSPARENT. Under the old behaviour a=255 and
    // (r,g,b)=(0,0,0) — a black block where the page background should show.
    expect(a, `expected a transparent pixel, got rgba(${r},${g},${b},${a})`).toBeLessThan(16);
  });

  it('an opaque photo is not given a pointless alpha channel', () => {
    const out = py(`
src = ${JSON.stringify(path.join(tmp, 'opaque.png'))}
Image.new("RGB", (900, 600), (10, 20, 30)).save(src)
dest = src + ".out"
thumb_image.build(src, dest, 400)
print(json.dumps({"mode": Image.open(dest).mode}))`);
    expect(out.mode).toBe('RGB');
  });
});
