// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { backupTemplates } from '../../scripts/backup-templates.mjs';

// The owner's templates live on the Railway VOLUME, not in this repo, and that
// volume has no history and no snapshots. The only templates git currently backs
// up are the shipped ones nobody edits. So these pin the property that matters
// for a backup tool: it either produces a COMPLETE, verified snapshot, or it
// leaves the previous one exactly as it found it. A backup that silently stores
// truncated artwork is worse than one that loudly refuses.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverIndexPath = path.join(__dirname, '..', '..', 'server', 'index.js');
const ADMIN_KEY = 'backup-test-admin-key';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

let server;
let baseUrl;
let dataDir;
let outRoot;

// Seed the owner store the way the admin upload leaves it: DATA_DIR/templates/
// <key>/… plus themes.json and recipes/<key>.json.
function seedOwnerTemplate(key, files, entry, recipe) {
  const root = path.join(dataDir, 'templates');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, key, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const themesPath = path.join(root, 'themes.json');
  const themes = fs.existsSync(themesPath) ? JSON.parse(fs.readFileSync(themesPath, 'utf8')) : {};
  themes[key] = entry;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(themesPath, JSON.stringify(themes));
  if (recipe) {
    fs.mkdirSync(path.join(root, 'recipes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'recipes', key + '.json'), JSON.stringify(recipe));
  }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-backup-data-'));
  outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-backup-out-'));
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;

  seedOwnerTemplate(
    'tarifa-test',
    {
      'clean/2.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      'clean/board.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>',
      'fonts/Fake.ttf': Buffer.from([0x00, 0x01, 0x00, 0x00, 0x7f]),
    },
    { slug: 'tarifa-test', title_lines: ['{NAME}'], recipe: 'tarifa-test' },
    { cards: [], back: null }
  );

  const app = (await import(pathToFileURL(serverIndexPath).href)).default;
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

afterAll(() => {
  if (server) server.close();
  for (const d of [dataDir, outRoot]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('backupTemplates against a real running instance', () => {
  it('pulls every owner file, its themes.json and its recipes', async () => {
    const out = path.join(outRoot, 'snap1');
    const res = await backupTemplates({ baseUrl, adminKey: ADMIN_KEY, outDir: out });

    expect(res.templates).toBe(1);
    expect(res.files).toBe(3);
    expect(res.recipes).toBe(1);

    // The artwork itself, byte for byte — a manifest that lists a file the
    // snapshot does not contain is the failure this exists to prevent.
    const svg = fs.readFileSync(
      path.join(out, 'templates', 'tarifa-test', 'clean', '2.svg'),
      'utf8'
    );
    expect(svg).toContain('<svg');
    expect(fs.existsSync(path.join(out, 'templates', 'tarifa-test', 'fonts', 'Fake.ttf'))).toBe(
      true
    );

    const themes = JSON.parse(fs.readFileSync(path.join(out, 'themes.json'), 'utf8'));
    expect(themes['tarifa-test']).toBeTruthy();
    // Without the recipe the artwork restores but the words have nowhere to go.
    expect(fs.existsSync(path.join(out, 'recipes', 'tarifa-test.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(true);
  });

  it('replaces a previous snapshot in place, leaving no scratch behind', async () => {
    const out = path.join(outRoot, 'snap2');
    await backupTemplates({ baseUrl, adminKey: ADMIN_KEY, outDir: out });
    fs.writeFileSync(path.join(out, 'STALE.txt'), 'from the older snapshot');

    await backupTemplates({ baseUrl, adminKey: ADMIN_KEY, outDir: out });

    // A snapshot is the store as it is NOW, not merged with what was there.
    expect(fs.existsSync(path.join(out, 'STALE.txt'))).toBe(false);
    expect(fs.existsSync(out + '.incoming')).toBe(false);
    expect(fs.existsSync(out + '.previous')).toBe(false);
  });

  it('never puts the admin key in an error message', async () => {
    await expect(
      backupTemplates({ baseUrl, adminKey: 'wrong-key-abc123', outDir: path.join(outRoot, 'x') })
    ).rejects.toThrow(/HTTP 403/);
    await backupTemplates({
      baseUrl,
      adminKey: 'wrong-key-abc123',
      outDir: path.join(outRoot, 'x'),
    }).catch((e) => {
      expect(String(e.message)).not.toContain('wrong-key-abc123');
    });
  });
});

// The failure paths use a stubbed fetch: a real server cannot be made to serve a
// corrupt body or a hostile manifest, and those are exactly the cases where a
// backup tool must refuse rather than write.
describe('backupTemplates refuses bad input instead of writing it', () => {
  const stub = (manifest, bodies) => async (url) => {
    if (url.includes('/export?')) {
      return { ok: true, json: async () => manifest };
    }
    const rel = decodeURIComponent(new URL(url).searchParams.get('path'));
    const body = bodies[rel];
    if (body == null) return { ok: false, status: 404 };
    return { ok: true, arrayBuffer: async () => Buffer.from(body) };
  };

  it('aborts on a checksum mismatch and keeps the old snapshot', async () => {
    const out = path.join(outRoot, 'snap3');
    await backupTemplates({ baseUrl, adminKey: ADMIN_KEY, outDir: out });
    const before = fs.readdirSync(path.join(out, 'templates', 'tarifa-test', 'clean')).sort();

    const manifest = {
      themes: { t: {} },
      recipes: {},
      files: [{ key: 't', rel: 'a.svg', bytes: 5, sha256: sha256(Buffer.from('good!')) }],
    };
    await expect(
      backupTemplates({
        baseUrl,
        adminKey: ADMIN_KEY,
        outDir: out,
        fetchImpl: stub(manifest, { 'a.svg': 'BAD!!' }),
      })
    ).rejects.toThrow(/checksum mismatch/);

    // The good snapshot is still the one on disk.
    expect(fs.readdirSync(path.join(out, 'templates', 'tarifa-test', 'clean')).sort()).toEqual(
      before
    );
  });

  it('refuses an EMPTY store by default — that is what a reset volume looks like', async () => {
    const out = path.join(outRoot, 'snap4');
    await backupTemplates({ baseUrl, adminKey: ADMIN_KEY, outDir: out });
    const empty = { themes: {}, recipes: {}, files: [] };

    await expect(
      backupTemplates({ baseUrl, adminKey: ADMIN_KEY, outDir: out, fetchImpl: stub(empty, {}) })
    ).rejects.toThrow(/EMPTY template store/);
    expect(fs.existsSync(path.join(out, 'themes.json'))).toBe(true);

    // Explicit opt-in for a store that really is empty.
    const res = await backupTemplates({
      baseUrl,
      adminKey: ADMIN_KEY,
      outDir: out,
      allowEmpty: true,
      fetchImpl: stub(empty, {}),
    });
    expect(res.files).toBe(0);
  });

  it('rejects a manifest path that escapes the snapshot', async () => {
    const manifest = {
      themes: { t: {} },
      recipes: {},
      files: [{ key: 't', rel: '../../../etc/passwd', bytes: 1 }],
    };
    await expect(
      backupTemplates({
        baseUrl,
        adminKey: ADMIN_KEY,
        outDir: path.join(outRoot, 'snap5'),
        fetchImpl: stub(manifest, {}),
      })
    ).rejects.toThrow(/unsafe path|escapes the snapshot/);
  });
});
