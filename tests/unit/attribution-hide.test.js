// @vitest-environment node
//
// Manual campaigns on the ad report.
//
// A row with a campaign name came from a link somebody named by hand. The owner
// asked for those rows to stay off the table until she picks them. It is DISPLAY
// ONLY: an unpicked campaign can hold paid orders, and the revenue tile has to
// keep matching the bank, so the report still returns every row.
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

describe('picking manual campaigns in the ledger', () => {
  let dir;

  async function store() {
    vi.resetModules();
    process.env.DATA_DIR = dir;
    return (await import('../../server/attribution.js')).default;
  }

  beforeEach(() => {
    process.env.ATTRIBUTION_SAVE_MS = '100000'; // the ledger itself never needs the disk here
    delete process.env.PUBLIC_BASE_URL; // nothing is internal
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-campaigns-'));
  });
  afterEach(() => {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('picks nothing by default', async () => {
    const a = await store();
    seed(a);
    expect(a.report().shown_campaigns).toEqual([]);
  });

  it('shows a campaign, and every row and total stays in the report either way', async () => {
    const a = await store();
    seed(a);
    const before = a.report();

    expect(a.setCampaignShown('bio_insta', true)).toEqual({ ok: true, shown: ['bio_insta'] });
    const after = a.report();
    expect(after.shown_campaigns).toEqual(['bio_insta']);
    expect(after.rows).toEqual(before.rows);
    expect(after.totals).toEqual(before.totals);
    expect(after.totals.revenue).toBe(139);
  });

  it('stops showing a campaign', async () => {
    const a = await store();
    a.setCampaignShown('bio_insta', true);
    expect(a.setCampaignShown('bio_insta', false)).toEqual({ ok: true, shown: [] });
  });

  it('keeps one campaign when another is ticked (no whole-list overwrite)', async () => {
    const a = await store();
    a.setCampaignShown('bio_insta', true);
    a.setCampaignShown('story_alma', true);
    a.setCampaignShown('bio_insta', false);
    expect(a.shownCampaigns()).toEqual(['story_alma']);
  });

  it('still shows the campaign after a restart', async () => {
    const a = await store();
    a.setCampaignShown('bio_insta', true);
    const again = await store();
    expect(again.shownCampaigns()).toEqual(['bio_insta']);
  });

  it('names the campaign however it was typed', async () => {
    const a = await store();
    seed(a);
    a.setCampaignShown('  Bio_Insta ', true);
    expect(a.report().shown_campaigns).toEqual(['bio_insta']);
  });

  it('refuses a request that names no campaign or does not say yes or no', async () => {
    const a = await store();
    expect(a.setCampaignShown('', true)).toEqual({ error: 'campaign is required' });
    expect(a.setCampaignShown(['bio_insta'], true)).toEqual({ error: 'campaign is required' });
    expect(a.setCampaignShown('bio_insta', 'yes')).toEqual({
      error: 'shown must be true or false',
    });
    expect(a.shownCampaigns()).toEqual([]);
  });

  it('refuses to grow the list without limit', async () => {
    const a = await store();
    for (let i = 0; i < 200; i++) expect(a.setCampaignShown('c' + i, true).ok).toBe(true);
    expect(a.setCampaignShown('one_more', true)).toEqual({ error: 'too many campaigns' });
    // Ticking one that is already ticked is not growth.
    expect(a.setCampaignShown('c0', true).ok).toBe(true);
  });
});

describe('POST /api/admin/ads/campaigns', () => {
  const ADMIN_KEY = 'test-admin-key';
  let server;
  let base;
  let dir;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-campaigns-route-'));
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

  const pick = (body, key = ADMIN_KEY) =>
    fetch(base + '/api/admin/ads/campaigns' + (key ? '?key=' + key : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const report = async () => (await fetch(base + '/api/admin/ads?key=' + ADMIN_KEY)).json();

  it('refuses without the admin key', async () => {
    expect((await pick({ campaign: 'bio_insta', shown: true }, '')).status).toBe(403);
    expect((await pick({ campaign: 'bio_insta', shown: true }, 'wrong')).status).toBe(403);
    expect((await report()).shown_campaigns).toEqual([]);
  });

  it('refuses a body that names no campaign or does not say yes or no', async () => {
    expect((await pick({ campaign: 'bio_insta', shown: 'yes' })).status).toBe(400);
    expect((await pick({ shown: true })).status).toBe(400);
  });

  it('shows the campaign in the report the page reads, and hides it again', async () => {
    const r = await pick({ campaign: 'bio_insta', shown: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, shown: ['bio_insta'] });
    const shown = await report();
    expect(shown.shown_campaigns).toEqual(['bio_insta']);
    expect(shown.rows.some((row) => row.campaign === 'bio_insta')).toBe(true);
    expect(shown.totals.revenue).toBe(139);

    expect((await pick({ campaign: 'bio_insta', shown: false })).status).toBe(200);
    const unpicked = await report();
    expect(unpicked.shown_campaigns).toEqual([]);
    // Not picked is not gone: the row and its sale are still in the answer.
    expect(unpicked.rows.some((row) => row.campaign === 'bio_insta')).toBe(true);
  });
});
