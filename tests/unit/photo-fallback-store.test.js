// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The photo-card fallback-pawn OVERRIDE store (server/photo-fallback.js): what it
// accepts, what it persists, and the reference check the upload reclaim depends
// on. The GENERATOR reads this file, so its shape is a contract — see
// docs/photo-fallback-overrides.md.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storePath = path.join(__dirname, '..', '..', 'server', 'photo-fallback.js');

const A = '/content-uploads/aaaaaaaaaaaaaaaa.png';
const B = '/content-uploads/bbbbbbbbbbbbbbbb.webp';

describe('photo-fallback override store', () => {
  let dataDir, store, file;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pawn-'));
    process.env.DATA_DIR = dataDir;
    delete require.cache[require.resolve(storePath)];
    store = require(storePath);
    file = path.join(dataDir, 'photo-fallback.json');
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  it('starts empty, so every slot uses its shipped pawn', () => {
    expect(store.getAll()).toEqual({});
    expect(store.getSlot('1')).toBe(null);
    // Nothing is written until something is actually overridden.
    expect(fs.existsSync(file)).toBe(false);
  });

  it('accepts the four slots and nothing else', () => {
    for (const s of ['1', '2', '3', '4']) expect(store.slotOk(s)).toBe(s);
    expect(store.slotOk(1)).toBe('1'); // a number is fine
    for (const bad of ['0', '5', '', null, undefined, '1.svg', '../1', 'x']) {
      expect(store.slotOk(bad)).toBe(null);
    }
  });

  it('stores an override and persists it across a reload', () => {
    expect(store.setSlot('2', A)).toEqual({ prev: null, displaced: [] });
    expect(store.getSlot('2')).toBe(A);
    expect(read()).toEqual({ slots: { 2: A } });

    // A fresh require (a redeploy) sees it — the point of living on DATA_DIR.
    delete require.cache[require.resolve(storePath)];
    const reloaded = require(storePath);
    expect(reloaded.getSlot('2')).toBe(A);
  });

  it('replacing a slot reports the displaced path so the caller can reclaim it', () => {
    store.setSlot('1', A);
    expect(store.setSlot('1', B)).toEqual({ prev: A, displaced: [A] });
    expect(store.getSlot('1')).toBe(B);
  });

  it('re-setting a slot to the SAME image displaces nothing', () => {
    // Reporting it as displaced would have the caller delete the file the slot
    // still points at.
    store.setSlot('1', A);
    expect(store.setSlot('1', A)).toEqual({ prev: null, displaced: [] });
    expect(store.getSlot('1')).toBe(A);
  });

  it('reset REMOVES the override rather than storing a copy of the default', () => {
    store.setSlot('3', A);
    expect(store.resetSlot('3')).toEqual({ prev: A, displaced: [A] });
    expect(store.getSlot('3')).toBe(null);
    // Absent, not null-valued: absence is what "use the shipped pawn" means.
    expect(read().slots['3']).toBe(undefined);
    // Resetting an already-default slot is a no-op, not an error.
    expect(store.resetSlot('3')).toEqual({ prev: null, displaced: [] });
  });

  it('refuses a path this server did not produce', () => {
    for (const bad of [
      'https://evil.example/x.png',
      '/content-uploads/../../etc/passwd',
      '/content-uploads/nothex.png',
      '/content-uploads/aaaaaaaaaaaaaaaa.svg', // SVG is never one of ours
      '',
      null,
    ]) {
      expect(() => store.setSlot('1', bad)).toThrow();
    }
    expect(store.getAll()).toEqual({});
  });

  it('refuses a bad slot', () => {
    expect(() => store.setSlot('9', A)).toThrow();
    expect(() => store.resetSlot('9')).toThrow();
  });

  it('reports whether an upload is still referenced, so shared bytes survive', () => {
    // Uploads are content-addressed, so the same file can back several slots.
    store.setSlot('1', A);
    store.setSlot('4', A);
    expect(store.isImageReferenced(A)).toBe(true);
    store.resetSlot('1');
    expect(store.isImageReferenced(A)).toBe(true); // slot 4 still uses it
    store.resetSlot('4');
    expect(store.isImageReferenced(A)).toBe(false);
    expect(store.isImageReferenced('')).toBe(false);
  });

  it('sanitizes a hand-edited or restored file instead of trusting it', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        slots: {
          1: A,
          2: 'https://evil.example/x.png', // off-origin
          5: B, // not a slot
          3: { img: B }, // wrong type
        },
        junk: true,
      }),
      'utf8'
    );
    store._reload();

    expect(store.getAll()).toEqual({ 1: A });
  });

  it('survives a corrupt file rather than throwing at boot', () => {
    fs.writeFileSync(file, 'not json at all', 'utf8');
    store._reload();
    expect(store.getAll()).toEqual({});
  });
  // ---- auto-centred uploads: the original and the centred copy, both kept ----
  const C = '/content-uploads/cccccccccccccccc.png';

  it('an auto-centred slot keeps both files and prints the centred one', () => {
    expect(store.setSlot('3', C, { original: A, centred: C })).toEqual({
      prev: null,
      displaced: [],
    });
    expect(store.getSlot('3')).toBe(C);
    expect(store.getVariants('3')).toEqual({ original: A, centred: C });
    // The generator reads `slots` only, so what prints is the centred file.
    expect(read().slots).toEqual({ 3: C });
    expect(read().variants).toEqual({ 3: { original: A, centred: C } });
    // Both files are referenced, so neither is reclaimed while the slot holds them.
    expect(store.isImageReferenced(A)).toBe(true);
    expect(store.isImageReferenced(C)).toBe(true);
  });

  it('switching to the original and back changes what prints and deletes nothing', () => {
    store.setSlot('3', C, { original: A, centred: C });
    expect(store.useVariant('3', 'original')).toEqual({ img: A });
    expect(read().slots).toEqual({ 3: A });
    expect(store.isImageReferenced(C)).toBe(true);
    expect(store.useVariant('3', 'centred')).toEqual({ img: C });
    expect(read().slots).toEqual({ 3: C });
    expect(store.useVariant('2', 'original').error).toBeTruthy(); // no pair there
    expect(store.useVariant('3', 'sideways').error).toBeTruthy();
  });

  it('replacing or resetting an auto-centred slot gives up BOTH of its files', () => {
    store.setSlot('3', C, { original: A, centred: C });
    expect(store.setSlot('3', B).displaced.sort()).toEqual([A, C].sort());
    expect(store.getVariants('3')).toBe(null);
    store.setSlot('3', C, { original: A, centred: C });
    expect(store.resetSlot('3').displaced.sort()).toEqual([A, C].sort());
    expect(read()).toEqual({ slots: {} });
  });

  it('a variant pair that no longer matches its slot is dropped on load', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        slots: { 1: A, 2: B },
        // 1: the slot holds neither file of its pair. 2: a half pair. 4: no slot.
        variants: {
          1: { original: B, centred: C },
          2: { original: B },
          4: { original: A, centred: C },
        },
      })
    );
    store._reload();
    expect(store.getVariants('1')).toBe(null);
    expect(store.getVariants('2')).toBe(null);
    expect(store.getVariants('4')).toBe(null);
    expect(store.getAll()).toEqual({ 1: A, 2: B });
  });
});
