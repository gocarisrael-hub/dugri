// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runSmoke } from '../../scripts/smoke.mjs';

// Boot the REAL Express app in-process against an isolated temp DATA_DIR and
// with NO PeleCard credentials, then run the live smoke script against it. This
// proves runSmoke passes end-to-end without touching real data or any gateway.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverIndexPath = path.join(__dirname, '..', '..', 'server', 'index.js');

let server;
let baseUrl;

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-smoke-'));
  process.env.DATA_DIR = dataDir;
  // Ensure the payment flag resolves to a boolean `false` (no creds set).
  delete process.env.PELECARD_TERMINAL;
  delete process.env.PELECARD_USER;
  delete process.env.PELECARD_PASSWORD;

  // server/index.js exports the app and guards app.listen behind
  // `require.main === module`, so requiring it does not auto-listen.
  const app = require(serverIndexPath);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe('runSmoke against the live app', () => {
  it('passes all checks (static pages, API round-trip, payment flag)', async () => {
    await expect(runSmoke(baseUrl)).resolves.toBe(true);
  });

  it('rejects when pointed at a dead URL', async () => {
    // Port 1 is not listening — the static-page fetch must fail loudly.
    await expect(runSmoke('http://127.0.0.1:1')).rejects.toThrow(/SMOKE FAILED/);
  });
});
