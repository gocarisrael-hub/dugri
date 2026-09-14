// @vitest-environment node
//
// THE ORDER THE APP REGISTERS ITS ROUTES AND MIDDLEWARE IN, pinned.
//
// Express answers a request with the FIRST matching layer, so order is behaviour:
// the /api JSON 404 must come after every /api route, the SPA `GET *` fallback
// after everything, and a body-size limit before the route it guards. That order
// used to be implicit in one 8,800-line server/index.js. The monolith is now being
// split by domain into server/routes/<domain>.js (docs/agent-partition.md,
// "Splitting the monolith"), with each moved block registered at the spot it used
// to occupy — and this snapshot is what proves a move kept that promise.
//
// A diff here means the route table changed. If you ADDED or REMOVED a route on
// purpose, update the snapshot (npx vitest run -u tests/unit/route-order.test.js)
// and read the diff: it should show exactly your route, in exactly the place you
// meant, and nothing else moving.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

let app;

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-route-order-'));
  process.env.ADMIN_KEY = 'test-admin-key';
  for (const f of ['settings.js', 'db.js', 'index.js']) {
    delete require.cache[require.resolve(path.join(serverDir, f))];
  }
  app = require(path.join(serverDir, 'index.js'));
});

// One line per layer: METHOD path for a route, USE <mount regexp> (name) for a
// middleware. Handler names are left out on purpose — naming an anonymous handler
// is not a change in routing.
function routeTable(expressApp) {
  return expressApp._router.stack.map((layer) => {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).join(',').toUpperCase();
      return `${methods} ${layer.route.path}`;
    }
    return `USE ${layer.regexp} (${layer.name})`;
  });
}

describe('route registration order', () => {
  it('matches the pinned table', () => {
    expect(routeTable(app)).toMatchSnapshot();
  });

  it('keeps the catch-alls last: the /api 404, then static, then the SPA fallback', () => {
    const table = routeTable(app);
    const api404 = table.lastIndexOf('USE /^\\/api\\/?(?=\\/|$)/i (<anonymous>)');
    const spa = table.indexOf('GET *');
    const lastApiRoute = table.findLastIndex((l) => / \/api\//.test(l) && !l.startsWith('USE'));
    expect(api404).toBeGreaterThan(lastApiRoute);
    expect(spa).toBeGreaterThan(api404);
    expect(table.indexOf('USE /^\\/?(?=\\/|$)/i (serveStatic)')).toBeLessThan(spa);
  });
});
