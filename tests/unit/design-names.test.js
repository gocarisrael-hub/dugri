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
    // japanese/posttrip/neon/kids themes are absent from the crafted config.
    for (const id of ['japanese', 'posttrip', 'neon', 'kids', 'birthday']) {
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
