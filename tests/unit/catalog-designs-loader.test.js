// @vitest-environment node
//
// Three catalog routes read site/js/designs.js (the ESM design catalog):
//   GET    /api/design-names          PUBLIC_DESIGNS -> names + fields
//   GET    /api/custom-designs        THEME_BY_DESIGN -> which themes are built in
//   DELETE /api/admin/templates/:key  THEME_BY_DESIGN -> which themes are in use
// These tests pin what each one answers, for a working catalog AND for a catalog
// that cannot be loaded, where the three deliberately differ: the two public
// routes fail SOFT (empty answer, never a thrown page) while the delete guard
// fails CLOSED (refuses, rather than risk deleting an in-use theme).
//
// The routes are mounted straight from server/routes/catalog.js on a bare Express
// app. `__dirname` is how they find site/, so pointing it somewhere empty is how
// the "catalog cannot be loaded" case is produced without touching the repo.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const serverRequire = createRequire(path.join(serverDir, 'index.js'));

const SVG = (label) => `<svg xmlns="http://www.w3.org/2000/svg">${label}</svg>`;

let root;
let templates;
let catalog;
let builtInThemes;
let publicDesigns;

function themesFile() {
  return path.join(root, 'generator', 'themes.json');
}
function readThemes() {
  return JSON.parse(fs.readFileSync(themesFile(), 'utf8'));
}
function writeArt(slug) {
  const dir = path.join(root, 'resources', 'canva', 'templates', slug, 'filled');
  fs.mkdirSync(dir, { recursive: true });
  for (const role of ['fronts', 'backs', 'board']) {
    fs.writeFileSync(path.join(dir, role + '.svg'), SVG(slug + '-' + role));
  }
}

async function mount(dirnameForRoutes) {
  const express = serverRequire('express');
  const app = express();
  const deps = {
    requireAdmin: () => true,
    express,
    fs,
    path,
    __dirname: dirnameForRoutes,
    pathToFileURL,
    TEMPLATE_ROOT: root,
    TEMPLATE_UPLOAD_LIMIT: '100mb',
    PYTHON_BIN: 'python3',
    templates,
  };
  catalog.registerTemplateOnboarding(app, deps);
  catalog.registerStorefrontTemplates(app, deps);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-catalog-loader-'));
  fs.mkdirSync(path.join(root, 'generator'), { recursive: true });

  const designs = await import('../../site/js/designs.js');
  builtInThemes = [...new Set(Object.values(designs.THEME_BY_DESIGN))];
  publicDesigns = designs.PUBLIC_DESIGNS;
  expect(builtInThemes.length).toBeGreaterThan(0);

  // Every built-in theme (named, with fields, and WITH art on disk so only the
  // catalog can exclude it from the custom list), then four uploaded templates.
  const themes = {};
  for (const key of builtInThemes) {
    themes[key] = {
      slug: key,
      display_he: 'NAME:' + key,
      extra_fields: ['AGE'],
      language: 'hebrew',
      calibrated: true,
    };
    writeArt(key);
  }
  themes['my-custom'] = {
    slug: 'my-custom',
    display_he: 'עיצוב שלי',
    visibility: 'public',
    calibrated: false,
    extra_fields: ['YEARS'],
    language: 'english',
    name_form: 'couple',
  };
  themes['hidden-one'] = { slug: 'hidden-one', display_he: 'מוסתר', visibility: 'private' };
  themes['shell-one'] = { slug: 'shell-one', display_he: 'ריק', visibility: 'public' };
  themes['deletable'] = { slug: 'deletable', display_he: 'למחיקה', visibility: 'private' };
  fs.writeFileSync(themesFile(), JSON.stringify(themes, null, 1) + '\n', 'utf8');
  writeArt('my-custom');
  writeArt('hidden-one');
  writeArt('deletable');

  delete process.env.DATA_DIR; // no owner store: the throwaway root is the only layer
  for (const f of ['templates.js', 'template-store.js', 'routes/catalog.js']) {
    const p = require.resolve(path.join(serverDir, f));
    if (require.cache[p]) delete require.cache[p];
  }
  templates = require(path.join(serverDir, 'templates.js'));
  catalog = require(path.join(serverDir, 'routes', 'catalog.js'));
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('catalog available', () => {
  let server;
  let base;
  beforeAll(async () => {
    ({ server, base } = await mount(serverDir));
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  it('GET /api/design-names answers the PUBLIC_DESIGNS names and fields', async () => {
    const r = await fetch(base + '/api/design-names');
    expect(r.status).toBe(200);
    const body = await r.json();
    const themes = readThemes();
    expect(body).toEqual({
      names: templates.designDisplayNames(themes, publicDesigns),
      fields: templates.designThemeFields(themes, publicDesigns),
    });
    // Not vacuous: the built-in names really came through.
    expect(body.names.bachelorette).toBe('NAME:bachelorette');
    expect(Object.keys(body.names).length).toBeGreaterThan(0);
    expect(Object.keys(body.fields).length).toBeGreaterThan(0);
  });

  it('serves a template SVG as a sandboxed document (CSP + nosniff)', async () => {
    const r = await fetch(base + '/api/template-image/my-custom/front');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/image\/svg\+xml/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = r.headers.get('content-security-policy') || '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('img-src data:');
    expect(csp).toContain('sandbox');
    // The body still went through the sanitizer (a script inside would be gone),
    // and a directly opened image can run nothing under this policy.
    expect(await r.text()).toContain('my-custom-fronts');
  });

  it('GET /api/custom-designs lists only the public uploaded template with art', async () => {
    const r = await fetch(base + '/api/custom-designs');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      designs: [
        {
          id: 'my-custom',
          name: 'עיצוב שלי',
          theme: 'my-custom',
          custom: true,
          public: true,
          calibrated: false,
          hasBoard: true,
          extra_fields: ['YEARS'],
          language: 'english',
          name_form: 'couple',
          img: {
            front: '/api/template-image/my-custom/front',
            back: '/api/template-image/my-custom/back',
            board: '/api/template-image/my-custom/board',
          },
        },
      ],
    });
  });

  it('DELETE refuses every theme a built-in design maps to (409)', async () => {
    for (const key of builtInThemes) {
      const r = await fetch(base + '/api/admin/templates/' + encodeURIComponent(key), {
        method: 'DELETE',
      });
      expect(key + ':' + r.status).toBe(key + ':409');
      expect(await r.json()).toEqual({
        error: 'template is in use by a live design and cannot be deleted',
      });
    }
    for (const key of builtInThemes) expect(readThemes()[key]).toBeTruthy();
  });

  it('DELETE answers 404 for an unknown key', async () => {
    const r = await fetch(base + '/api/admin/templates/no-such-template', { method: 'DELETE' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'template not found' });
  });

  it('DELETE removes an uploaded template no design uses', async () => {
    const r = await fetch(base + '/api/admin/templates/deletable', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, key: 'deletable', deleted: true });
    expect(readThemes().deletable).toBeUndefined();
  });
});

describe('catalog cannot be loaded', () => {
  let server;
  let base;
  let missingDir;
  beforeAll(async () => {
    // A server/ with no ../site/js/designs.js next to it.
    missingDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-no-site-')), 'server');
    fs.mkdirSync(missingDir, { recursive: true });
    ({ server, base } = await mount(missingDir));
  });
  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(path.dirname(missingDir), { recursive: true, force: true });
  });

  it('GET /api/design-names fails soft to empty maps', async () => {
    const r = await fetch(base + '/api/design-names');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ names: {}, fields: {} });
  });

  it('GET /api/custom-designs fails soft to an empty list, not to every theme', async () => {
    const r = await fetch(base + '/api/custom-designs');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ designs: [] });
  });

  it('DELETE fails CLOSED: 500 and the template stays', async () => {
    const r = await fetch(base + '/api/admin/templates/hidden-one', { method: 'DELETE' });
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toMatch(
      /^could not verify the template is safe to delete \(catalog unavailable\): \S/
    );
    expect(readThemes()['hidden-one']).toBeTruthy();
  });

  // A failed load is not remembered: once the catalog is there, the next request
  // sees it, as it did when every request imported the file itself.
  it('recovers on the next request once the catalog can be loaded', async () => {
    const siteJs = path.join(path.dirname(missingDir), 'site', 'js');
    fs.cpSync(path.join(serverDir, '..', 'site', 'js'), siteJs, { recursive: true });
    const r = await fetch(base + '/api/design-names');
    expect((await r.json()).names.bachelorette).toBe('NAME:bachelorette');
    const c = await (await fetch(base + '/api/custom-designs')).json();
    expect(c.designs.map((d) => d.id)).toEqual(['my-custom']);
  });
});

describe('one loader', () => {
  it('server/routes/catalog.js imports site/js/designs.js in exactly one place', () => {
    const src = fs.readFileSync(path.join(serverDir, 'routes', 'catalog.js'), 'utf8');
    expect(src.match(/\bimport\(/g) || []).toHaveLength(1);
  });
});
