// @vitest-environment node
//
// server/asset-hashing.js is the durable fix for the 9 Aug store outage: a stable
// JS filename let a CDN edge pair a day-old design-images.js (no `SIZES` export)
// with a fresh index.html that imported it, the page module died on its import
// line, and the store rendered empty. Content-hashing the module url makes a stale
// pairing impossible. These tests pin the properties that guarantee that.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const assetHashing = require('../../server/asset-hashing.js');

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-hashing-'));
  fs.mkdirSync(path.join(dir, 'js', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'js', 'design-images.js'), 'export const SIZES = {};\n');
  fs.writeFileSync(path.join(dir, 'js', 'sub', 'b.js'), 'export const b = 1;\n');
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8" />' +
      '<script>1</script>' +
      '<script type="module" src="js/design-images.js"></script>' +
      '</head><body></body></html>'
  );
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('asset-hashing', () => {
  it('maps every module (nested included) to an 8-hex content-hashed url', () => {
    const a = assetHashing.build(dir);
    expect(a.forward.get('/js/design-images.js')).toMatch(/^\/js\/design-images\.[0-9a-f]{8}\.js$/);
    expect(a.forward.get('/js/sub/b.js')).toMatch(/^\/js\/sub\/b\.[0-9a-f]{8}\.js$/);
  });

  it('resolveHashed round-trips to the real file and rejects an unknown hash', () => {
    const a = assetHashing.build(dir);
    const hashed = a.forward.get('/js/design-images.js');
    expect(a.resolveHashed(hashed)).toBe(path.join(dir, 'js', 'design-images.js'));
    expect(a.resolveHashed('/js/design-images.deadbeef.js')).toBeNull();
  });

  it('injects exactly one import map immediately before the first module script', () => {
    const a = assetHashing.build(dir);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const out = a.inject(html);
    const mapIdx = out.indexOf('<script type="importmap"');
    const modIdx = out.search(/<script\b[^>]*type\s*=\s*["']?module/i);
    expect(mapIdx).toBeGreaterThanOrEqual(0);
    expect(mapIdx).toBeLessThan(modIdx);
    expect(out.split('<script type="importmap"').length - 1).toBe(1);
    expect(out).toContain(a.forward.get('/js/design-images.js'));
  });

  it('leaves a page with no module scripts untouched', () => {
    const a = assetHashing.build(dir);
    const plain = '<!doctype html><html><head></head><body>hi</body></html>';
    expect(a.inject(plain)).toBe(plain);
  });

  it('mints a new hash when the bytes change (self-busting)', () => {
    const before = assetHashing.build(dir).forward.get('/js/design-images.js');
    fs.writeFileSync(
      path.join(dir, 'js', 'design-images.js'),
      'export const SIZES = { rail: "100vw" };\n'
    );
    const after = assetHashing.build(dir).forward.get('/js/design-images.js');
    expect(after).not.toBe(before);
  });
});
