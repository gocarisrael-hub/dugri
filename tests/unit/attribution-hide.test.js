// @vitest-environment node
//
// Hiding rows on the ad report.
//
// Every row shows by default; the owner hides the ones she does not want to see
// again, one row at a time, keyed by the row's own (source, medium, campaign,
// content). A PAID row is never hideable. It is DISPLAY ONLY: a hidden row can
// hold orders, and the revenue tile has to keep matching the bank, so the report
// still returns every row and every total.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');

const BIO =
  'https://dugri-israel.co.il/?utm_source=instagram&utm_medium=bio&utm_campaign=bio_insta';
const HOME = 'https://dugri-israel.co.il/';
const GOOGLE = 'https://www.google.com/';

const BIO_ROW = ['instagram', 'bio', 'bio_insta', ''];

const ORIGINAL = {
  dir: process.env.DATA_DIR,
  base: process.env.PUBLIC_BASE_URL,
  admin: process.env.ADMIN_KEY,
};
function restoreEnv() {
  delete process.env.ATTRIBUTION_SAVE_MS;
  for (const [name, value] of [
    ['DATA_DIR', ORIGINAL.dir],
    ['PUBLIC_BASE_URL', ORIGINAL.base],
    ['ADMIN_KEY', ORIGINAL.admin],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function seed(a) {
  a.record({ kind: 'visit', landing: BIO, visitor: 'v1' });
  a.record({ kind: 'visit', landing: HOME, referrer: GOOGLE, visitor: 'v2' });
  a.record({ kind: 'purchase', landing: BIO, visitor: 'v1', order_no: 'D-1', value: 139 });
}

describe('hiding rows in the ledger', () => {
  let dir;

  async function store() {
    vi.resetModules();
    process.env.DATA_DIR = dir;
    return (await import('../../server/attribution.js')).default;
  }

  beforeEach(() => {
    process.env.ATTRIBUTION_SAVE_MS = '100000'; // the ledger itself never needs the disk here
    delete process.env.PUBLIC_BASE_URL; // nothing is internal
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-hidden-'));
  });
  afterEach(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The default is the whole point of the feature: a campaign she never touched
  // must never be missing from the page she sets ad spend from.
  it('hides nothing by default, so every row is on the table', async () => {
    const a = await store();
    seed(a);
    const r = a.report();
    expect(r.hidden_rows).toEqual([]);
    expect(r.rows.some((row) => row.campaign === 'bio_insta')).toBe(true);
  });

  it('hides one row, and every row and total stays in the report either way', async () => {
    const a = await store();
    seed(a);
    const before = a.report();

    expect(a.setRowHidden(BIO_ROW, true)).toEqual({ ok: true, hidden: [BIO_ROW] });
    const after = a.report();
    expect(after.hidden_rows).toEqual([BIO_ROW]);
    expect(after.rows).toEqual(before.rows);
    expect(after.totals).toEqual(before.totals);
    expect(after.totals.revenue).toBe(139);
  });

  it('stops hiding a row', async () => {
    const a = await store();
    a.setRowHidden(BIO_ROW, true);
    expect(a.setRowHidden(BIO_ROW, false)).toEqual({ ok: true, hidden: [] });
  });

  // The expensive mistake this feature could make. A paid row is the row the page
  // exists to show, so it is refused at the door AND on the way back in from disk.
  it('refuses to hide a paid row, whatever the medium is called', async () => {
    const a = await store();
    for (const medium of ['paid', 'cpc', 'ppc', 'cpm', 'ads']) {
      expect(a.setRowHidden(['instagram', medium, 'shm_rovakot', ''], true)).toEqual({
        error: 'a paid row is always shown',
      });
    }
    expect(a.hiddenRows()).toEqual([]);
  });

  it('does not bring a paid row back from a hand-edited file', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'attribution-hidden-rows.json'),
      JSON.stringify([['instagram', 'paid', 'shm_rovakot', ''], BIO_ROW])
    );
    const a = await store();
    expect(a.hiddenRows()).toEqual([BIO_ROW]);
  });

  // The rows the feature exists for: the link builder leaves the name optional,
  // and an ad can be tagged with utm_content alone. Neither carries a campaign
  // name, so neither could be reached by a rule that read only utm_campaign.
  it('hides a row with no campaign name, and a row named only by its content', async () => {
    const a = await store();
    expect(a.setRowHidden(['instagram', 'story', '', ''], true).ok).toBe(true);
    expect(a.setRowHidden(['instagram', 'story', '', 'reel_03'], true).ok).toBe(true);
    expect(a.hiddenRows()).toEqual([
      ['instagram', 'story', '', ''],
      ['instagram', 'story', '', 'reel_03'],
    ]);
  });

  // One row, not one name: hiding a campaign's story link leaves its other
  // placements — and any row that arrives later — on the table.
  it('hides only the row named, not its siblings', async () => {
    const a = await store();
    a.setRowHidden(['instagram', 'story', 'launch', 'reel_01'], true);
    expect(a.hiddenRows()).toEqual([['instagram', 'story', 'launch', 'reel_01']]);
  });

  it('keeps one row hidden when another is ticked (no whole-list overwrite)', async () => {
    const a = await store();
    a.setRowHidden(BIO_ROW, true);
    a.setRowHidden(['instagram', 'story', 'story_alma', ''], true);
    a.setRowHidden(BIO_ROW, false);
    expect(a.hiddenRows()).toEqual([['instagram', 'story', 'story_alma', '']]);
  });

  it('still hides the row after a restart', async () => {
    const a = await store();
    a.setRowHidden(BIO_ROW, true);
    const again = await store();
    expect(again.hiddenRows()).toEqual([BIO_ROW]);
  });

  // A fresh volume has no DATA_DIR yet, and the ledger never creates it (its own
  // writes fail silently). The E2E server hit exactly this: every tick answered
  // "could not save".
  it('saves the choice when the data directory does not exist yet', async () => {
    dir = path.join(dir, 'not-created-yet');
    const a = await store();
    expect(a.setRowHidden(BIO_ROW, true)).toEqual({ ok: true, hidden: [BIO_ROW] });
    const again = await store();
    expect(again.hiddenRows()).toEqual([BIO_ROW]);
  });

  it('names the row however it was typed', async () => {
    const a = await store();
    seed(a);
    a.setRowHidden(['  Instagram ', 'BIO', ' Bio_Insta', ''], true);
    expect(a.report().hidden_rows).toEqual([BIO_ROW]);
  });

  // A file edited by hand, or written by an older build, can hold a name that
  // matches no row: it would hide nothing, sit in the list for ever, and a click
  // that normalises could not delete it. field() runs on the way in too.
  it('normalises and filters what it reads back from disk', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'attribution-hidden-rows.json'),
      JSON.stringify([
        ['Instagram', 'Bio', 'Bio_Insta', ''],
        'bio_insta', // not a row at all
        ['instagram', 'bio'], // not four fields
        ['', '', '', ''], // names nothing
        [1, 2, 3, 4],
      ])
    );
    const a = await store();
    expect(a.hiddenRows()).toEqual([BIO_ROW]);
    // And the normalised entry is the one a click removes.
    expect(a.setRowHidden(BIO_ROW, false)).toEqual({ ok: true, hidden: [] });
  });

  it('caps what it reads back from disk', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'attribution-hidden-rows.json'),
      JSON.stringify(Array.from({ length: 260 }, (_, i) => ['ig', 'story', 'c' + i, '']))
    );
    const a = await store();
    expect(a.hiddenRows()).toHaveLength(200);
  });

  it('refuses a request that names no row or does not say yes or no', async () => {
    const a = await store();
    expect(a.setRowHidden(['', '', '', ''], true)).toEqual({ error: 'row must be four fields' });
    expect(a.setRowHidden('bio_insta', true)).toEqual({ error: 'row must be four fields' });
    expect(a.setRowHidden(['instagram', 'bio'], true)).toEqual({
      error: 'row must be four fields',
    });
    expect(a.setRowHidden(['instagram', 'bio', 1, ''], true)).toEqual({
      error: 'row must be four fields',
    });
    expect(a.setRowHidden(BIO_ROW, 'yes')).toEqual({ error: 'hidden must be true or false' });
    expect(a.hiddenRows()).toEqual([]);
  });

  it('refuses to grow the list without limit', async () => {
    const a = await store();
    for (let i = 0; i < 200; i++) {
      expect(a.setRowHidden(['ig', 'story', 'c' + i, ''], true).ok).toBe(true);
    }
    expect(a.setRowHidden(['ig', 'story', 'one_more', ''], true)).toEqual({
      error: 'too many hidden rows',
    });
    // Ticking one that is already ticked is not growth.
    expect(a.setRowHidden(['ig', 'story', 'c0', ''], true).ok).toBe(true);
  });
});

describe('POST /api/admin/ads/hidden', () => {
  const ADMIN_KEY = 'test-admin-key';
  let server;
  let base;
  let dir;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-hidden-route-'));
    process.env.DATA_DIR = dir;
    process.env.ADMIN_KEY = ADMIN_KEY;
    process.env.ATTRIBUTION_SAVE_MS = '100000';
    delete process.env.PUBLIC_BASE_URL;
    for (const f of ['db.js', 'settings.js', 'attribution.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    const app = require(path.join(serverDir, 'index.js'));
    // The same module instance the app just loaded.
    seed(require(path.join(serverDir, 'attribution.js')));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });
  afterAll(() => {
    if (server) server.close();
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hide = (body, key = ADMIN_KEY) =>
    fetch(base + '/api/admin/ads/hidden' + (key ? '?key=' + key : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const report = async () => (await fetch(base + '/api/admin/ads?key=' + ADMIN_KEY)).json();

  it('refuses without the admin key', async () => {
    expect((await hide({ row: BIO_ROW, hidden: true }, '')).status).toBe(403);
    expect((await hide({ row: BIO_ROW, hidden: true }, 'wrong')).status).toBe(403);
    expect((await report()).hidden_rows).toEqual([]);
  });

  it('refuses a body that names no row or does not say yes or no', async () => {
    expect((await hide({ row: BIO_ROW, hidden: 'yes' })).status).toBe(400);
    expect((await hide({ hidden: true })).status).toBe(400);
    expect((await hide({ row: ['ig', 'paid', 'shm', ''], hidden: true })).status).toBe(400);
  });

  it('hides the row in the report the page reads, and brings it back', async () => {
    const r = await hide({ row: BIO_ROW, hidden: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, hidden: [BIO_ROW] });
    const out = await report();
    expect(out.hidden_rows).toEqual([BIO_ROW]);
    // Hidden is not gone: the row and its sale are still in the answer.
    expect(out.rows.some((row) => row.campaign === 'bio_insta')).toBe(true);
    expect(out.totals.revenue).toBe(139);

    expect((await hide({ row: BIO_ROW, hidden: false })).status).toBe(200);
    expect((await report()).hidden_rows).toEqual([]);
  });
});
