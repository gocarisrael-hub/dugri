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
  fs.writeFileSync(path.join(dir, 'js', 'editor.js'), 'window.dugriEditor = {};\n');
  fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'css', 'tokens.css'), ':root{--price-gap:14px}\n');
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

  // ---- rewriteTags: the tags an import map never reaches --------------------

  it('hashes a classic <script src> and a stylesheet <link href>', () => {
    const a = assetHashing.build(dir);
    const html =
      '<link rel="stylesheet" href="/css/tokens.css" />' +
      '<script src="js/editor.js" defer></script>';
    const out = a.rewriteTags(html);
    expect(out).toContain('href="' + a.forward.get('/css/tokens.css') + '"');
    expect(out).toContain('src="' + a.forward.get('/js/editor.js') + '"');
    expect(out).not.toContain('href="/css/tokens.css"');
    expect(out).not.toContain('src="js/editor.js"');
  });

  it('hashes a module ENTRY src too — an import map does not', () => {
    const a = assetHashing.build(dir);
    const out = a.rewriteTags('<script type="module" src="js/design-images.js"></script>');
    expect(out).toContain(a.forward.get('/js/design-images.js'));
  });

  it('leaves foreign, absolute and query-carrying urls alone', () => {
    const a = assetHashing.build(dir);
    const html =
      '<link href="https://fonts.googleapis.com/css2?family=Heebo" rel="stylesheet" />' +
      '<script src="//cdn.example.com/js/editor.js"></script>' +
      '<script src="/js/editor.js?v=1"></script>' +
      '<a href="/products.html">shop</a>';
    expect(a.rewriteTags(html)).toBe(html);
  });

  it('does not rewrite a path that only LOOKS like ours inside prose', () => {
    const a = assetHashing.build(dir);
    const html = '<p>edit js/editor.js to change it</p>';
    expect(a.rewriteTags(html)).toBe(html);
  });

  it('a hashed stylesheet url resolves back to the real file', () => {
    const a = assetHashing.build(dir);
    const hashed = a.forward.get('/css/tokens.css');
    expect(hashed).toMatch(/^\/css\/tokens\.[0-9a-f]{8}\.css$/);
    expect(a.resolveHashed(hashed)).toBe(path.join(dir, 'css', 'tokens.css'));
  });

  it('keeps stylesheets OUT of the import map — it resolves modules only', () => {
    const a = assetHashing.build(dir);
    expect(a.importMap.imports['/js/design-images.js']).toBeTruthy();
    expect(a.importMap.imports['/css/tokens.css']).toBeUndefined();
  });

  it('mints a new hash when a stylesheet changes (the 2 Sep staleness)', () => {
    const before = assetHashing.build(dir).forward.get('/css/tokens.css');
    fs.writeFileSync(path.join(dir, 'css', 'tokens.css'), ':root{--price-gap:16px}\n');
    const after = assetHashing.build(dir).forward.get('/css/tokens.css');
    expect(after).not.toBe(before);
  });
});
