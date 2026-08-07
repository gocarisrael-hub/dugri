// @vitest-environment node
//
// The LIVE theme-fields path — how "which inputs does the order wizard ask for?"
// gets from the admin to the buyer's browser.
//
// The bug this covers: site/js/designs.js carries THEME_EXTRA_FIELDS, a mirror of
// generator/themes.json compiled into the browser bundle. The owner changed
// סנטוריני (design id `marriage`, theme `anniversary`) in the ADMIN from a couple
// deck to a ONE-PERSON deck — an edit that lands in the owner themes.json on the
// volume — and the wizard went on demanding two partner names and years-married,
// because a baked-in mirror can never see an admin edit. No amount of fixing the
// DATA would have helped; the propagation path had to exist.
//
// Four seams, in the order the value travels:
//   (A) templates.designThemeFields() — pure, whitelisted, prototype-safe
//   (B) GET /api/design-names `fields` — on the real Express app, against a
//       throwaway TEMPLATE_ROOT, including a hot edit with no restart
//   (C) fetchDesignMeta() — buyer-facing, so every failure is fail-soft
//   (D) applyThemeFields()/syncDesignNames() — the live values land on the catalog
//       objects, which is what extraFieldsForDesign() reads
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

// ---------------------------------------------------------------------------
// (A) designThemeFields — pure
// ---------------------------------------------------------------------------
describe('templates.designThemeFields — the live per-design wizard fields', () => {
  let templates;
  beforeAll(() => {
    templates = require(path.join(serverDir, 'templates.js'));
  });

  const DESIGNS = [
    { id: 'marriage', theme: 'anniversary' },
    { id: 'bachelorette', theme: 'bachelorette' },
    { id: 'japanese', theme: 'japanese' },
  ];

  it('reads extra_fields / language / name_form off each design theme', () => {
    const themes = {
      anniversary: { extra_fields: [], language: 'hebrew', name_form: 'hebrew' },
      japanese: { extra_fields: ['AGE'], language: 'english', name_form: 'english-caps' },
    };
    const out = templates.designThemeFields(themes, DESIGNS);
    expect(out.marriage).toEqual({ extra_fields: [], language: 'hebrew', name_form: 'hebrew' });
    expect(out.japanese).toEqual({
      extra_fields: ['AGE'],
      language: 'english',
      name_form: 'english-caps',
    });
  });

  it('OMITS a design whose theme is missing, so the client keeps its built-in default', () => {
    const out = templates.designThemeFields({ japanese: { extra_fields: ['AGE'] } }, DESIGNS);
    expect('bachelorette' in out).toBe(false);
    expect('marriage' in out).toBe(false);
  });

  it('exposes ONLY the three whitelisted keys — no other theme field rides along', () => {
    const themes = {
      anniversary: {
        extra_fields: ['YEARS'],
        language: 'hebrew',
        name_form: 'hebrew',
        title_font: 'SECRET-FONT.ttf',
        wordlist: 'SECRET-WORDLIST.txt',
        board: { fill: '#004aad' },
      },
    };
    const out = templates.designThemeFields(themes, DESIGNS);
    expect(Object.keys(out.marriage).sort()).toEqual(['extra_fields', 'language', 'name_form']);
  });

  it('normalizes junk rather than handing it to the wizard as a field', () => {
    const themes = {
      anniversary: { extra_fields: ['AGE', 7, null, '', { k: 1 }, 'YEARS'] },
      japanese: { extra_fields: 'AGE', language: 42 },
    };
    const out = templates.designThemeFields(themes, DESIGNS);
    expect(out.marriage.extra_fields).toEqual(['AGE', 'YEARS']);
    // a non-array extra_fields is "no extra fields", never a string spread into chars
    expect(out.japanese.extra_fields).toEqual([]);
    expect(out.japanese.language).toBe('hebrew'); // fallback, not 42
    expect(out.japanese.name_form).toBe(null);
  });

  it('is prototype-pollution safe and tolerates junk arguments', () => {
    expect(templates.designThemeFields({}, [{ id: 'x', theme: '__proto__' }])).toEqual({});
    expect(templates.designThemeFields({}, [{ id: 'x', theme: 'constructor' }])).toEqual({});
    expect(templates.designThemeFields(null, DESIGNS)).toEqual({});
    expect(templates.designThemeFields({ anniversary: {} }, null)).toEqual({});
    expect(
      templates.designThemeFields({ anniversary: {} }, [null, { theme: 'anniversary' }])
    ).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// (B) GET /api/design-names `fields` — the real endpoint
// ---------------------------------------------------------------------------
describe('GET /api/design-names — the fields map', () => {
  let server;
  let base;
  let themesFile;

  beforeAll(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dtf-root-'));
    fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
    themesFile = path.join(root, 'generator', 'themes.json');
    // marriage -> anniversary (see site/js/designs.js THEME_BY_DESIGN). The owner
    // has this theme collecting the COUPLE fields, which is the OPPOSITE of the
    // shipped default — so a response carrying them proves the endpoint reads the
    // live config and not the bundle.
    fs.writeFileSync(
      themesFile,
      JSON.stringify(
        {
          anniversary: {
            slug: 'anniversary',
            display_he: 'סנטוריני',
            extra_fields: ['YEARS', 'NAME1', 'NAME2'],
            language: 'hebrew',
            name_form: 'hebrew',
            title_font: 'SECRET-FONT.ttf',
          },
          bachelorette: { slug: 'bachelorette', display_he: 'פריז', extra_fields: [] },
        },
        null,
        1
      ) + '\n',
      'utf8'
    );

    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dtf-data-'));
    process.env.ADMIN_KEY = 'dtf-admin-key';
    process.env.TEMPLATE_ROOT = root;
    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'templates.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    const app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  it('serves the LIVE extra_fields per design id, beside the names', async () => {
    const res = await fetch(base + '/api/design-names');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.names.marriage).toBe('סנטוריני');
    expect(body.fields.marriage.extra_fields).toEqual(['YEARS', 'NAME1', 'NAME2']);
    expect(body.fields.marriage.language).toBe('hebrew');
    expect(body.fields.bachelorette.extra_fields).toEqual([]);
  });

  it('omits designs whose theme is absent (the client keeps its built-in default)', async () => {
    const body = await (await fetch(base + '/api/design-names')).json();
    for (const id of ['japanese', 'posttrip', 'kids', 'birthday']) {
      expect(id in body.fields).toBe(false);
    }
  });

  it('still leaks no other theme field', async () => {
    const raw = await (await fetch(base + '/api/design-names')).text();
    expect(raw).not.toContain('SECRET-FONT.ttf');
    expect(raw).not.toContain('title_font');
    expect(raw).not.toContain('slug');
  });

  it('reflects an ADMIN field change with no restart and no rebuild', async () => {
    // Warm the read-side cache with the couple shape...
    let body = await (await fetch(base + '/api/design-names')).json();
    expect(body.fields.marriage.extra_fields).toEqual(['YEARS', 'NAME1', 'NAME2']);
    // ...then the owner makes it a ONE-PERSON deck in the admin (which rewrites
    // themes.json). The endpoint must serve the new shape immediately.
    fs.writeFileSync(
      themesFile,
      JSON.stringify(
        {
          anniversary: { slug: 'anniversary', display_he: 'סנטוריני', extra_fields: [] },
          bachelorette: { slug: 'bachelorette', display_he: 'פריז', extra_fields: [] },
        },
        null,
        1
      ) + '\n',
      'utf8'
    );
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(themesFile, future, future);
    body = await (await fetch(base + '/api/design-names')).json();
    expect(body.fields.marriage.extra_fields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (C) fetchDesignMeta — buyer-facing, fail-soft
// ---------------------------------------------------------------------------
function okRes(json) {
  return { ok: true, status: 200, json: async () => json };
}

describe('fetchDesignMeta — never blocks or breaks the wizard', () => {
  let fetchDesignMeta;
  let fetchDesignNames;
  beforeAll(async () => {
    ({ fetchDesignMeta, fetchDesignNames } = await import('../../site/js/designs.js'));
  });

  it('returns the names AND fields maps', async () => {
    const meta = await fetchDesignMeta({
      fetchImpl: async () =>
        okRes({
          names: { marriage: 'סנטוריני' },
          fields: { marriage: { extra_fields: [], language: 'hebrew' } },
        }),
    });
    expect(meta.names).toEqual({ marriage: 'סנטוריני' });
    expect(meta.fields.marriage.extra_fields).toEqual([]);
  });

  it('resolves to EMPTY maps on every failure path (never rejects)', async () => {
    const empty = { names: {}, fields: {} };
    expect(await fetchDesignMeta({ fetchImpl: async () => ({ ok: false, status: 500 }) })).toEqual(
      empty
    );
    expect(
      await fetchDesignMeta({
        fetchImpl: async () => {
          throw new Error('network down');
        },
      })
    ).toEqual(empty);
    expect(await fetchDesignMeta({ fetchImpl: async () => okRes({ nope: 1 }) })).toEqual(empty);
    expect(await fetchDesignMeta({ fetchImpl: async () => okRes(null) })).toEqual(empty);
  });

  it('drops non-object field entries instead of passing them on', async () => {
    const meta = await fetchDesignMeta({
      fetchImpl: async () =>
        okRes({ fields: { marriage: 'nope', japanese: { extra_fields: [] } } }),
    });
    expect('marriage' in meta.fields).toBe(false);
    expect(meta.fields.japanese).toEqual({ extra_fields: [] });
  });

  it('times out rather than hanging the name step', async () => {
    const meta = await fetchDesignMeta({
      fetchImpl: (url, opts) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(okRes({ names: { marriage: 'late' } })), 1000);
          if (opts && opts.signal) {
            opts.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          }
        }),
      timeoutMs: 20,
    });
    expect(meta).toEqual({ names: {}, fields: {} });
  });

  it('fetchDesignNames still returns just the names map', async () => {
    const names = await fetchDesignNames({
      fetchImpl: async () => okRes({ names: { marriage: 'סנטוריני' }, fields: { marriage: {} } }),
    });
    expect(names).toEqual({ marriage: 'סנטוריני' });
  });
});

// ---------------------------------------------------------------------------
// (D) applyThemeFields / syncDesignNames — the value lands where the wizard reads
// ---------------------------------------------------------------------------
describe('applyThemeFields — the admin edit reaches the catalog objects', () => {
  let applyThemeFields;
  let syncDesignNames;
  let extraFieldsForDesign;
  let languageForDesign;
  beforeAll(async () => {
    ({ applyThemeFields, syncDesignNames, extraFieldsForDesign, languageForDesign } =
      await import('../../site/js/designs.js'));
  });

  const catalog = () => [
    { id: 'marriage', theme: 'anniversary', name: 'סנטוריני' },
    { id: 'japanese', theme: 'japanese', name: 'טוקיו' },
  ];

  it('writes the live fields onto the design and reports what changed', () => {
    const list = catalog();
    const changed = applyThemeFields(
      { marriage: { extra_fields: ['YEARS', 'NAME1', 'NAME2'], language: 'hebrew' } },
      list
    );
    expect(changed).toEqual(['marriage']);
    expect(list[0].extra_fields).toEqual(['YEARS', 'NAME1', 'NAME2']);
    // extraFieldsForDesign reads the object's own values, so THIS is what the
    // wizard now asks for — the whole point of the propagation path.
    expect(extraFieldsForDesign(list[0])).toEqual(['YEARS', 'NAME1', 'NAME2']);
  });

  it('an emptied field set really does empty the wizard ask', () => {
    const list = catalog();
    applyThemeFields({ marriage: { extra_fields: [] } }, list);
    expect(extraFieldsForDesign(list[0])).toEqual([]);
  });

  it('reports no change when the fields already match', () => {
    const list = catalog();
    applyThemeFields({ marriage: { extra_fields: ['AGE'] } }, list);
    expect(applyThemeFields({ marriage: { extra_fields: ['AGE'] } }, list)).toEqual([]);
  });

  it('leaves a design on its built-in defaults when the payload is junk', () => {
    for (const junk of [null, undefined, 'nope', 42, { marriage: null }, { marriage: 'x' }]) {
      const list = catalog();
      expect(applyThemeFields(junk, list)).toEqual([]);
      expect('extra_fields' in list[0]).toBe(false);
      // ...so the resolver still answers from the bundled mirror.
      expect(extraFieldsForDesign(list[0])).toEqual(extraFieldsForDesign('marriage'));
    }
  });

  it('ignores a malformed extra_fields but still takes a valid language', () => {
    const list = catalog();
    applyThemeFields({ marriage: { extra_fields: 'AGE', language: 'english' } }, list);
    expect('extra_fields' in list[0]).toBe(false);
    expect(languageForDesign(list[0])).toBe('english');
  });

  it('syncDesignNames stamps the fields onto the catalog it is given', async () => {
    const list = catalog();
    let restampFields = null;
    await syncDesignNames((names, changed, fields) => (restampFields = fields), {
      lists: [list],
      fetchImpl: async () =>
        okRes({
          names: { marriage: 'סנטוריני' },
          fields: { marriage: { extra_fields: ['YEARS', 'NAME1', 'NAME2'] } },
        }),
    });
    expect(extraFieldsForDesign(list[0])).toEqual(['YEARS', 'NAME1', 'NAME2']);
    // ...and the page is handed the map so it can re-render what it derived.
    expect(restampFields.marriage.extra_fields).toEqual(['YEARS', 'NAME1', 'NAME2']);
  });

  it('a fields-only change is NOT reported as a name change (tiles must not relabel)', async () => {
    const list = catalog();
    let changedIds = null;
    await syncDesignNames((names, changed) => (changedIds = changed), {
      lists: [list],
      fetchImpl: async () => okRes({ names: {}, fields: { marriage: { extra_fields: ['AGE'] } } }),
    });
    expect(changedIds).toEqual([]);
    expect(extraFieldsForDesign(list[0])).toEqual(['AGE']);
  });

  it('a dead endpoint leaves the catalog on its bundled defaults', async () => {
    const list = catalog();
    await syncDesignNames(null, {
      lists: [list],
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    expect('extra_fields' in list[0]).toBe(false);
    expect(extraFieldsForDesign(list[0])).toEqual(extraFieldsForDesign('marriage'));
  });
});
