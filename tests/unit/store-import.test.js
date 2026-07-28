// @vitest-environment node
// The staging STORE mirror. This import DELETES (mirror semantics), so the tests
// that matter are the refusals and the abort paths — the happy path is the easy
// part. The rule the whole module exists to enforce: nothing is replaced until
// everything that can fail has already succeeded.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let storeImport;
let settings;
let playbook;
let designImages;
let wordlists;
let deps;
let dataDir;

const SOURCE = 'https://staging.example';

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-store-import-'));
  process.env.DATA_DIR = dataDir;
  for (const f of [
    'settings.js',
    'playbook.js',
    'design-images.js',
    'wordlists.js',
    'content.js',
    'store-import.js',
  ]) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  settings = require(path.join(serverDir, 'settings.js'));
  playbook = require(path.join(serverDir, 'playbook.js'));
  designImages = require(path.join(serverDir, 'design-images.js'));
  wordlists = require(path.join(serverDir, 'wordlists.js'));
  storeImport = require(path.join(serverDir, 'store-import.js'));
  deps = { settings, playbook, designImages, wordlists };
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  // A non-empty local state, so every "must not wipe" assertion has something to
  // lose.
  const tpl = settings.get('email', 'buyer_confirmation');
  settings.set('email', 'buyer_confirmation', { ...tpl, subject: 'LOCAL-SUBJECT' });
  playbook.replaceNotes([{ id: 'local', title: 'local note' }]);
  wordlists.replaceOwnerLists([{ name: 'local.txt', words: ['מקומי'] }]);
});

// A fetch stub that serves one stores payload and any image bytes.
function stubFetch({ stores, status = 200, imageStatus = 200, bodyOverride } = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/admin/stores/export')) {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => (bodyOverride !== undefined ? bodyOverride : { stores }),
      };
    }
    // an image
    return {
      ok: imageStatus >= 200 && imageStatus < 300,
      status: imageStatus,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    };
  });
}

const NON_EMPTY = {
  settings: { email: { buyer_confirmation: { subject: 'FROM-STAGING', body: 'b' } } },
  playbook: [{ id: 'p1', title: 'from staging' }],
  designImages: {},
  wordlists: [{ name: 'imported.txt', words: ['אחת', 'שתיים'] }],
};

describe('exportAll', () => {
  it('exports every store and nothing else — no orders, customers or secrets', () => {
    const out = storeImport.exportAll(deps);
    expect(Object.keys(out).sort()).toEqual(
      ['designImages', 'playbook', 'settings', 'wordlists'].sort()
    );
  });

  it('exports RAW settings overrides, not effective values', () => {
    const out = storeImport.exportAll(deps);
    // Only the key we actually overrode is present — mirroring effective values
    // would freeze today's defaults into the target as explicit overrides.
    expect(out.settings.email.buyer_confirmation.subject).toBe('LOCAL-SUBJECT');
    expect(Object.keys(out.settings.email)).toEqual(['buyer_confirmation']);
  });
});

describe('importFromStaging — refusals (nothing is changed)', () => {
  it('refuses when STAGING_URL is unset', async () => {
    const r = await storeImport.importFromStaging({
      stagingUrl: '',
      deps,
      fetchImpl: stubFetch({}),
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('refuses a WHOLLY EMPTY payload — a reset staging volume must not wipe prod', async () => {
    const fetchImpl = stubFetch({
      stores: { settings: {}, playbook: [], designImages: {}, wordlists: [] },
    });
    const r = await storeImport.importFromStaging({ stagingUrl: SOURCE, deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    // The local state survived untouched.
    expect(settings.get('email', 'buyer_confirmation').subject).toBe('LOCAL-SUBJECT');
    expect(playbook.exportNotes()).toHaveLength(1);
    expect(wordlists.exportOwnerLists()).toHaveLength(1);
  });

  it('refuses a non-200 from staging, naming the likely cause', async () => {
    const fetchImpl = stubFetch({ stores: NON_EMPTY, status: 404 });
    const r = await storeImport.importFromStaging({ stagingUrl: SOURCE, deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(r.error).toContain('stores/export');
    expect(settings.get('email', 'buyer_confirmation').subject).toBe('LOCAL-SUBJECT');
  });

  it('refuses a malformed payload', async () => {
    const fetchImpl = stubFetch({ bodyOverride: { stores: [1, 2, 3] } });
    const r = await storeImport.importFromStaging({ stagingUrl: SOURCE, deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(settings.get('email', 'buyer_confirmation').subject).toBe('LOCAL-SUBJECT');
  });

  it('aborts BEFORE replacing anything when a gallery image cannot be fetched', async () => {
    const stores = {
      ...NON_EMPTY,
      designImages: {
        kids: { base: { front: { img: '/content-uploads/' + 'a'.repeat(16) + '.png' } } },
      },
    };
    const fetchImpl = stubFetch({ stores, imageStatus: 500 });
    const r = await storeImport.importFromStaging({ stagingUrl: SOURCE, deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    // The images are fetched BEFORE any store is replaced, so a missing image
    // leaves every store untouched — not texts-from-staging + old images.
    expect(settings.get('email', 'buyer_confirmation').subject).toBe('LOCAL-SUBJECT');
    expect(playbook.exportNotes()[0].id).toBe('local');
    expect(wordlists.exportOwnerLists()[0].name).toBe('local.txt');
  });

  it('aborts when a backup fails — never overwrites without a recovery point', async () => {
    const spy = vi.spyOn(playbook, 'backup').mockImplementation(() => {
      throw new Error('volume full');
    });
    const fetchImpl = stubFetch({ stores: NON_EMPTY });
    const r = await storeImport.importFromStaging({ stagingUrl: SOURCE, deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('backup failed for playbook');
    // settings is backed up BEFORE playbook, but nothing is REPLACED until every
    // backup has succeeded — so settings is still local.
    expect(settings.get('email', 'buyer_confirmation').subject).toBe('LOCAL-SUBJECT');
    spy.mockRestore();
  });
});

describe('importFromStaging — the mirror', () => {
  it('replaces every store and DELETES what staging does not have', async () => {
    const fetchImpl = stubFetch({ stores: NON_EMPTY });
    const r = await storeImport.importFromStaging({ stagingUrl: SOURCE, deps, fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(['settings', 'playbook', 'designImages', 'wordlists']);

    expect(settings.get('email', 'buyer_confirmation').subject).toBe('FROM-STAGING');
    expect(playbook.exportNotes()[0].id).toBe('p1');
    const lists = wordlists.exportOwnerLists();
    expect(lists.map((l) => l.name)).toEqual(['imported.txt']);
    // Mirror: the local-only list is gone.
    expect(lists.find((l) => l.name === 'local.txt')).toBeUndefined();
  });

  it('a settings key absent from staging reverts to its DEFAULT, not the old override', async () => {
    const fetchImpl = stubFetch({
      stores: { ...NON_EMPTY, settings: { email: { pdf_ready: { subject: 's', body: 'b' } } } },
    });
    const r = await storeImport.importFromStaging({ stagingUrl: SOURCE, deps, fetchImpl });
    expect(r.ok).toBe(true);
    const def = settings.REGISTRY.email.buyer_confirmation.default.subject;
    expect(settings.get('email', 'buyer_confirmation').subject).toBe(def);
  });

  it('writes a backup for each store that had something to lose', async () => {
    const fetchImpl = stubFetch({ stores: NON_EMPTY });
    const r = await storeImport.importFromStaging({ stagingUrl: SOURCE, deps, fetchImpl });
    expect(r.ok).toBe(true);
    for (const key of ['settings', 'playbook']) {
      expect(r.backups[key], key + ' had no backup').toBeTruthy();
      expect(fs.existsSync(r.backups[key])).toBe(true);
    }
  });

  it('rejects an invalid settings value wholesale rather than applying half of it', async () => {
    const fetchImpl = stubFetch({
      stores: { ...NON_EMPTY, settings: { email: { buyer_confirmation: { subject: 42 } } } },
    });
    const r = await storeImport.importFromStaging({ stagingUrl: SOURCE, deps, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('settings');
    // settings is applied FIRST, so a rejection here means nothing was applied.
    expect(r.applied).toEqual([]);
    expect(playbook.exportNotes()[0].id).toBe('local');
  });

  it('drops settings keys this build does not know, instead of failing the import', async () => {
    const fetchImpl = stubFetch({
      stores: {
        ...NON_EMPTY,
        settings: {
          email: { buyer_confirmation: { subject: 'FROM-STAGING', body: 'b' } },
          futureSection: { whatever: true },
        },
      },
    });
    const r = await storeImport.importFromStaging({ stagingUrl: SOURCE, deps, fetchImpl });
    // A source on a newer build must not brick the import.
    expect(r.ok).toBe(true);
    expect(settings.get('email', 'buyer_confirmation').subject).toBe('FROM-STAGING');
  });
});

describe('wordlists mirror', () => {
  it('writes new lists, deletes removed ones, and leaves shipped lists alone', () => {
    wordlists.replaceOwnerLists([
      { name: 'a.txt', words: ['x'] },
      { name: 'b.txt', words: ['y'] },
    ]);
    const res = wordlists.replaceOwnerLists([{ name: 'a.txt', words: ['x', 'z'] }]);
    expect(res.written).toBe(1);
    expect(res.removed).toBe(1);
    const names = wordlists.exportOwnerLists().map((l) => l.name);
    expect(names).toEqual(['a.txt']);
    expect(wordlists.exportOwnerLists()[0].words).toEqual(['x', 'z']);
  });

  it('refuses a bad name before writing anything', () => {
    wordlists.replaceOwnerLists([{ name: 'keep.txt', words: ['1'] }]);
    expect(() => wordlists.replaceOwnerLists([{ name: '../escape', words: ['x'] }])).toThrow();
    // The pre-existing list survived the refusal.
    expect(wordlists.exportOwnerLists().map((l) => l.name)).toEqual(['keep.txt']);
  });
});
