// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Boots the real Express app to exercise GET /api/admin/designs — the ONE merged
// design catalog both admin design screens read (site/admin-designs.html and
// site/admin-images.html).
//
// The bug this pins: the endpoint used to return only the BUILT-IN catalog, so an
// owner-uploaded template was sellable through /api/custom-designs and yet absent
// from both admin screens — the owner could sell a design whose pictures they
// could not curate. The merged list must carry both kinds, each measured against
// the checklist that actually applies to it.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const ADMIN_KEY = 'designs-admin-key';
const qs = '?key=' + encodeURIComponent(ADMIN_KEY);

const SVG = (label) => `<svg xmlns="http://www.w3.org/2000/svg">${label}</svg>`;

describe('GET /api/admin/designs — merged built-in + template catalog', () => {
  let app, server, base, root;

  // A template's storefront pictures are its FILLED SVGs (the legacy sheet layout:
  // fronts/backs/board).
  function writeTemplate(slug, roles) {
    const dir = path.join(root, 'resources', 'canva', 'templates', slug, 'filled');
    fs.mkdirSync(dir, { recursive: true });
    for (const role of roles)
      fs.writeFileSync(path.join(dir, role + '.svg'), SVG(slug + '-' + role));
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-admin-designs-'));
    fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'generator', 'themes.json'),
      JSON.stringify(
        {
          // A built-in design's theme — must NOT be listed twice.
          bachelorette: { slug: 'bachelorette', display_he: 'רווקות', calibrated: true },
          // A full, in-store, public template: the grapefruit case.
          'my-custom': { slug: 'my-custom', display_he: 'עיצוב שלי', visibility: 'public' },
          // Hidden (access-code only) and taken off the shop floor — both still
          // belong in the ADMIN list; that is where the owner changes those states.
          'hidden-one': { slug: 'hidden-one', display_he: 'מוסתר', visibility: 'private' },
          'off-store': { slug: 'off-store', display_he: 'לא בחנות', in_store: false },
          // Registered but with NO art on disk yet.
          'shell-one': { slug: 'shell-one', display_he: 'ריק' },
        },
        null,
        1
      ),
      'utf8'
    );
    writeTemplate('my-custom', ['fronts', 'backs', 'board']);
    writeTemplate('hidden-one', ['fronts', 'backs', 'board']);
    writeTemplate('off-store', ['fronts', 'backs', 'board']);
    writeTemplate('no-board', ['fronts', 'backs']); // art on disk, registered later

    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-admin-designs-data-'));
    process.env.TEMPLATE_ROOT = root;
    process.env.ADMIN_KEY = ADMIN_KEY;
    for (const f of [
      'db.js',
      'pelecard.js',
      'notify.js',
      'content.js',
      'templates.js',
      'design-catalog.js',
      'index.js',
    ]) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
    app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function load() {
    const r = await fetch(base + '/api/admin/designs' + qs);
    expect(r.status).toBe(200);
    const body = await r.json();
    return { body, byId: Object.fromEntries(body.designs.map((d) => [d.id, d])) };
  }

  it('stays behind the admin key', async () => {
    expect((await fetch(base + '/api/admin/designs')).status).toBe(403);
    expect((await fetch(base + '/api/admin/designs?key=nope')).status).toBe(403);
  });

  // ---- the built-ins are untouched ----------------------------------------

  it('reports the built-in designs exactly as before (names, assets, kids board gap)', async () => {
    const { byId } = await load();
    expect(byId.bachelorette).toMatchObject({
      name: 'מסיבת רווקות',
      theme: 'bachelorette',
      custom: false,
      public: true,
      inStore: true,
      complete: true,
      thumb: 'assets/designs/bachelorette/thumb.webp',
    });
    expect(byId.bachelorette.missing).toEqual([]);
    expect(byId.bachelorette.source).toMatchObject({
      kind: 'builtin',
      dir: 'site/assets/designs/bachelorette',
    });

    // kids ships no board — still reported missing on purpose, grouped under "לוח".
    const kids = byId.kids;
    expect(kids.complete).toBe(false);
    expect(kids.missing).toEqual(
      expect.arrayContaining(['board.svg', 'thumb-board.webp', 'gallery-board.webp'])
    );
    expect(kids.missingGroups.map((g) => g.group)).toEqual(['board']);
    expect(kids.present).toContain('front.svg');
  });

  it('lists the built-ins FIRST, in catalog order, before any template', async () => {
    const { body } = await load();
    const firstCustom = body.designs.findIndex((d) => d.custom);
    expect(firstCustom).toBe(7); // the 7 built-in designs lead the list
    expect(body.designs.slice(0, 7).map((d) => d.id)).toEqual([
      'bachelorette',
      'marriage',
      'birthday',
      'japanese',
      'posttrip',
      'neon',
      'kids',
    ]);
    // `expected` keeps naming the BUILT-IN file list it always did.
    expect(body.expected.map((e) => e.file)).toContain('gallery-front.webp');
  });

  it("resolves each built-in's shipped gallery renders, and only the slots it ships", async () => {
    const { byId } = await load();
    expect(byId.posttrip.slots).toMatchObject({
      store: 'assets/designs/posttrip/store.webp',
      front: 'assets/designs/posttrip/gallery-front.webp',
      back: 'assets/designs/posttrip/gallery-back.webp',
    });
    expect(byId.posttrip.slots.board).toBe('assets/designs/posttrip/gallery-board.webp');
    // A boardless design ships no board render; the slot stays open for an upload.
    expect(byId.kids.slots.board).toBe(null);
    // No design ships a photo card yet.
    expect(byId.kids.slots.photo).toBe(null);
  });

  // ---- templates are designs too ------------------------------------------

  it('lists an owner template as a design, with its template picture slots', async () => {
    const { byId } = await load();
    expect(byId['my-custom']).toMatchObject({
      id: 'my-custom',
      name: 'עיצוב שלי',
      theme: 'my-custom', // a template IS its own theme
      custom: true,
      public: true,
      inStore: true,
      complete: true,
    });
    expect(byId['my-custom'].slots).toMatchObject({
      store: null, // a template ships no store cover — uploadable, not shipped
      photo: null,
      front: '/api/template-image/my-custom/front',
      back: '/api/template-image/my-custom/back',
      board: '/api/template-image/my-custom/board',
    });
    expect(byId['my-custom'].thumb).toBe('/api/template-image/my-custom/front');
  });

  it('measures a template against ITS OWN files, not the built-in layout', async () => {
    const { byId } = await load();
    const d = byId['my-custom'];
    // The checklist names the template's real files, and says where it looked —
    // a template is never reported as missing site/assets/designs/* it never had.
    expect(d.assets.map((a) => a.file)).toEqual([
      'filled/fronts.svg',
      'filled/backs.svg',
      'filled/board.svg',
    ]);
    expect(d.assets.every((a) => a.exists)).toBe(true);
    expect(d.source).toMatchObject({
      kind: 'template',
      dir: 'resources/canva/templates/my-custom',
    });
    expect(d.missing).toEqual([]);
    // Same group ids/labels as a built-in design, so one UI renders both.
    expect(d.assets.map((a) => a.group)).toEqual(['front', 'back', 'board']);
  });

  it('flags a template that is missing a picture, grouped by part', async () => {
    const { byId } = await load();
    const shell = byId['shell-one'];
    expect(shell.complete).toBe(false);
    expect(shell.missing).toEqual(['filled/fronts.svg', 'filled/backs.svg', 'filled/board.svg']);
    expect(shell.missingGroups.map((g) => g.group)).toEqual(['front', 'back', 'board']);
    // Nothing to preview → no thumb, so the UI shows its placeholder.
    expect(shell.thumb).toBe(null);
    expect(shell.slots.front).toBe(null);
  });

  it('lists hidden and off-the-shop-floor templates too, and says which is which', async () => {
    const { byId } = await load();
    // The admin is where those states are FIXED, so hiding them here is the bug.
    expect(byId['hidden-one']).toMatchObject({ public: false, visibility: 'private' });
    expect(byId['off-store']).toMatchObject({ inStore: false, public: true });
    expect(byId['my-custom'].inStore).toBe(true);
  });

  it('never lists a built-in design twice via its theme', async () => {
    const { body } = await load();
    const ids = body.designs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    // `bachelorette` is a built-in design AND a themes.json key — one entry only,
    // and it is the built-in one.
    expect(ids.filter((i) => i === 'bachelorette')).toHaveLength(1);
    expect(body.designs.find((d) => d.id === 'bachelorette').custom).toBe(false);
  });

  it('picks up a newly registered template with no restart', async () => {
    const themesFile = path.join(root, 'generator', 'themes.json');
    const themes = JSON.parse(fs.readFileSync(themesFile, 'utf8'));
    themes['no-board'] = { slug: 'no-board', display_he: 'בלי לוח' };
    fs.writeFileSync(themesFile, JSON.stringify(themes, null, 1) + '\n', 'utf8');

    const { byId } = await load();
    const d = byId['no-board'];
    expect(d).toBeTruthy();
    // Front + back on disk, no board: reported as the board gap, exactly like a
    // boardless built-in design.
    expect(d.complete).toBe(false);
    expect(d.missing).toEqual(['filled/board.svg']);
    expect(d.slots.board).toBe(null);
    expect(d.slots.front).toBe('/api/template-image/no-board/front');
  });

  it('lists an OWNER-uploaded template, whose art lives under DATA_DIR', async () => {
    // The real upload path never touches the image: server/template-store.js
    // persists both the theme entry and the assets under DATA_DIR/templates, and
    // the merged catalog must read through that overlay exactly as the storefront
    // picture route does — otherwise every uploaded template stays invisible.
    const storeRoot = path.join(process.env.DATA_DIR, 'templates');
    fs.mkdirSync(path.join(storeRoot, 'owner-tpl', 'filled'), { recursive: true });
    for (const role of ['fronts', 'backs', 'board']) {
      fs.writeFileSync(
        path.join(storeRoot, 'owner-tpl', 'filled', role + '.svg'),
        SVG('owner-' + role)
      );
    }
    fs.writeFileSync(
      path.join(storeRoot, 'themes.json'),
      JSON.stringify(
        { 'owner-tpl': { slug: 'owner-tpl', display_he: 'תבנית של הבעלים' } },
        null,
        1
      ),
      'utf8'
    );

    const { byId } = await load();
    expect(byId['owner-tpl']).toMatchObject({
      custom: true,
      name: 'תבנית של הבעלים',
      complete: true,
    });
    expect(byId['owner-tpl'].slots.front).toBe('/api/template-image/owner-tpl/front');

    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  it('degrades to the built-ins when themes.json is unreadable', async () => {
    const themesFile = path.join(root, 'generator', 'themes.json');
    const good = fs.readFileSync(themesFile, 'utf8');
    fs.writeFileSync(themesFile, '{ not json', 'utf8');
    try {
      const { body } = await load();
      expect(body.designs.every((d) => !d.custom)).toBe(true);
      expect(body.designs.map((d) => d.id)).toContain('bachelorette');
    } finally {
      fs.writeFileSync(themesFile, good, 'utf8');
    }
  });
});
