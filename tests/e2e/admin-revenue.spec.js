import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './tpl-fixture.js';

// THE OWNER'S MONTHLY REVENUE PAGE, against a stubbed Tranzila Reports API.
//
// The shared e2e server has no Tranzila terminal, so this spec starts its own
// server (own port, own throwaway store) with Tranzila variables pointing the
// report at a stub HTTP server in this process. The rows are the shapes
// production's report really returns: a charge is DEBIT / A, a refund has no
// txn_type and tranmode C<index>.
const KEY = 'rev-e2e-owner';

const ilMonth = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
const NOW = ilMonth(new Date());
const PREV = (() => {
  const [y, m] = NOW.split('-').map(Number);
  return m === 1 ? y - 1 + '-12' : y + '-' + String(m - 1).padStart(2, '0');
})();

const row = (index, date, amount, extra = {}) => ({
  index,
  transaction_date: date,
  transaction_time: '12:00:00',
  amount,
  currency: '1',
  processor_response_code: '000',
  txn_type: 'DEBIT',
  tranmode: 'A',
  payment_plan: 1,
  ...extra,
});
const ROWS = [
  // A site order (DG-9101, two copies), and a 40 ₪ refund on it.
  row(8001, NOW + '-01', 47800, { user_defined_10: 'dp00000000000000a1' }),
  row(8002, NOW + '-01', 4000, { txn_type: '', tranmode: 'C8001' }),
  // A B2B charge typed into the terminal: no site order.
  row(8003, NOW + '-01', 250000),
  // A staging test on the shared terminal.
  row(8004, NOW + '-01', 200, { user_defined_10: 'ds00000000000000b2' }),
];

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let stub;
let child;
let base;

test.beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const q = body ? JSON.parse(body) : {};
      const list = ROWS.filter(
        (r) =>
          r.transaction_date >= q.transaction_start_date &&
          r.transaction_date <= q.transaction_end_date
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transactions: list }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubBase = 'http://127.0.0.1:' + stub.address().port;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-rev-e2e-'));
  const paidAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(dataDir, 'dugri-data.json'),
    JSON.stringify({
      collections: [
        {
          id: 'reve2e1',
          order_no: 'DG-9101',
          created_at: paidAt,
          order: {
            paid: true,
            paid_at: paidAt,
            paid_method: 'tranzila',
            paid_transaction_id: '8001',
            charged_total: 478,
            total: 478,
            quantity: 2,
          },
        },
        {
          id: 'reve2e2',
          order_no: 'DG-9102',
          created_at: paidAt,
          order: {
            paid: true,
            paid_at: PREV + '-10T10:00:00.000Z',
            paid_method: 'pelecard',
            paid_transaction_id: 'uuid-9102',
            charged_total: 239,
            total: 239,
            quantity: 1,
          },
        },
      ],
      words: [],
    })
  );

  const port = await freePort();
  base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_KEY: KEY,
      PAYMENT_ENV: 'production',
      TRANZILA_TERMINAL: 'fxpe2e',
      TRANZILA_APP_KEY: 'e2e-app',
      TRANZILA_SECRET: 'e2e-secret',
      TRANZILA_REPORT_BASE: stubBase,
      REVENUE_TRANZILA_FROM: PREV,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(base + '/api/pricing');
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('revenue e2e server did not start');
});

test.afterAll(async () => {
  if (child) child.kill();
  if (stub) await new Promise((r) => stub.close(r));
});

test('monthly table, chart, B2B copies and exclusions', async ({ page }) => {
  await page.goto(base + '/admin-revenue.html?key=' + KEY);

  const cur = page.locator(`#months tbody tr[data-month="${NOW}"]`);
  const prev = page.locator(`#months tbody tr[data-month="${PREV}"]`);
  // This month: 478 + 2,500 − 40 = 2,938 ₪; orders: the site order and the B2B
  // charge; copies: the site order's two (the B2B one is not filled in yet).
  await expect(cur.locator('td').nth(1).locator('.v')).toHaveText('2,938 ₪');
  await expect(cur.locator('td').nth(1)).toContainText('זיכויים');
  await expect(cur.locator('td').nth(2).locator('.v')).toHaveText('2');
  await expect(cur.locator('td').nth(3).locator('.v')).toHaveText('2');
  await expect(cur.locator('td').nth(4)).toContainText('טרנזילה');
  // Last month came from PeleCard, from our own orders.
  await expect(prev.locator('td').nth(1).locator('.v')).toHaveText('239 ₪');
  await expect(prev.locator('td').nth(4)).toContainText('פלאקארד');

  // A bar per month, revenue and copies.
  await expect(page.locator(`#chart g[data-month="${NOW}"] rect`)).toHaveCount(2);

  // The B2B charge waits for its copies, and the page says so.
  await expect(page.locator('#unfilledWarn')).toBeVisible();
  await expect(page.locator('#unfilledWarn')).toContainText('1');
  const b2b = page.locator('#unmatched tr[data-index="8003"]');
  await expect(b2b).toContainText('2,500');
  await b2b.locator('input.copies').fill('20');
  await b2b.locator('input.copies').press('Enter');
  await b2b.locator('input.copies').blur();
  await expect(page.locator('#unfilledWarn')).toBeHidden();
  await expect(cur.locator('td').nth(3).locator('.v')).toHaveText('22');

  // Kept on the server: a reload shows it again.
  await page.reload();
  await expect(page.locator('#unmatched tr[data-index="8003"] input.copies')).toHaveValue('20');

  // The staging charge is shown as left out, and can be counted back in.
  const staging = page.locator('#excluded tr[data-index="8004"]');
  await expect(staging).toContainText('הסביבה הניסיונית');
  await staging.getByRole('button', { name: 'לספור' }).click();
  await expect(page.locator('#excludedSec')).toBeHidden();
  await expect(cur.locator('td').nth(1).locator('.v')).toHaveText('2,940 ₪');
});

test('a wrong key shows no numbers', async ({ page }) => {
  await page.goto(base + '/admin-revenue.html?key=wrong');
  await expect(page.locator('#content')).toContainText('מפתח גישה שגוי');
  await expect(page.locator('#report')).toBeHidden();
});

test('the dashboard links to it, carrying the key', async ({ page }) => {
  await page.goto(base + '/dashboard.html?key=' + KEY);
  await expect(page.locator('#links a', { hasText: 'הכנסות לפי חודש' })).toHaveAttribute(
    'href',
    'admin-revenue.html?key=' + KEY
  );
});
