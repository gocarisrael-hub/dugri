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
      // The theme's LIVE display_he ('רווקות' in the crafted themes.json above) —
      // NOT the name baked into site/js/designs.js. See the naming block below.
      name: 'רווקות',
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
    expect(firstCustom).toBe(6); // the 6 built-in designs lead the list
    expect(body.designs.slice(0, 6).map((d) => d.id)).toEqual([
      'bachelorette',
      'marriage',
      'birthday',
      'japanese',
      'posttrip',
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

  // ---- ONE display-name rule for both kinds -------------------------------
  //
  // The drift the owner reported: every design had been renamed through the admin
  // (the rename lands in themes.json display_he, on the VOLUME), and the admin
  // screens still showed the name hardcoded in site/js/designs.js — so the same
  // design was "פריז" on the storefront and "מסיבת רווקות" in the admin. The merge
  // used two rules: `d.name` (bundled catalog) for a built-in, `display_he` for a
  // template. Now BOTH resolve through templates.displayNameForDesign.

  it('names a BUILT-IN design from its theme display_he, exactly like a template', async () => {
    const { byId } = await load();
    // bachelorette's theme IS `bachelorette`, renamed to 'רווקות' in the crafted
    // themes.json — the bundled catalog name must not win here.
    expect(byId.bachelorette.name).toBe('רווקות');
    expect(byId.bachelorette.custom).toBe(false);
    // ...and a template still reports its own display_he: one rule, both kinds.
    expect(byId['my-custom'].name).toBe('עיצוב שלי');
  });

  it('agrees with GET /api/design-names on every design that endpoint names', async () => {
    // The invariant that keeps the two screens from drifting again: whatever the
    // storefront calls a design, the admin calls it too. Asserted as id=name pairs
    // so a mismatch names the offending design in the failure output.
    const { byId } = await load();
    const { names } = await (await fetch(base + '/api/design-names')).json();
    expect(Object.keys(names).length).toBeGreaterThan(0);
    for (const [id, name] of Object.entries(names)) {
      expect(byId[id]).toBeTruthy();
      expect(id + '=' + byId[id].name).toBe(id + '=' + name);
    }
  });

  it('falls back to the bundled catalog name when the theme carries no display_he', async () => {
    // `kids` maps to the birthday-boys-basketball theme, which the crafted
    // themes.json does not define — the admin must still show a readable name
    // rather than blanking the row or printing the id.
    const { byId } = await load();
    const { DESIGNS } = await import('../../site/js/designs.js');
    const bundled = DESIGNS.find((d) => d.id === 'kids');
    expect(byId.kids.name).toBe(bundled.name);
    expect('kids' in (await (await fetch(base + '/api/design-names')).json()).names).toBe(false);
  });

  it('picks up a RENAME of a built-in design with no restart', async () => {
    const themesFile = path.join(root, 'generator', 'themes.json');
    const good = fs.readFileSync(themesFile, 'utf8');
    const themes = JSON.parse(good);
    themes.bachelorette.display_he = 'פריז';
    fs.writeFileSync(themesFile, JSON.stringify(themes, null, 1) + '\n', 'utf8');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(themesFile, future, future);
    try {
      const { byId } = await load();
      expect(byId.bachelorette.name).toBe('פריז');
      const { names } = await (await fetch(base + '/api/design-names')).json();
      expect(names.bachelorette).toBe('פריז');
    } finally {
      fs.writeFileSync(themesFile, good, 'utf8');
      const later = new Date(Date.now() + 10000);
      fs.utimesSync(themesFile, later, later);
    }
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
