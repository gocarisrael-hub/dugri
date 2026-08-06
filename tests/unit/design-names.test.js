// @vitest-environment node
//
// The design-name propagation path end to end at the seam of the two name
// sources:
//   (A) GET /api/design-names on the real Express app — the public endpoint that
//       maps generator/themes.json display_he onto orderable design ids, so an
//       admin "rename template" reaches the storefront. Booted against a THROWAWAY
//       TEMPLATE_ROOT so no real config is touched, and asserted to expose ONLY
//       names (no other theme field / secret).
//   (B) fetchDesignNames() — the buyer-facing client fetcher in site/js/designs.js
//       that MUST never block/break a page: timeout + every failure resolves to {}.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

describe('GET /api/design-names — public storefront name map', () => {
  let app;
  let server;
  let base;
  let themesFile;

  beforeAll(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dn-root-'));
    fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
    themesFile = path.join(root, 'generator', 'themes.json');
    // A crafted themes.json: real design ids map bachelorette->bachelorette and
    // marriage->anniversary (see site/js/designs.js THEME_BY_DESIGN). We rename
    // both and stash a SECRET field to prove it is never exposed. Other designs'
    // themes are ABSENT here, so those designs are omitted from the map.
    const themes = {
      bachelorette: {
        slug: 'bachelorette',
        display_he: 'RENAMED-BACH',
        title_font: 'SECRET-FONT.ttf',
        wordlist: 'SECRET-WORDLIST.txt',
      },
      anniversary: { slug: 'anniversary', display_he: '  RENAMED-ANNIV  ' },
    };
    fs.writeFileSync(themesFile, JSON.stringify(themes, null, 1) + '\n', 'utf8');

    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-dn-data-'));
    process.env.ADMIN_KEY = 'dn-admin-key';
    process.env.TEMPLATE_ROOT = root;
    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'templates.js', 'index.js']) {
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

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  it('returns { names } with each mapped design id -> its theme display_he (trimmed)', async () => {
    const res = await fetch(base + '/api/design-names');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body && typeof body.names).toBe('object');
    expect(body.names.bachelorette).toBe('RENAMED-BACH');
    expect(body.names.marriage).toBe('RENAMED-ANNIV'); // anniversary theme, trimmed
  });

  it('omits designs whose theme is not in themes.json (page keeps built-in name)', async () => {
    const body = await (await fetch(base + '/api/design-names')).json();
    // japanese/posttrip/kids themes are absent from the crafted config.
    for (const id of ['japanese', 'posttrip', 'kids', 'birthday']) {
      expect(id in body.names).toBe(false);
    }
  });

  it('exposes ONLY names — no secret theme field leaks', async () => {
    const raw = await (await fetch(base + '/api/design-names')).text();
    expect(raw).not.toContain('SECRET-FONT.ttf');
    expect(raw).not.toContain('SECRET-WORDLIST.txt');
    expect(raw).not.toContain('title_font');
    expect(raw).not.toContain('wordlist');
    expect(raw).not.toContain('slug');
  });

  it('returns names ONLY for public designs (built from PUBLIC_DESIGNS)', async () => {
    const { PUBLIC_DESIGNS, DESIGNS } = await import('../../site/js/designs.js');
    const publicIds = new Set(PUBLIC_DESIGNS.map((d) => d.id));
    const privateIds = DESIGNS.filter((d) => !d.public).map((d) => d.id);
    const body = await (await fetch(base + '/api/design-names')).json();
    for (const id of Object.keys(body.names)) expect(publicIds.has(id)).toBe(true);
    // Any private design id must never appear (guards against a switch back to DESIGNS).
    for (const id of privateIds) expect(id in body.names).toBe(false);
  });

  it('reflects a themes.json rename without a restart (mtime cache invalidates)', async () => {
    // Warm the cache.
    let body = await (await fetch(base + '/api/design-names')).json();
    expect(body.names.bachelorette).toBe('RENAMED-BACH');
    // Rewrite themes.json out-of-band and bump its mtime so the read-side cache
    // (keyed by mtime) reloads — the endpoint must serve the new name.
    const next = {
      bachelorette: { slug: 'bachelorette', display_he: 'RENAMED-AGAIN' },
      anniversary: { slug: 'anniversary', display_he: 'RENAMED-ANNIV' },
    };
    fs.writeFileSync(themesFile, JSON.stringify(next, null, 1) + '\n', 'utf8');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(themesFile, future, future);
    body = await (await fetch(base + '/api/design-names')).json();
    expect(body.names.bachelorette).toBe('RENAMED-AGAIN');
  });
});

describe('fetchDesignNames — buyer-facing, fail-soft client fetcher', () => {
  let fetchDesignNames;
  beforeAll(async () => {
    ({ fetchDesignNames } = await import('../../site/js/designs.js'));
  });
  afterAll(() => vi.unstubAllGlobals());

  const okRes = (obj) => ({ ok: true, status: 200, json: async () => obj });

  it('returns the { id: name } map on a well-formed response, dropping junk entries', async () => {
    const fetchImpl = vi.fn(async () =>
      okRes({ names: { bachelorette: 'רווקות', marriage: '', kids: 42, japanese: '  ' } })
    );
    const names = await fetchDesignNames({ fetchImpl });
    // empty / whitespace / non-string values are dropped; good entries kept
    expect(names).toEqual({ bachelorette: 'רווקות' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/design-names', expect.any(Object));
  });

  it('falls back to {} on a non-OK status', async () => {
    const names = await fetchDesignNames({ fetchImpl: async () => ({ ok: false, status: 500 }) });
    expect(names).toEqual({});
  });

  it('falls back to {} on malformed / missing-names JSON', async () => {
    expect(await fetchDesignNames({ fetchImpl: async () => okRes({ nope: 1 }) })).toEqual({});
    expect(
      await fetchDesignNames({
        fetchImpl: async () => ({
          ok: true,
          json: async () => {
            throw new Error('bad json');
          },
        }),
      })
    ).toEqual({});
  });

  it('falls back to {} on a network error / rejected fetch', async () => {
    const names = await fetchDesignNames({
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    expect(names).toEqual({});
  });

  it('aborts and falls back to {} when the endpoint is slower than the timeout', async () => {
    // Honor the AbortSignal: reject when aborted, matching real fetch semantics.
    const fetchImpl = (url, opts) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(okRes({ names: { bachelorette: 'late' } })), 5000);
        const sig = opts && opts.signal;
        if (sig) {
          sig.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        }
      });
    const names = await fetchDesignNames({ fetchImpl, timeoutMs: 20 });
    expect(names).toEqual({});
  });
});

// (C) applyDesignNames — writes the fetched names ONTO the catalog objects, so a
// rename reaches everything read from the catalog after the fetch (analytics
// labels, the designName stored on an order, any list built later) and not just
// the nodes a page happens to re-stamp.
describe('applyDesignNames — the rename reaches the catalog itself', () => {
  let applyDesignNames;
  beforeAll(async () => {
    ({ applyDesignNames } = await import('../../site/js/designs.js'));
  });

  const catalog = () => [
    { id: 'bachelorette', name: 'מסיבת רווקות' },
    { id: 'birthday', name: 'יום הולדת' },
  ];

  it('overwrites the built-in name and reports which ids changed', () => {
    const list = catalog();
    const changed = applyDesignNames({ bachelorette: 'פרידה מהרווקות' }, list);
    expect(changed).toEqual(['bachelorette']);
    expect(list[0].name).toBe('פרידה מהרווקות');
    // an id the map omits keeps its built-in name
    expect(list[1].name).toBe('יום הולדת');
  });

  it('trims, and reports nothing when the name is unchanged', () => {
    const list = catalog();
    expect(applyDesignNames({ bachelorette: '  מסיבת רווקות  ' }, list)).toEqual([]);
    expect(list[0].name).toBe('מסיבת רווקות');
  });

  it('never blanks a name from an empty, whitespace or non-string value', () => {
    const list = catalog();
    const changed = applyDesignNames({ bachelorette: '', birthday: '   ', kids: 'ילדים' }, list);
    expect(changed).toEqual([]);
    expect(list.map((d) => d.name)).toEqual(['מסיבת רווקות', 'יום הולדת']);
  });

  it('is a no-op for a missing/malformed map or list (page never breaks)', () => {
    const list = catalog();
    // `undefined` is deliberately absent from the list cases: it is the DEFAULT
    // argument, which resolves to the real catalog — that is the documented call
    // shape, not a malformed one.
    for (const bad of [null, undefined, 'nope', 42]) {
      expect(applyDesignNames(bad, list)).toEqual([]);
    }
    for (const badList of [null, 'nope', 42]) {
      expect(applyDesignNames({ bachelorette: 'x' }, badList)).toEqual([]);
    }
    expect(list[0].name).toBe('מסיבת רווקות');
  });

  it('ignores catalog entries with no id', () => {
    const list = [{ name: 'orphan' }, null, { id: 'birthday', name: 'יום הולדת' }];
    expect(applyDesignNames({ birthday: 'ימי הולדת' }, list)).toEqual(['birthday']);
    expect(list[2].name).toBe('ימי הולדת');
  });
});

// (D) syncDesignNames — the ONE buyer-side entry point. Every page that shows a
// design name calls exactly this, so no page can end up on the stale side of a
// rename by doing half the dance (fetch but never write the catalog, or re-stamp
// nodes before the catalog is updated).
describe('syncDesignNames — fetch, write the catalog, THEN re-stamp', () => {
  let syncDesignNames;
  beforeAll(async () => {
    ({ syncDesignNames } = await import('../../site/js/designs.js'));
  });

  const okRes = (obj) => ({ ok: true, status: 200, json: async () => obj });
  const fetchOk = (names) => async () => okRes({ names });

  it('applies the names to the given lists and reports the changed ids', async () => {
    const list = [
      { id: 'bachelorette', name: 'ישן' },
      { id: 'birthday', name: 'יום הולדת' },
    ];
    const seen = [];
    const names = await syncDesignNames((n, changed) => seen.push([n, changed]), {
      lists: [list],
      fetchImpl: fetchOk({ bachelorette: 'פריז' }),
    });
    expect(names).toEqual({ bachelorette: 'פריז' });
    expect(list[0].name).toBe('פריז');
    expect(list[1].name).toBe('יום הולדת');
    expect(seen).toEqual([[{ bachelorette: 'פריז' }, ['bachelorette']]]);
  });

  it('updates the catalog BEFORE the re-stamp callback runs', async () => {
    // The ordering guarantee is the whole point: a callback that reads d.name (or
    // anything built from the catalog) must never see the pre-rename value.
    const list = [{ id: 'bachelorette', name: 'ישן' }];
    let nameAtCallback = null;
    await syncDesignNames(
      () => {
        nameAtCallback = list[0].name;
      },
      { lists: [list], fetchImpl: fetchOk({ bachelorette: 'פריז' }) }
    );
    expect(nameAtCallback).toBe('פריז');
  });

  it('de-duplicates changed ids across several lists sharing the same objects', async () => {
    const shared = { id: 'bachelorette', name: 'ישן' };
    let changed = null;
    await syncDesignNames((n, c) => (changed = c), {
      lists: [[shared], [shared]],
      fetchImpl: fetchOk({ bachelorette: 'פריז' }),
    });
    expect(changed).toEqual(['bachelorette']);
  });

  it('still calls back (with no changes) on a failed fetch, so the page can proceed', async () => {
    const list = [{ id: 'bachelorette', name: 'ישן' }];
    let called = null;
    const names = await syncDesignNames((n, c) => (called = [n, c]), {
      lists: [list],
      fetchImpl: async () => ({ ok: false, status: 503 }),
    });
    expect(names).toEqual({});
    expect(called).toEqual([{}, []]);
    expect(list[0].name).toBe('ישן'); // built-in name stands
  });

  it('works with no callback at all', async () => {
    const list = [{ id: 'birthday', name: 'ישן' }];
    await expect(
      syncDesignNames(null, { lists: [list], fetchImpl: fetchOk({ birthday: 'קליפורניה' }) })
    ).resolves.toEqual({ birthday: 'קליפורניה' });
    expect(list[0].name).toBe('קליפורניה');
  });
});

// (E) The REPO DEFAULTS. A rename is stored on the volume, so the repo can only
// ever hold a default — but the two defaults it holds (the META table baked into
// site/js/designs.js, and generator/themes.json display_he) must agree, or a page
// that paints before /api/design-names resolves shows a name from a previous
// naming era while the admin already shows the current one. That is exactly the
// drift the owner reported, one layer down.
describe('repo defaults — the bundled catalog name matches themes.json display_he', () => {
  it('every built-in design defaults to its theme display_he', async () => {
    const { DESIGNS } = await import('../../site/js/designs.js');
    const themesPath = path.join(__dirname, '..', '..', 'generator', 'themes.json');
    const themes = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
    const checked = [];
    for (const d of DESIGNS) {
      const entry =
        d.theme && Object.prototype.hasOwnProperty.call(themes, d.theme) ? themes[d.theme] : null;
      const shipped = entry && typeof entry.display_he === 'string' ? entry.display_he.trim() : '';
      if (!shipped) continue; // a design whose theme names nothing has only one default
      checked.push(d.id);
      expect(d.id + '=' + d.name).toBe(d.id + '=' + shipped);
    }
    // Guard the guard: if the catalog ever stops resolving themes this test must
    // fail loudly instead of silently checking nothing.
    expect(checked.length).toBe(DESIGNS.length);
  });
});
