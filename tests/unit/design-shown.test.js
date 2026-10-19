// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The owner's one switch for a design, "מוצג באתר" (templates.shownOnSite). Design codes are gone, so a design is
// either shown on the site or hidden from all of it. What these pin, on the real Express app over its own themes.json:
// - the rule: shown only when the theme is public AND in store; either one off hides it; a private theme never turns
//   public by itself;
// - the admin's `shown` patch writes both stored fields, both ways;
// - the server side of "hidden everywhere": /api/design-names lists the hidden built-ins (the storefront drops them),
//   /api/custom-designs leaves out a hidden template, the sitemap leaves out a hidden design, and POST /api/collections
//   refuses a hidden or unknown design (an order with no theme is left as it was).
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const SVG = (label) => `<svg xmlns="http://www.w3.org/2000/svg">${label}</svg>`;

describe('a design is shown on the site, or hidden from all of it', () => {
  let app, server, base, root, templates, mod;
  // built-in designs by theme, from the real catalog
  const designOf = (theme) => mod.DESIGNS.find((d) => d.theme === theme).id;

  function writeTemplate(slug) {
    const dir = path.join(root, 'resources', 'canva', 'templates', slug, 'filled');
    fs.mkdirSync(dir, { recursive: true });
    for (const role of ['fronts', 'backs', 'board'])
      fs.writeFileSync(path.join(dir, role + '.svg'), SVG(slug + '-' + role));
  }

  beforeAll(async () => {
    mod = await import(pathToFileURL(path.join(serverDir, '..', 'site', 'js', 'designs.js')).href);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-shown-'));
    fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'generator', 'themes.json'),
      JSON.stringify({
        // built-ins: one shown, one set private (code-only once), one taken off the shop floor
        bachelorette: { slug: 'bachelorette', display_he: 'פריז', visibility: 'public' },
        anniversary: { slug: 'anniversary', display_he: 'נישואין', visibility: 'private' },
        japanese: { slug: 'japanese', display_he: 'יפני', in_store: false },
        // templates: one shown, one hidden
        'my-custom': { slug: 'my-custom', display_he: 'שלי', visibility: 'public' },
        'hid-custom': { slug: 'hid-custom', display_he: 'מוסתר', visibility: 'private' },
      }),
      'utf8'
    );
    writeTemplate('my-custom');
    writeTemplate('hid-custom');
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-shown-data-'));
    process.env.TEMPLATE_ROOT = root;
    for (const f of [
      'db.js',
      'pelecard.js',
      'notify.js',
      'content.js',
      'templates.js',
      'index.js',
    ]) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
    templates = require(path.join(serverDir, 'templates.js'));
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

  it('is shown only when public and in store', () => {
    const { shownOnSite } = templates;
    expect(shownOnSite({})).toBe(true); // a theme written before either field: shown, as it was
    expect(shownOnSite({ visibility: 'public', in_store: true })).toBe(true);
    expect(shownOnSite({ visibility: 'private' })).toBe(false); // once "with a code": now hidden, never public
    expect(shownOnSite({ visibility: 'public', in_store: false })).toBe(false);
    expect(shownOnSite(null)).toBe(false);
  });

  it('the admin’s one switch writes both stored fields, both ways', () => {
    const read = () => templates.loadThemesCached(templates.themesPathFor(root))['my-custom'];
    let r = templates.updateTemplateSettings({ root, key: 'my-custom', patch: { shown: false } });
    expect(r.error).toBeUndefined();
    expect(read()).toMatchObject({ visibility: 'private', in_store: false });
    r = templates.updateTemplateSettings({ root, key: 'my-custom', patch: { shown: true } });
    expect(r.error).toBeUndefined();
    expect(read()).toMatchObject({ visibility: 'public', in_store: true });
    expect(templates.shownOnSite(read())).toBe(true);
  });

  it('/api/design-names lists the hidden built-ins, and names only the shown ones', async () => {
    const body = await (await fetch(base + '/api/design-names')).json();
    expect(body.hidden.sort()).toEqual([designOf('anniversary'), designOf('japanese')].sort());
    expect(body.names[designOf('bachelorette')]).toBe('פריז');
    expect(body.names).not.toHaveProperty(designOf('anniversary'));
  });

  it('/api/custom-designs leaves out a hidden template', async () => {
    const ids = (await (await fetch(base + '/api/custom-designs')).json()).designs.map((d) => d.id);
    expect(ids).toContain('my-custom');
    expect(ids).not.toContain('hid-custom');
  });

  it('the sitemap leaves out a hidden design', async () => {
    const xml = await (await fetch(base + '/sitemap.xml')).text();
    expect(xml).toContain('design=' + designOf('bachelorette'));
    expect(xml).not.toContain('design=' + designOf('anniversary'));
    expect(xml).not.toContain('design=' + designOf('japanese'));
  });

  it('an order for a hidden or unknown design is refused; a shown one, or none, goes through', async () => {
    const order = (theme) =>
      fetch(base + '/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ custom_title: 'נועה', design: 'x', ...(theme ? { theme } : {}) }),
      });
    for (const theme of ['anniversary', 'japanese', 'hid-custom', 'no-such-theme', '__proto__']) {
      const r = await order(theme);
      expect(r.status, theme).toBe(400);
      expect((await r.json()).error, theme).toBe('design not available');
    }
    for (const theme of ['bachelorette', 'my-custom', null]) {
      const r = await order(theme);
      expect(r.ok, String(theme)).toBe(true);
    }
  });
});
