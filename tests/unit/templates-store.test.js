// @vitest-environment node
//
// The PERSISTENT owner template store (server/template-store.js) and the overlay
// server/templates.js reads through.
//
// The bug this covers: template writes used to land in the repo checkout, which
// in production is the Docker image — an EPHEMERAL filesystem. Every uploaded
// template and every saved calibration vanished on the next deploy. Only DATA_DIR
// (a mounted volume) survives, but pointing everything at DATA_DIR would hide the
// 8 templates that ship inside the image. Hence the overlay:
//
//   themes  = { ...shipped, ...owner }   owner wins, WHOLE ENTRY
//   assets  = DATA_DIR/templates/<slug>/ when it exists, else the image's copy
//   recipe  = DATA_DIR/templates/recipes/<slug>.json when it exists, else image
//   writes  = ALWAYS the owner store; the image is never modified
//
// Everything here runs against a THROWAWAY scaffold ("the image") plus a
// throwaway DATA_DIR ("the volume"), so no real config is touched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const ADMIN_KEY = 'test-admin-key';
const SVG = (label) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${label}</svg>`);
const FONT = (label = '') =>
  Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from(label)]);

// A full, valid calibration blob (shaped like the shipped themes').
const CAL = {
  title_style: {
    fill: '#97d8e6',
    outline: '#0d3e43',
    outline_w: 0.05,
    arch: 0.11,
    shadow: true,
    size: 23.9,
  },
  board: {
    frac: { x0: 0.02, y0: 0.883, x1: 0.135, y1: 0.985 },
    fill: '#97d8e6',
    outline: '#0d3e43',
  },
  back: null,
  word_size: 12,
};

// "The image": a throwaway repo scaffold carrying two SHIPPED templates —
// 'ship-a' with real asset files on disk, plus a bare 'seed-theme'.
function makeImage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-store-image-'));
  fs.mkdirSync(path.join(root, 'generator', 'recipes'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generator', 'themes.json'),
    JSON.stringify(
      {
        'seed-theme': { slug: 'seed-theme', display_he: 'זרע', calibrated: true },
        'ship-a': {
          slug: 'ship-a',
          display_he: 'תבנית מובנית',
          dir: 'resources/canva/templates/ship-a',
          recipe: 'ship-a',
          visibility: 'public',
          title_font: 'Title.ttf',
          word_font: 'Word.ttf',
          title_style: null,
          board: null,
          back: null,
          calibrated: false,
        },
      },
      null,
      1
    ) + '\n',
    'utf8'
  );
  const dir = path.join(root, 'resources', 'canva', 'templates', 'ship-a');
  for (const sub of ['clean', 'filled', 'fonts'])
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const role of ['fronts', 'backs', 'board']) {
    fs.writeFileSync(path.join(dir, 'clean', role + '.svg'), SVG('shipped-clean-' + role));
    fs.writeFileSync(path.join(dir, 'filled', role + '.svg'), SVG('shipped-filled-' + role));
  }
  fs.writeFileSync(path.join(dir, 'fonts', 'Title.ttf'), FONT('SHIPPED-TITLE'));
  fs.writeFileSync(path.join(dir, 'fonts', 'Word.ttf'), FONT('SHIPPED-WORD'));
  fs.writeFileSync(path.join(root, 'generator', 'recipes', 'ship-a.json'), '{"shipped":true}');
  return root;
}

function validFiles() {
  return {
    clean_fronts: { filename: 'cf.svg', data: SVG('clean-fronts') },
    clean_backs: { filename: 'cb.svg', data: SVG('clean-backs') },
    clean_board: { filename: 'cbo.svg', data: SVG('clean-board') },
    filled_fronts: { filename: 'ff.svg', data: SVG('filled-fronts') },
    filled_backs: { filename: 'fb.svg', data: SVG('filled-backs') },
    filled_board: { filename: 'fbo.svg', data: SVG('filled-board') },
    title_font: { filename: 'Title.ttf', data: FONT('T') },
    word_font: { filename: 'Word.ttf', data: FONT('W') },
  };
}

// The image's themes.json, read raw (no overlay) — used to prove it stays pristine.
const readShipped = (root) =>
  JSON.parse(fs.readFileSync(path.join(root, 'generator', 'themes.json'), 'utf8'));

describe('template-store: path layout + safety', () => {
  let store;
  let data;
  beforeAll(() => {
    delete require.cache[require.resolve(path.join(serverDir, 'template-store.js'))];
    store = require(path.join(serverDir, 'template-store.js'));
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-store-data-'));
  });

  it('is DISABLED (every accessor null) when DATA_DIR is unset', () => {
    delete process.env.DATA_DIR;
    expect(store.enabled()).toBe(false);
    expect(store.storeRoot()).toBeNull();
    expect(store.ownerThemesPath()).toBeNull();
    expect(store.ownerRecipesDir()).toBeNull();
    expect(store.ownerRecipePath('x')).toBeNull();
    expect(store.ownerTemplateDir('x')).toBeNull();
  });

  it('lays the store out under DATA_DIR/templates once DATA_DIR is set', () => {
    process.env.DATA_DIR = data;
    const root = path.join(data, 'templates');
    expect(store.storeRoot()).toBe(root);
    expect(store.ownerThemesPath()).toBe(path.join(root, 'themes.json'));
    expect(store.ownerRecipePath('demo')).toBe(path.join(root, 'recipes', 'demo.json'));
    expect(store.ownerTemplateDir('demo')).toBe(path.join(root, 'demo'));
  });

  it('a key can never escape the store root, and the layout names are reserved', () => {
    process.env.DATA_DIR = data;
    for (const bad of ['..', '../..', '../evil', 'a/b', '/etc', '.', '']) {
      expect(store.ownerTemplateDir(bad)).toBeNull();
    }
    // 'recipes' + 'themes.json' are the store's own layout — never a template dir.
    expect(store.ownerTemplateDir('recipes')).toBeNull();
    expect(store.ownerTemplateDir('themes.json')).toBeNull();
    expect(store.ownerRecipePath('../evil')).toBeNull();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });
});

describe('templates.js overlay with the owner store ACTIVE', () => {
  let templates;
  let root;
  let data;
  const storeDir = () => path.join(data, 'templates');
  const ownerThemes = () =>
    JSON.parse(fs.readFileSync(path.join(storeDir(), 'themes.json'), 'utf8'));

  beforeAll(() => {
    root = makeImage();
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-store-vol-'));
    process.env.DATA_DIR = data;
    for (const f of ['template-store.js', 'templates.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    templates = require(path.join(serverDir, 'templates.js'));
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('an uploaded template lands in the OWNER STORE and never in the image tree', () => {
    const r = templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: {
        slug: 'owned-x',
        display_he: 'תבנית של הבעלים',
        title_text: '{NAME}',
        name_form: 'hebrew',
      },
      files: validFiles(),
    });
    expect(r.error).toBeUndefined();

    const owned = path.join(storeDir(), 'owned-x');
    expect(fs.existsSync(path.join(owned, 'clean', 'fronts.svg'))).toBe(true);
    expect(fs.existsSync(path.join(owned, 'filled', 'board.svg'))).toBe(true);
    expect(fs.existsSync(path.join(owned, 'fonts', 'Title.ttf'))).toBe(true);
    // The image tree gained NOTHING — neither the dir nor a themes entry.
    expect(fs.existsSync(path.join(root, 'resources', 'canva', 'templates', 'owned-x'))).toBe(
      false
    );
    expect(readShipped(root)['owned-x']).toBeUndefined();
    expect(ownerThemes()['owned-x'].display_he).toBe('תבנית של הבעלים');
  });

  it('the merged view contains shipped + owner entries', () => {
    const merged = templates.loadThemes(templates.themesPathFor(root));
    expect(Object.keys(merged).sort()).toEqual(['owned-x', 'seed-theme', 'ship-a']);
    expect(templates.isOwnerTheme('owned-x')).toBe(true);
    expect(templates.isShippedTheme(root, 'owned-x')).toBe(false);
    expect(templates.isOwnerTheme('ship-a')).toBe(false);
    expect(templates.isShippedTheme(root, 'ship-a')).toBe(true);
  });

  it('an owner entry OVERRIDES a same-slug shipped one, as a whole entry', () => {
    // Hand-write an owner override that drops a field the shipped entry carries —
    // proving it is a whole-entry replacement, not a deep merge.
    fs.mkdirSync(storeDir(), { recursive: true });
    const owner = ownerThemes();
    owner['ship-a'] = { slug: 'ship-a', display_he: 'דרוס', calibrated: true };
    fs.writeFileSync(path.join(storeDir(), 'themes.json'), JSON.stringify(owner, null, 1) + '\n');

    const merged = templates.loadThemes(templates.themesPathFor(root));
    expect(merged['ship-a'].display_he).toBe('דרוס');
    expect(merged['ship-a'].calibrated).toBe(true);
    expect('title_font' in merged['ship-a']).toBe(false); // whole-entry, not merged
    // The image's copy is untouched.
    expect(readShipped(root)['ship-a'].display_he).toBe('תבנית מובנית');
    expect(readShipped(root)['ship-a'].title_font).toBe('Title.ttf');

    // Undo, so the rest of the suite starts from the pristine shipped entry.
    delete owner['ship-a'];
    fs.writeFileSync(path.join(storeDir(), 'themes.json'), JSON.stringify(owner, null, 1) + '\n');
  });

  it('a CALIBRATION save on a SHIPPED template is copy-on-write', () => {
    const before = readShipped(root)['ship-a'];
    expect(before.calibrated).toBe(false);
    expect(before.title_style).toBeNull();

    const r = templates.updateTemplateSettings({
      root,
      key: 'ship-a',
      patch: { ...CAL, calibrated: true },
    });
    expect(r.error).toBeUndefined();
    expect(r.settings.calibrated).toBe(true);

    // The override carries the FULL entry (identity fields included), so the
    // generator still finds the fonts/recipe.
    const saved = ownerThemes()['ship-a'];
    expect(saved.calibrated).toBe(true);
    expect(saved.title_style).toEqual(CAL.title_style);
    expect(saved.title_font).toBe('Title.ttf');
    expect(saved.recipe).toBe('ship-a');

    // The IMAGE's themes.json is byte-for-byte the shipped one still.
    expect(readShipped(root)['ship-a'].calibrated).toBe(false);
    expect(readShipped(root)['ship-a'].title_style).toBeNull();

    // Readers see the override.
    expect(templates.loadThemes(templates.themesPathFor(root))['ship-a'].calibrated).toBe(true);
  });

  // The point of routing the seed-pool link through template settings: it lands
  // on the VOLUME, so re-pointing a design at another pool survives a deploy. The
  // link used to live only in the image's themes.json, where an edit is wiped by
  // the next deploy — which is why the wordlists screen showed it read-only.
  it('a SEED-POOL change on a shipped template persists to the volume', () => {
    expect(readShipped(root)['ship-a'].wordlist).toBeUndefined();

    const r = templates.updateTemplateSettings({
      root,
      key: 'ship-a',
      patch: { wordlist: 'bachelorette-350.txt' },
    });
    expect(r.error).toBeUndefined();

    // On the volume, as a whole entry — exactly the merged entry the Python
    // generator reads (config.py applies the same overlay), so topup draws its
    // filler words from the new pool on the next order.
    const saved = ownerThemes()['ship-a'];
    expect(saved.wordlist).toBe('bachelorette-350.txt');
    expect(saved.slug).toBe('ship-a'); // identity intact — assets still resolve

    // The image is untouched, so the shipped default stays recoverable.
    expect(readShipped(root)['ship-a'].wordlist).toBeUndefined();
    expect(templates.loadThemes(templates.themesPathFor(root))['ship-a'].wordlist).toBe(
      'bachelorette-350.txt'
    );
  });

  it('loadThemesCached reflects an owner-store write immediately', () => {
    const themesPath = templates.themesPathFor(root);
    expect(templates.loadThemesCached(themesPath)['ship-a'].display_he).toBe('תבנית מובנית');
    templates.renameTemplate({ root, key: 'ship-a', displayName: 'שם חדש' });
    expect(templates.loadThemesCached(themesPath)['ship-a'].display_he).toBe('שם חדש');
    // and the image is still untouched
    expect(readShipped(root)['ship-a'].display_he).toBe('תבנית מובנית');
  });

  it('replacing ONE asset on a shipped template copies the WHOLE dir into the store', () => {
    const owned = path.join(storeDir(), 'ship-a');
    expect(fs.existsSync(owned)).toBe(false);

    const r = templates.replaceAsset({
      root,
      key: 'ship-a',
      role: 'clean-fronts',
      file: { filename: 'n.svg', data: SVG('OWNER-ART') },
      force: true, // it was flipped calibrated:true above
    });
    expect(r.error).toBeUndefined();

    // The replaced file landed in the store...
    expect(fs.readFileSync(path.join(owned, 'clean', 'fronts.svg'), 'utf8')).toContain('OWNER-ART');
    // ...and so did EVERY other asset. Without the copy the overlay (which picks a
    // DIR, not a file) would make the untouched assets vanish.
    for (const role of ['backs', 'board']) {
      expect(fs.readFileSync(path.join(owned, 'clean', role + '.svg'), 'utf8')).toContain(
        'shipped-clean-' + role
      );
      expect(fs.readFileSync(path.join(owned, 'filled', role + '.svg'), 'utf8')).toContain(
        'shipped-filled-' + role
      );
    }
    expect(fs.existsSync(path.join(owned, 'fonts', 'Title.ttf'))).toBe(true);

    // The image's art is pristine.
    const shippedDir = path.join(root, 'resources', 'canva', 'templates', 'ship-a');
    expect(fs.readFileSync(path.join(shippedDir, 'clean', 'fronts.svg'), 'utf8')).toContain(
      'shipped-clean-fronts'
    );

    // Resolution now points at the store, and the status view says so.
    expect(templates.resolveTemplateDirBySlug(root, 'ship-a')).toBe(owned);
    const st = templates.listTemplateStatuses(root).find((t) => t.key === 'ship-a');
    expect(st.owner).toBe(true);
    expect(st.shipped).toBe(true);
    expect(st.complete).toBe(true);
  });

  it('a REJECTED asset upload does not create an override', () => {
    // 'seed-theme' has no assets at all; a junk font is refused before any write.
    const bad = templates.replaceAsset({
      root,
      key: 'seed-theme',
      role: 'title-font',
      file: { filename: 'x.ttf', data: Buffer.from('not a font') },
    });
    expect(bad.error).toMatch(/does not look like a font/);
    expect(fs.existsSync(path.join(storeDir(), 'seed-theme'))).toBe(false);
  });

  it('the recipe resolves owner-first and falls back to the image', () => {
    expect(templates.resolveRecipePath(root, 'ship-a')).toBe(
      path.join(root, 'generator', 'recipes', 'ship-a.json')
    );
    const ownerRecipe = path.join(storeDir(), 'recipes', 'ship-a.json');
    fs.mkdirSync(path.dirname(ownerRecipe), { recursive: true });
    fs.writeFileSync(ownerRecipe, '{"owner":true}');
    expect(templates.resolveRecipePath(root, 'ship-a')).toBe(ownerRecipe);
    expect(templates.resolveRecipePath(root, 'nothing-here')).toBeNull();
  });

  it('DELETING a shipped template is REFUSED (in Hebrew) — it would return on redeploy', () => {
    const r = templates.deleteTemplate({ root, key: 'ship-a', inUseThemes: [] });
    expect(r.httpStatus).toBe(409);
    expect(r.shipped).toBe(true);
    expect(r.error).toMatch(/תבנית מובנית/);
    // Nothing was removed from either layer.
    expect(readShipped(root)['ship-a']).toBeDefined();
    expect(fs.existsSync(path.join(storeDir(), 'ship-a'))).toBe(true);
  });

  it('revertTemplate drops the override so the pristine shipped template returns', () => {
    const r = templates.revertTemplate({ root, key: 'ship-a' });
    expect(r.error).toBeUndefined();
    expect(r.reverted).toBe(true);

    expect(ownerThemes()['ship-a']).toBeUndefined();
    expect(fs.existsSync(path.join(storeDir(), 'ship-a'))).toBe(false);
    expect(fs.existsSync(path.join(storeDir(), 'recipes', 'ship-a.json'))).toBe(false);

    const merged = templates.loadThemes(templates.themesPathFor(root));
    expect(merged['ship-a'].display_he).toBe('תבנית מובנית'); // shipped label is back
    expect(merged['ship-a'].calibrated).toBe(false);
    expect(templates.resolveTemplateDirBySlug(root, 'ship-a')).toBe(
      path.join(root, 'resources', 'canva', 'templates', 'ship-a')
    );
    expect(templates.resolveRecipePath(root, 'ship-a')).toBe(
      path.join(root, 'generator', 'recipes', 'ship-a.json')
    );

    // A second revert has nothing to do; a non-shipped key is not revertible.
    expect(templates.revertTemplate({ root, key: 'ship-a' }).httpStatus).toBe(409);
    expect(templates.revertTemplate({ root, key: 'owned-x' }).httpStatus).toBe(409);
    for (const k of ['__proto__', 'constructor']) {
      expect(templates.revertTemplate({ root, key: k }).httpStatus).toBe(404);
    }
  });

  it('an OWNER-ONLY template deletes normally, from the store only', () => {
    const r = templates.deleteTemplate({ root, key: 'owned-x', inUseThemes: [] });
    expect(r.ok).toBe(true);
    expect(ownerThemes()['owned-x']).toBeUndefined();
    expect(fs.existsSync(path.join(storeDir(), 'owned-x'))).toBe(false);
    // The shipped layer never had it and is unchanged.
    expect(Object.keys(readShipped(root)).sort()).toEqual(['seed-theme', 'ship-a']);
  });

  it('a slug colliding with the store layout is refused', () => {
    const r = templates.createTemplateShell({
      root,
      fields: { slug: 'recipes', display_he: 'x', title_text: '{NAME}', name_form: 'english' },
    });
    expect(r.error).toMatch(/reserved/);
  });

  it('an existing OWNER dir blocks re-registering the same slug', () => {
    templates.createTemplateShell({
      root,
      fields: { slug: 'dup-guard', display_he: 'x', title_text: '{NAME}', name_form: 'english' },
    });
    // Drop only the themes entry, leaving the assets — a re-upload must NOT silently
    // overwrite them.
    const owner = ownerThemes();
    delete owner['dup-guard'];
    fs.writeFileSync(path.join(storeDir(), 'themes.json'), JSON.stringify(owner, null, 1) + '\n');
    const r = templates.createTemplateShell({
      root,
      fields: { slug: 'dup-guard', display_he: 'x', title_text: '{NAME}', name_form: 'english' },
    });
    expect(r.error).toMatch(/directory with this slug already exists/);
  });
});

describe('templates.js with DATA_DIR UNSET — image paths only, exactly as before', () => {
  let templates;
  let root;
  beforeAll(() => {
    delete process.env.DATA_DIR;
    root = makeImage();
    for (const f of ['template-store.js', 'templates.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    templates = require(path.join(serverDir, 'templates.js'));
  });

  it('onboards straight into the image tree and its themes.json', () => {
    const r = templates.onboardTemplate({
      root,
      runRecipe: false,
      fields: { slug: 'local-x', display_he: 'מקומי', title_text: '{NAME}', name_form: 'hebrew' },
      files: validFiles(),
    });
    expect(r.error).toBeUndefined();
    const dir = path.join(root, 'resources', 'canva', 'templates', 'local-x');
    expect(fs.existsSync(path.join(dir, 'clean', 'fronts.svg'))).toBe(true);
    expect(readShipped(root)['local-x'].display_he).toBe('מקומי');
    expect(templates.isOwnerTheme('local-x')).toBe(false);
  });

  it('edits/renames/deletes the image entry in place, with no store anywhere', () => {
    templates.renameTemplate({ root, key: 'ship-a', displayName: 'ערוך מקומית' });
    expect(readShipped(root)['ship-a'].display_he).toBe('ערוך מקומית');

    templates.updateTemplateSettings({ root, key: 'ship-a', patch: { ...CAL, calibrated: true } });
    expect(readShipped(root)['ship-a'].calibrated).toBe(true);

    // Deleting a "shipped" template is allowed here — there is no store, so this
    // IS the only copy (the historical behaviour local dev relies on).
    const del = templates.deleteTemplate({ root, key: 'ship-a', inUseThemes: [] });
    expect(del.ok).toBe(true);
    expect(readShipped(root)['ship-a']).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'resources', 'canva', 'templates', 'ship-a'))).toBe(false);

    // revert is a no-op concept without a store.
    expect(templates.revertTemplate({ root, key: 'seed-theme' }).httpStatus).toBe(409);
  });

  it('resolves dirs + recipes from the image only', () => {
    expect(templates.resolveTemplateDirBySlug(root, 'local-x')).toBe(
      path.join(root, 'resources', 'canva', 'templates', 'local-x')
    );
    expect(templates.loadOwnerThemes()).toEqual({});
  });
});

// server/validate.js reads themes.json directly (it is pinned to the REAL
// generator/themes.json, not TEMPLATE_ROOT). It must see the merged view too —
// otherwise a production order for an owner-uploaded theme fails validation with
// a bogus "unknown theme".
describe('validate.js sees the owner store', () => {
  let validate;
  let data;
  beforeAll(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-store-validate-'));
    fs.mkdirSync(path.join(data, 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(data, 'templates', 'themes.json'),
      JSON.stringify({
        'owner-only': { slug: 'owner-only', name_form: 'english', extra_fields: ['AGE'] },
        // also override a real shipped theme, to prove owner wins
        bachelorette: { slug: 'bachelorette', name_form: 'english', extra_fields: [] },
      }),
      'utf8'
    );
    delete require.cache[require.resolve(path.join(serverDir, 'template-store.js'))];
    delete require.cache[require.resolve(path.join(serverDir, 'validate.js'))];
    validate = require(path.join(serverDir, 'validate.js'));
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('finds an OWNER-ONLY theme that exists nowhere in the image', () => {
    delete process.env.DATA_DIR;
    expect(validate.getTheme('owner-only')).toBeNull(); // not in the image
    process.env.DATA_DIR = data;
    const t = validate.getTheme('owner-only');
    expect(t).toBeTruthy();
    expect(t.name_form).toBe('english');
    // and it validates like any other theme
    expect(validate.validateOrderForProduction({ honoree_name: 'Dana' }, t, ['w'])).toEqual([
      'חסר שדה חובה: גיל (AGE)',
    ]);
  });

  it('still sees the shipped themes, with the owner entry winning on a clash', () => {
    process.env.DATA_DIR = data;
    const themes = validate.loadThemes();
    expect(themes['anniversary']).toBeTruthy(); // shipped, not overridden
    expect(themes['bachelorette'].name_form).toBe('english'); // owner override wins
    // Hebrew is the shipped bachelorette's form, so the override flips the check.
    expect(validate.checkNameLanguage('Dana', themes['bachelorette'])).toBeNull();
  });
});

// End-to-end through the REAL Express app on a temp DATA_DIR: the production
// shape, where TEMPLATE_ROOT is the read-only image and DATA_DIR is the volume.
describe('admin template routes persist to the owner store', () => {
  let app;
  let server;
  let base;
  let root;
  let data;
  const storeDir = () => path.join(data, 'templates');
  const ownerThemes = () =>
    JSON.parse(fs.readFileSync(path.join(storeDir(), 'themes.json'), 'utf8'));

  beforeAll(async () => {
    root = makeImage();
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-store-routes-'));
    process.env.DATA_DIR = data;
    process.env.GENERATED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-store-gen-'));
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.TEMPLATE_ROOT = root;
    for (const f of [
      'template-store.js',
      'db.js',
      'pelecard.js',
      'notify.js',
      'templates.js',
      'index.js',
    ]) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
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
    delete process.env.TEMPLATE_ROOT;
    delete process.env.DATA_DIR;
  });

  const json = (p, body, method = 'POST') =>
    fetch(base + p + '?key=' + ADMIN_KEY, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('creates a template into the store, leaving the image tree alone', async () => {
    const res = await json('/api/admin/templates/create', {
      slug: 'route-x',
      display_he: 'דרך הראוט',
      title_text: '{NAME}',
      name_form: 'english',
    });
    expect(res.status).toBe(201);
    expect(fs.existsSync(path.join(storeDir(), 'route-x', 'clean'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'resources', 'canva', 'templates', 'route-x'))).toBe(
      false
    );
    expect(readShipped(root)['route-x']).toBeUndefined();
  });

  it('lists shipped + owner templates together, flagged by provenance', async () => {
    const list = await (await fetch(base + '/api/admin/templates?key=' + ADMIN_KEY)).json();
    const by = Object.fromEntries(list.templates.map((t) => [t.key, t]));
    expect(Object.keys(by).sort()).toEqual(['route-x', 'seed-theme', 'ship-a']);
    expect(by['route-x'].owner).toBe(true);
    expect(by['route-x'].shipped).toBe(false);
    expect(by['ship-a'].owner).toBe(false);
    expect(by['ship-a'].shipped).toBe(true);
  });

  it('a calibration saved on a SHIPPED template survives as an override, image untouched', async () => {
    const res = await json('/api/admin/templates/ship-a/settings', { ...CAL, calibrated: true });
    expect(res.status).toBe(200);
    expect((await res.json()).settings.calibrated).toBe(true);

    expect(ownerThemes()['ship-a'].title_style).toEqual(CAL.title_style);
    expect(readShipped(root)['ship-a'].calibrated).toBe(false);
    expect(readShipped(root)['ship-a'].title_style).toBeNull();
  });

  it('refuses to DELETE a shipped template, and reverts the override instead', async () => {
    const del = await fetch(base + '/api/admin/templates/ship-a?key=' + ADMIN_KEY, {
      method: 'DELETE',
    });
    expect(del.status).toBe(409);
    expect((await del.json()).error).toMatch(/תבנית מובנית/);

    const rev = await json('/api/admin/templates/ship-a/revert');
    expect(rev.status).toBe(200);
    expect(ownerThemes()['ship-a']).toBeUndefined();

    const list = await (await fetch(base + '/api/admin/templates?key=' + ADMIN_KEY)).json();
    const t = list.templates.find((x) => x.key === 'ship-a');
    expect(t.calibrated).toBe(false); // pristine shipped entry is back
    expect(t.owner).toBe(false);

    // 403 without the admin key.
    const noauth = await fetch(base + '/api/admin/templates/ship-a/revert', { method: 'POST' });
    expect(noauth.status).toBe(403);
  });

  it('serves an OWNER template picture from the store via /api/template-image', async () => {
    // Give the shell a filled front so it becomes a storefront product.
    const boundary = '----dugriStore' + Math.random().toString(16).slice(2);
    const parts = [
      Buffer.from('--' + boundary + '\r\n'),
      Buffer.from(
        'Content-Disposition: form-data; name="file"; filename="f.svg"\r\n' +
          'Content-Type: image/svg+xml\r\n\r\n'
      ),
      SVG('OWNER-PRODUCT-ART'),
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ];
    const up = await fetch(
      base + '/api/admin/templates/route-x/assets/filled-fronts?key=' + ADMIN_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
        body: Buffer.concat(parts),
      }
    );
    expect(up.status).toBe(200);

    const img = await fetch(base + '/api/template-image/route-x/front');
    expect(img.status).toBe(200);
    expect(await img.text()).toContain('OWNER-PRODUCT-ART');

    // It also shows up as a custom storefront design.
    const cd = await (await fetch(base + '/api/custom-designs')).json();
    expect(cd.designs.some((d) => d.id === 'route-x')).toBe(true);

    // Traversal is still refused.
    expect((await fetch(base + '/api/template-image/..%2F..%2Fetc/front')).status).toBe(404);
  });
});
