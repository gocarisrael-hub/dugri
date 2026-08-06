// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the COMMITTED picture inventory under site/assets/designs/.
//
// Why this exists. `scripts/tokenize-svg.mjs` builds four files per design
// (front/back/board.svg + thumb.webp) but used to clear the whole tree first, so
// running it deleted the other eight — including `store.webp` and `cover.webp`,
// which are hand-authored and which `scripts/render-design-assets.mjs` states in
// as many words it "cannot regenerate". The loss was SILENT: the SVGs it did
// rewrite made the run look like a success, and the missing pictures only showed
// up later as blank tiles on the storefront.
//
// So this asserts the harm directly — the pictures are on disk — rather than the
// mechanism. It therefore catches a destructive build script, a bad rebase, a
// half-finished retirement, or anything else that drops committed artwork,
// without caring which of them did it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, '..', '..', 'site', 'assets', 'designs');

const has = (id, name) => fs.existsSync(path.join(ASSETS, id, name));
const dirs = () =>
  fs
    .readdirSync(ASSETS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

// A design folder that carries card art is a BUILT-IN one. An uploaded template
// may also have a folder here (it ships gallery renders only, its cards being
// served from the template's own SVGs), so the built-in invariants are keyed off
// the art actually being present rather than off a hardcoded list — a new or
// retired design must not need this file edited.
const builtIns = () => dirs().filter((id) => has(id, 'front.svg'));

describe('committed design pictures', () => {
  it('every built-in design keeps its full set of pictures', () => {
    const ids = builtIns();
    // Sanity: if this ever drops to nothing the loop below would vacuously pass.
    expect(ids.length).toBeGreaterThan(3);

    const missing = [];
    for (const id of ids) {
      // Produced by tokenize-svg.mjs …
      for (const f of ['front.svg', 'back.svg', 'thumb.webp']) {
        if (!has(id, f)) missing.push(`${id}/${f}`);
      }
      // … hand-authored, unregenerable …
      for (const f of ['store.webp', 'cover.webp']) {
        if (!has(id, f)) missing.push(`${id}/${f}`);
      }
      // … produced by product-thumbs.mjs.
      for (const f of ['thumb-front.webp', 'thumb-back.webp']) {
        if (!has(id, f)) missing.push(`${id}/${f}`);
      }
      for (const f of ['gallery-front.webp', 'gallery-back.webp']) {
        if (!has(id, f)) missing.push(`${id}/${f}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('a design that ships a board ships ALL of its board pictures', () => {
    // kids ships no board at all, and that is legitimate — but a design must never
    // ship a board card with no board thumbnail, or the gallery renders a hole.
    const partial = [];
    for (const id of builtIns()) {
      const parts = ['board.svg', 'thumb-board.webp', 'gallery-board.webp'];
      const present = parts.filter((f) => has(id, f));
      if (present.length !== 0 && present.length !== parts.length) {
        partial.push(`${id}: has ${present.join(', ')}`);
      }
    }
    expect(partial).toEqual([]);
  });

  it('no design folder is left empty', () => {
    // A retirement deletes the folder outright. One left behind with nothing in it
    // means a deletion got half-applied.
    const empty = dirs().filter((id) => fs.readdirSync(path.join(ASSETS, id)).length === 0);
    expect(empty).toEqual([]);
  });
});
