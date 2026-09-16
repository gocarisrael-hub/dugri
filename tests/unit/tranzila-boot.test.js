// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The boot path itself: `node server/index.js`, the require.main block, with
// Tranzila configured against a stub Reports API. A charge made while the
// server was down must be found by the sweep the server runs as it starts, with
// no notify and no manual call. The periodic tick is pushed out to 10 minutes
// here, so nothing but the boot sweep can have settled it.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');
const serverDir = path.join(repoRoot, 'server');

let stub;
let stubUrl;
const stubCalls = [];
let rows = [];
let child;
let dataDir;
let childLog = '';

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      stubCalls.push({ path: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ transactions: rows }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubUrl = 'http://127.0.0.1:' + stub.address().port;
});

afterAll(async () => {
  if (child && child.exitCode == null) child.kill('SIGKILL');
  await new Promise((r) => stub.close(r));
});

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'dugri-data.json'), 'utf8'));
  } catch {
    return null;
  }
}

describe('node server/index.js with Tranzila configured', () => {
  it('sweeps at boot and settles a charge made while it was down', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-tz-boot-'));
    const env = {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: '0',
      PUBLIC_BASE_URL: 'https://test.dugri.example',
      PAYMENT_PROVIDER: 'tranzila',
      PAYMENT_ENV: 'staging',
      TRANZILA_TERMINAL: 'fxptest',
      TRANZILA_APP_KEY: 'app-key',
      TRANZILA_SECRET: 'app-secret',
      TRANZILA_REPORT_BASE: stubUrl,
      TRANZILA_SWEEP_TICK_MS: String(10 * 60 * 1000),
    };
    delete env.PELECARD_TERMINAL;
    delete env.VITEST;
    delete env.NODE_ENV;

    // The store as a previous process left it: an unpaid order with a Tranzila
    // session, written to DATA_DIR with the real store module.
    process.env.DATA_DIR = dataDir;
    process.env.PAYMENT_ENV = 'staging';
    const dbPath = require.resolve(path.join(serverDir, 'db.js'));
    delete require.cache[dbPath];
    const db = require(dbPath);
    const tz = require(path.join(serverDir, 'tranzila.js'));
    const c = db.createCollection('נפלה בזמן הפריסה');
    db.setOrder(c.id, c.owner_token, { version: 'pickup' });
    const token = tz.newSessionToken();
    db.recordPaymentInit(c.id, {
      paramToken: token,
      charged_total: 199,
      provider: 'tranzila',
      priceKey: db.orderPriceKey(db.getCollection(c.id).order),
    });
    delete require.cache[dbPath];
    delete process.env.PAYMENT_ENV;

    rows = [
      {
        index: 61001,
        amount: 19900,
        currency: '1',
        processor_response_code: '000',
        txn_type: 'DEBIT',
        tranmode: 'A',
        authorization_number: 'A61001',
        user_defined_1: token,
      },
    ];

    child = spawn(process.execPath, [path.join(serverDir, 'index.js')], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => (childLog += d));
    child.stderr.on('data', (d) => (childLog += d));

    // Well inside the 10-minute tick: only the boot sweep can settle it in time.
    const deadline = Date.now() + 15000;
    let paid = false;
    while (Date.now() < deadline && !paid) {
      await new Promise((r) => setTimeout(r, 200));
      const store = readStore();
      const col = store && store.collections.find((x) => x.id === c.id);
      paid = !!(col && col.order && col.order.paid);
    }
    child.kill('SIGKILL');

    expect(paid, 'server log:\n' + childLog).toBe(true);
    const sweep = stubCalls.find((x) => x.body && x.body.transaction_start_date);
    expect(sweep, 'server log:\n' + childLog).toBeTruthy();
    expect(sweep.path).toBe('/v1/transaction');
    expect(sweep.body.transaction_index).toBeUndefined();
  }, 30000);
});
