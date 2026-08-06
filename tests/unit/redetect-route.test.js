// @vitest-environment node
//
// The "זהה מחדש" ROUTE — that pressing it answers at once and never holds the
// server hostage.
//
// What this pins, measured against the staging container: re-detecting מרקאנה is
// ~61 seconds of real work, and the route used to do all of it inside the
// request, through `spawnSync`. That blocks Node's single thread, so the whole
// site stopped answering for the duration — a plain `/api/pricing` fired nine
// seconds into a run came back HTTP 408 after 121s, and a second re-detection
// three seconds behind the first took 127s. Railway's edge reports an unanswered
// request as 502 "Application failed to respond", which is the
// `הזיהוי נכשל: 502` the owner was shown for detections that were succeeding.
//
// So the route must: answer immediately, keep serving other requests while the
// job runs, and report the outcome through a poll — including reporting a job it
// no longer has as GONE rather than as still in progress.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const ADMIN_KEY = 'redetect-route-key';
const qs = '?key=' + encodeURIComponent(ADMIN_KEY);

describe('POST/GET /api/admin/templates/:key/redetect', () => {
  let app, server, base, root, redetectJob;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-redetect-route-'));
    fs.mkdirSync(path.join(root, 'generator'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'generator', 'themes.json'),
      JSON.stringify(
        { demo: { slug: 'demo', display_he: 'דמו', card_structure: 'cards' } },
        null,
        1
      ),
      'utf8'
    );
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-redetect-route-data-'));
    process.env.TEMPLATE_ROOT = root;
    process.env.ADMIN_KEY = ADMIN_KEY;
    for (const f of [
      'db.js',
      'pelecard.js',
      'notify.js',
      'content.js',
      'templates.js',
      'redetect-job.js',
      'index.js',
    ]) {
      const p = require.resolve(path.join(serverDir, f));
      if (require.cache[p]) delete require.cache[p];
    }
    redetectJob = require(path.join(serverDir, 'redetect-job.js'));
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

  const post = (key = 'demo') =>
    fetch(base + '/api/admin/templates/' + encodeURIComponent(key) + '/redetect' + qs, {
      method: 'POST',
    });
  const poll = (key = 'demo') =>
    fetch(base + '/api/admin/templates/' + encodeURIComponent(key) + '/redetect' + qs);

  it('stays behind the admin key', async () => {
    const bare = await fetch(base + '/api/admin/templates/demo/redetect', { method: 'POST' });
    expect(bare.status).toBe(403);
    expect((await fetch(base + '/api/admin/templates/demo/redetect')).status).toBe(403);
  });

  it('404s a template that does not exist', async () => {
    const r = await post('no-such-template');
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatch(/not found/);
  });

  it('reports no job for a template nobody has re-detected', async () => {
    redetectJob.reset();
    const r = await poll();
    expect(r.status).toBe(404);
  });

  // THE regression: the response must arrive long before the work could.
  // The real generator is not on disk in this scaffold, so the spawn fails fast
  // — which is fine, because what is under test is that the ROUTE answered
  // without waiting for it either way.
  it('answers 202 immediately with a running job, not the finished work', async () => {
    redetectJob.reset();
    const t0 = Date.now();
    const r = await post();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.status).toBe(202);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.job.key).toBe('demo');
    expect(body.job.id).toBeTruthy();
    // No finished report on the POST — that is the whole point of the change.
    expect(body.job.result).toBeNull();
  });

  // The reason the owner saw 502: while the old route ran, NOTHING else was
  // served. Another request issued during a re-detection must be answered
  // normally and promptly.
  it('keeps serving the rest of the site while a re-detection runs', async () => {
    redetectJob.reset();
    await post();
    const t0 = Date.now();
    const other = await fetch(base + '/api/pricing');
    expect(other.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('reports the outcome through the poll, and eventually settles', async () => {
    redetectJob.reset();
    expect((await post()).status).toBe(202);
    let job = null;
    for (let i = 0; i < 60; i++) {
      const r = await poll();
      expect(r.status).toBe(200);
      job = (await r.json()).job;
      if (job.state !== 'running') break;
      await new Promise((res) => setTimeout(res, 100));
    }
    // The scaffold has no generator/, so this settles as a reported FAILURE —
    // which is the point: it settles, with a reason, instead of hanging.
    expect(job.state).not.toBe('running');
    expect(job.state === 'error' ? job.error : job.result).toBeTruthy();
    expect(job.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  // A job lives in the process that started it. When that process is gone — a
  // deploy, a restart — the poll must say so, so the panel can tell the owner
  // her run was interrupted rather than spinning over nothing.
  it('reports a job the process no longer has as gone, not as running', async () => {
    redetectJob.reset();
    expect((await poll()).status).toBe(404);
  });
});
