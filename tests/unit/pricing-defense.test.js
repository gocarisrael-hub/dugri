// @vitest-environment node
// Defense-in-depth for the charge path: even a CORRUPT on-disk pricing override
// (one that bypassed validateValue — a hand-edited/rolled-back settings.json) can
// never make the server charge — or SHOW — a 0/garbage price. db.versionPrice
// and db.effectivePricing (the single source shared with GET /api/pricing) both
// fall back to the built-in registry default, so display always matches charge.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let db;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-pricing-defense-'));
  process.env.DATA_DIR = dir;
  // Write a corrupt override DIRECTLY to disk (simulating corruption / a write
  // that bypassed validateValue): a version price of 0 and a non-integer store
  // price. Then load settings + db fresh so they read this file.
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ pricing: { pickup_price: 0, custom_price: -5, store_now: 'oops' } }),
    'utf8'
  );
  delete require.cache[require.resolve(path.join(serverDir, 'settings.js'))];
  delete require.cache[require.resolve(path.join(serverDir, 'db.js'))];
  db = require(path.join(serverDir, 'db.js'));
});

describe('corrupt pricing override falls back to the built-in default (never 0/garbage)', () => {
  it('the charge path (effectivePricing.versions) never returns a 0/negative version price', () => {
    const p = db.effectivePricing();
    // pickup_price=0 and custom_price=-5 on disk → the registry defaults win.
    expect(p.versions.pickup.price).toBe(199);
    expect(p.versions.custom.price).toBe(599);
    // Every version price is a positive integer.
    for (const v of Object.values(p.versions)) {
      expect(Number.isInteger(v.price)).toBe(true);
      expect(v.price).toBeGreaterThanOrEqual(1);
    }
  });

  it('a non-integer store price falls back to the default (not shown as 0)', () => {
    const p = db.effectivePricing();
    expect(p.store.now).toBe(199);
    expect(p.store.was).toBe(239);
  });

  it('setOrder charges the fallback default, not the corrupt 0', () => {
    const c = db.createCollection('בדיקת חוסן');
    const o = db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    expect(o.total).toBe(199);
  });
});
