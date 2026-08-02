// @vitest-environment node
// The staging TEMPLATE mirror. Unlike the store mirror this import is ADDITIVE,
// so the tests that matter are (a) the safety refusals — an unsafe key or path in
// the manifest must reject the WHOLE import, never be skipped — and (b) that a
// failure anywhere leaves the live store exactly as it was. A half-installed
// template lists in the admin UI and renders nothing, which is the failure mode
// this module exists to prevent.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const SOURCE = 'https://staging.example';

let templateImport;
let store;
let templates;
let dataDir;
// Stands in for the image's shipped template config (generator/themes.json), the
// read-only base layer an owner entry can override. 'bachelorette' is a design
// BOTH services ship; the tests below rename it on staging the way the admin UI
// does — an entry, no artwork.
let shippedRoot;

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-template-import-'));
  process.env.DATA_DIR = dataDir;
  for (const f of ['template-store.js', 'templates.js', 'template-import.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  store = require(path.join(serverDir, 'template-store.js'));
  templates = require(path.join(serverDir, 'templates.js'));
  templateImport = require(path.join(serverDir, 'template-import.js'));

  shippedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-shipped-root-'));
  fs.mkdirSync(path.join(shippedRoot, 'generator'), { recursive: true });
  fs.writeFileSync(
    path.join(shippedRoot, 'generator', 'themes.json'),
    JSON.stringify({
      bachelorette: { slug: 'bachelorette', display_he: 'רווקות', visibility: 'public' },
      japanese: { slug: 'japanese', display_he: 'יפני', visibility: 'public' },
    }),
    'utf8'
  );
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(shippedRoot, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

beforeEach(() => {
  // Reset the volume to a known state: one pre-existing owner template that no
  // import in these tests mentions, so every "must not touch what it doesn't
  // own" assertion has something to lose.
  fs.rmSync(path.join(dataDir, 'templates'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, 'templates', 'local-only', 'clean'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'templates', 'local-only', 'clean', 'board.svg'),
    '<svg>local</svg>'
  );
  templates.writeThemesFile(store.ownerThemesPath(), {
    'local-only': { display_he: 'מקומי', visibility: 'private' },
  });
});

// A fake staging service: a manifest + the file bytes it names. `overrides` lets
// one test bend a single field without restating the whole fixture.
function fakeStaging(files, opts = {}) {
  const bytes = new Map();
  const manifestFiles = [];
  for (const [id, body] of Object.entries(files)) {
    const [key, ...rest] = id.split('/');
    const rel = rest.join('/');
    const buf = Buffer.from(body);
    bytes.set(id, buf);
    manifestFiles.push({ key, rel, bytes: buf.length, sha256: sha(buf) });
  }
  const manifest = {
    themes: opts.themes || { imported: { display_he: 'מיובא', visibility: 'private' } },
    recipes: opts.recipes || {},
    files: opts.files || manifestFiles,
    ...(opts.manifest || {}),
  };
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/api/admin/templates/export/file')) {
      const u = new URL(url);
      const id = u.searchParams.get('template') + '/' + u.searchParams.get('path');
      if (opts.failFile === id) return { ok: false, status: 500 };
      const buf = opts.corruptFile === id ? Buffer.from('truncated') : bytes.get(id);
      if (!buf) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => buf };
    }
    if (url.includes('/api/admin/templates/export')) {
      if (opts.manifestStatus) return { ok: false, status: opts.manifestStatus };
      return { ok: true, status: 200, json: async () => manifest };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  return { fetchImpl, calls, manifest };
}

const run = (fakeOrOpts, extra = {}) =>
  templateImport.importFromStaging({
    stagingUrl: SOURCE,
    adminKey: 'k',
    fetchImpl: fakeOrOpts.fetchImpl,
    now: 1000,
    ...extra,
  });

// The state assertions every abort test shares: the untouched local template is
// still whole, and nothing from the attempted import landed.
function expectUntouched() {
  expect(fs.existsSync(path.join(dataDir, 'templates', 'local-only', 'clean', 'board.svg'))).toBe(
    true
  );
  expect(fs.existsSync(path.join(dataDir, 'templates', 'imported'))).toBe(false);
  expect(Object.keys(templates.loadOwnerThemes())).toEqual(['local-only']);
}

describe('template export manifest', () => {
  it('lists the owner store by file, with a digest per file', () => {
    const m = templateImport.exportManifest();
    expect(Object.keys(m.themes)).toEqual(['local-only']);
    expect(m.files).toEqual([
      {
        key: 'local-only',
        rel: 'clean/board.svg',
        bytes: 16,
        sha256: sha(Buffer.from('<svg>local</svg>')),
      },
    ]);
  });

  it('walks into font subdirectories rather than stopping at the top level', () => {
    const deep = path.join(dataDir, 'templates', 'local-only', 'fonts', 'Cafe Regular');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'Cafe Regular.ttf'), 'FONT');
    const rels = templateImport.exportManifest().files.map((f) => f.rel);
    expect(rels).toContain('fonts/Cafe Regular/Cafe Regular.ttf');
  });

  it("never offers the store's own layout files as templates", () => {
    // recipes/ and themes.json live in the store root beside the template dirs;
    // treating either as a template key would export the registry as artwork.
    fs.mkdirSync(path.join(dataDir, 'templates', 'recipes'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'templates', 'recipes', 'local-only.json'), '{"a":1}');
    const m = templateImport.exportManifest();
    expect(m.files.every((f) => f.key !== 'recipes' && f.key !== 'themes.json')).toBe(true);
    expect(m.recipes).toEqual({ 'local-only': { a: 1 } });
  });
});

describe('manifest path safety', () => {
  it('rejects traversal and absolute paths, and keeps nested ones', () => {
    expect(templateImport.safeRelPath('../../etc/passwd')).toBe(null);
    expect(templateImport.safeRelPath('/etc/passwd')).toBe(null);
    expect(templateImport.safeRelPath('clean\\..\\..\\x.svg')).toBe(null);
    expect(templateImport.safeRelPath('')).toBe(null);
    expect(templateImport.safeRelPath('fonts/Cafe/Cafe.ttf')).toBe('fonts/Cafe/Cafe.ttf');
  });

  it('resolves a download path only inside the owner dir', () => {
    expect(templateImport.ownerFilePath('local-only', 'clean/board.svg')).toBe(
      path.join(dataDir, 'templates', 'local-only', 'clean', 'board.svg')
    );
    expect(templateImport.ownerFilePath('local-only', '../themes.json')).toBe(null);
    expect(templateImport.ownerFilePath('../..', 'x')).toBe(null);
    expect(templateImport.ownerFilePath('recipes', 'x.json')).toBe(null);
  });

  it('rejects the WHOLE import when any entry is unsafe, rather than skipping it', async () => {
    const fake = fakeStaging({ 'imported/clean/board.svg': '<svg/>' });
    fake.manifest.files.push({
      key: 'imported',
      rel: '../../escape',
      bytes: 1,
      sha256: 'a'.repeat(64),
    });
    const res = await run(fake);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsafe file path/);
    expectUntouched();
  });

  it('rejects an unsafe template key', async () => {
    const fake = fakeStaging(
      { 'imported/clean/board.svg': '<svg/>' },
      { themes: { '../evil': {} } }
    );
    const res = await run(fake);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsafe template key/);
    expectUntouched();
  });
});

// Renaming a SHIPPED design in the admin UI is copy-on-write at the ENTRY level:
// the whole theme entry lands in the owner store and NO artwork is copied,
// because the artwork is in the image both services run. The importer used to
// read "theme entry, no files" as a broken registration and abort the ENTIRE
// import — so one rename on staging blocked every new design too. Observed live:
// 7 renamed shipped designs made the import fail with `template "trip comeback"
// has no files on staging`, and a brand-new design never reached production.
describe('metadata-only entries for designs we also ship', () => {
  it('imports a renamed shipped design ALONGSIDE a genuinely new one', async () => {
    const fake = fakeStaging(
      { 'imported/clean/board.svg': '<svg>new</svg>' },
      {
        themes: {
          imported: { display_he: 'מיובא', visibility: 'private' },
          // Renamed on staging: entry only, no files — exactly what the admin
          // rename writes.
          bachelorette: { slug: 'bachelorette', display_he: 'פריז', visibility: 'public' },
        },
      }
    );
    const res = await run(fake, { templateRoot: shippedRoot });
    expect(res.ok).toBe(true);
    // The new design's artwork landed...
    expect(res.added).toContain('imported');
    expect(
      fs.readFileSync(path.join(dataDir, 'templates', 'imported', 'clean', 'board.svg'), 'utf8')
    ).toBe('<svg>new</svg>');
    // ...and the rename carried over, which is the whole point of mirroring it.
    const owner = templates.loadOwnerThemes();
    expect(owner.bachelorette.display_he).toBe('פריז');
    // A metadata-only entry creates no artwork directory (there is none to make).
    expect(fs.existsSync(path.join(dataDir, 'templates', 'bachelorette'))).toBe(false);
    // Nothing was fetched for it either — no wasted round trip.
    expect(fake.calls.some((u) => u.includes('template=bachelorette'))).toBe(false);
    // The unrelated local template is still untouched.
    expect(owner['local-only'].display_he).toBe('מקומי');
  });

  it('imports an all-renames manifest that carries no files at all', async () => {
    // The owner only renamed shipped designs on staging. There is nothing to
    // download, but it is a real change — not the "empty store" misconfiguration
    // the emptiness guard is there to catch.
    const fake = fakeStaging(
      {},
      {
        themes: {
          bachelorette: { slug: 'bachelorette', display_he: 'פריז' },
          japanese: { slug: 'japanese', display_he: 'טוקיו' },
        },
      }
    );
    const res = await run(fake, { templateRoot: shippedRoot });
    expect(res.ok).toBe(true);
    expect(res.files).toBe(0);
    const owner = templates.loadOwnerThemes();
    expect(owner.bachelorette.display_he).toBe('פריז');
    expect(owner.japanese.display_he).toBe('טוקיו');
  });

  it('still refuses a metadata-only entry when we do NOT ship that design', async () => {
    // Same shape, but the key exists in neither layer here: importing it would
    // list a design that renders nothing.
    const fake = fakeStaging({}, { themes: { 'no-such-design': { display_he: 'רפאים' } } });
    const res = await run(fake, { templateRoot: shippedRoot });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no-such-design/);
    expectUntouched();
  });
});

describe('refusals', () => {
  it('refuses an empty staging store instead of reporting a no-op success', async () => {
    const fake = fakeStaging({}, { themes: {} });
    const res = await run(fake, { templateRoot: shippedRoot });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/no owner templates/);
    expectUntouched();
  });

  it('refuses a theme entry that carries no files and is no design of ours', async () => {
    // A registration pointing at nothing: it would list in the admin UI and fail
    // to render, so it must not import at all. Still refused WITH a shipped root
    // in play — 'ghost' is not in it.
    const fake = fakeStaging(
      { 'imported/clean/board.svg': '<svg/>' },
      {
        themes: { imported: {}, ghost: {} },
      }
    );
    for (const extra of [{}, { templateRoot: shippedRoot }]) {
      const res = await run(fake, extra);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/"ghost" has no files/);
      expectUntouched();
    }
  });

  it('refuses when STAGING_URL is unset', async () => {
    const fake = fakeStaging({ 'imported/clean/board.svg': '<svg/>' });
    const res = await run(fake, { stagingUrl: '' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expectUntouched();
  });

  it('refuses a store larger than the import ceiling', async () => {
    const fake = fakeStaging({ 'imported/clean/board.svg': '<svg/>' });
    fake.manifest.files[0].bytes = templateImport.MAX_TOTAL_BYTES + 1;
    const res = await run(fake);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/import limit/);
    expectUntouched();
  });

  it('reports a manifest endpoint the source does not have', async () => {
    const fake = fakeStaging({}, { manifestStatus: 404 });
    const res = await run(fake);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(res.error).toMatch(/is staging running a build/);
    expectUntouched();
  });
});

describe('abort paths leave the volume as they found it', () => {
  it('aborts on a failed file fetch, writing nothing', async () => {
    const fake = fakeStaging(
      { 'imported/clean/board.svg': '<svg/>', 'imported/clean/1.svg': '<svg>1</svg>' },
      { failFile: 'imported/clean/1.svg' }
    );
    const res = await run(fake);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/file fetch failed/);
    expectUntouched();
  });

  it('aborts on a digest mismatch — a truncated body must not import', async () => {
    const fake = fakeStaging(
      { 'imported/clean/board.svg': '<svg/>' },
      { corruptFile: 'imported/clean/board.svg' }
    );
    const res = await run(fake);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/content mismatch/);
    expectUntouched();
  });

  it('leaves no scratch dir behind after an abort', async () => {
    const fake = fakeStaging(
      { 'imported/clean/board.svg': '<svg/>' },
      { corruptFile: 'imported/clean/board.svg' }
    );
    await run(fake);
    const leftovers = fs
      .readdirSync(path.join(dataDir, 'templates'))
      .filter((n) => n.startsWith('.import-'));
    expect(leftovers).toEqual([]);
  });
});

describe('a successful import', () => {
  it('installs the files, the recipe and the theme entry', async () => {
    const fake = fakeStaging(
      {
        'imported/clean/board.svg': '<svg>board</svg>',
        'imported/fonts/Cafe/Cafe.ttf': 'FONT',
      },
      { recipes: { imported: { detected: true } } }
    );
    const res = await run(fake);
    expect(res.ok).toBe(true);
    expect(res.added).toEqual(['imported']);
    expect(res.updated).toEqual([]);
    expect(res.files).toBe(2);

    const dir = path.join(dataDir, 'templates', 'imported');
    expect(fs.readFileSync(path.join(dir, 'clean', 'board.svg'), 'utf8')).toBe('<svg>board</svg>');
    expect(fs.readFileSync(path.join(dir, 'fonts', 'Cafe', 'Cafe.ttf'), 'utf8')).toBe('FONT');
    expect(
      JSON.parse(fs.readFileSync(path.join(dataDir, 'templates', 'recipes', 'imported.json')))
    ).toEqual({ detected: true });
  });

  it('is ADDITIVE — a template only on this service survives', async () => {
    const fake = fakeStaging({ 'imported/clean/board.svg': '<svg/>' });
    const res = await run(fake);
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'templates', 'local-only', 'clean', 'board.svg'))).toBe(
      true
    );
    expect(Object.keys(templates.loadOwnerThemes()).sort()).toEqual(['imported', 'local-only']);
  });

  it('replaces an existing template wholesale, dropping files staging no longer has', async () => {
    // First import gives 'imported' two files…
    await run(fakeStaging({ 'imported/clean/board.svg': '<svg/>', 'imported/clean/1.svg': 'a' }));
    // …the second only one. The stale file must NOT survive inside the dir: the
    // overlay resolves a whole DIRECTORY, so a leftover renders alongside the new
    // artwork.
    const res = await run(fakeStaging({ 'imported/clean/board.svg': '<svg>new</svg>' }), {
      now: 2000,
    });
    expect(res.ok).toBe(true);
    expect(res.updated).toEqual(['imported']);
    expect(res.added).toEqual([]);
    const dir = path.join(dataDir, 'templates', 'imported', 'clean');
    expect(fs.readdirSync(dir)).toEqual(['board.svg']);
    expect(fs.readFileSync(path.join(dir, 'board.svg'), 'utf8')).toBe('<svg>new</svg>');
  });

  it('backs the theme registry up before rewriting it', async () => {
    const res = await run(fakeStaging({ 'imported/clean/board.svg': '<svg/>' }));
    expect(res.backup).toBeTruthy();
    expect(Object.keys(JSON.parse(fs.readFileSync(res.backup, 'utf8')))).toEqual(['local-only']);
  });

  it('leaves no .replacing- dir behind after replacing a template', async () => {
    await run(fakeStaging({ 'imported/clean/board.svg': '<svg/>' }));
    await run(fakeStaging({ 'imported/clean/board.svg': '<svg>new</svg>' }), { now: 2000 });
    const leftovers = fs
      .readdirSync(path.join(dataDir, 'templates'))
      .filter((n) => n.includes('.replacing-'));
    expect(leftovers).toEqual([]);
  });

  it('carries the admin key on every request, so an admin-gated source works', async () => {
    const fake = fakeStaging({ 'imported/clean/board.svg': '<svg/>' });
    await run(fake);
    expect(fake.calls.length).toBe(2);
    expect(fake.calls.every((u) => u.includes('key=k'))).toBe(true);
  });
});
