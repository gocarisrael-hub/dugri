// @vitest-environment node
//
// Re-detection as a JOB rather than as the answer to an HTTP request.
//
// The bug this covers, measured against the staging container: one press of
// "זהה מחדש" on מרקאנה is ~61 seconds of work (7-9s of recipe_diff, 53-59s of
// calibrate), and both ran through `spawnSync` — which blocks Node's single
// thread for the child's whole life. For those 61 seconds the server answered
// nothing at all: a plain `/api/pricing` fired nine seconds into a run came back
// HTTP 408 after 121s, and a second re-detection started three seconds after the
// first took 127s because it sat out the first one's entire run. Railway's edge
// answers an unanswered request with 502 "Application failed to respond" — the
// `הזיהוי נכשל: 502` the owner saw for detections that were actually SUCCEEDING.
//
// So these are the properties that matter, and each has its own test below:
//   * starting a job RETURNS IMMEDIATELY, long before the work is done
//   * the work does not run on the event loop
//   * a second press does not start a second pass over the same files
//   * progress is real — read off what the detector actually printed
//   * failure is reported, not swallowed, and never leaves a job "running"
//   * a job that no longer exists is reported as gone, never as in progress
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const job = require(path.join(serverDir, 'redetect-job.js'));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// A stand-in for server/templates.js exposing exactly the surface the job uses.
// Written out rather than stubbed off the real module so that if the job ever
// starts reaching for something else, this fails loudly instead of silently
// picking up real behaviour.
function fakeTemplates(overrides = {}) {
  return {
    redetectPlan: () => ({ cards: true, recipeName: 'demo', themesPath: '/tmp/themes.json' }),
    recipeDiffPlan: () => ({
      args: ['recipe_diff.py', '--single', '/t', 'demo'],
      out: '/tmp/r.json',
    }),
    recipeDiffOutcome: ({ result }) => ({
      ok: result.status === 0,
      recipe: '/tmp/r.json',
      detail: result.status === 0 ? null : result.stderr,
    }),
    calibratePlan: () => ({ args: ['calibrate.py', 'demo'], out: '/tmp/c.json' }),
    calibrateOutcome: ({ result }) => ({
      ok: result.status === 0,
      blob: { ok: true },
      detail: result.status === 0 ? null : result.stderr,
    }),
    applyCalibration: () => {},
    themesPathFor: () => '/tmp/themes.json',
    redetectReport: ({ key, calibration }) => ({
      key,
      recipe: '/tmp/r.json',
      calibrated: !!calibration.ok,
      detail: null,
      declined: [],
    }),
    ...overrides,
  };
}

describe('re-detection runs as a job, off the request', () => {
  beforeEach(() => job.reset());

  // THE regression. The old route did the whole 61 seconds inline; this must
  // come back with a live job before the first command has even finished.
  it('returns a running job immediately instead of waiting for the work', async () => {
    let release;
    const runner = () => new Promise((r) => (release = r));
    const t0 = Date.now();
    const started = job.start({ root: '/r', key: 'demo', templates: fakeTemplates(), runner });
    expect(Date.now() - t0).toBeLessThan(100);
    expect(started.state).toBe('running');
    expect(started.stage).toBe('detecting');
    expect(started.stageText).toBe(job.STAGE_TEXT.detecting);
    expect(started.id).toBeTruthy();
    release({ status: 1, stderr: 'stop here' });
    await tick(10);
  });

  // The whole point: the event loop keeps turning while detection runs. If the
  // work were still synchronous this timer could not fire before the job ended.
  it('leaves the event loop free while the work runs', async () => {
    let release;
    const runner = () => new Promise((r) => (release = r));
    job.start({ root: '/r', key: 'demo', templates: fakeTemplates(), runner });
    let ticked = false;
    setTimeout(() => (ticked = true), 5);
    await tick(20);
    expect(ticked).toBe(true);
    expect(job.get('demo').state).toBe('running');
    release({ status: 1, stderr: 'stop here' });
    await tick(10);
  });

  it('runs detection then calibration, and reports the finished result', async () => {
    const calls = [];
    const runner = (bin, args) => {
      calls.push(args[0]);
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };
    job.start({ root: '/r', key: 'demo', templates: fakeTemplates(), runner });
    await tick(20);
    const done = job.get('demo');
    expect(calls).toEqual(['recipe_diff.py', 'calibrate.py']);
    expect(done.state).toBe('done');
    expect(done.stage).toBeNull();
    expect(done.result.calibrated).toBe(true);
    expect(done.finishedAt).toBeTruthy();
  });

  // Progress the owner can believe: "front 5:" is a line recipe_diff.py really
  // prints, once per card it has measured.
  it('reads progress off what the detector actually printed', async () => {
    let release;
    const runner = (bin, args, opts) =>
      new Promise((r) => {
        if (args[0] === 'recipe_diff.py') {
          opts.onLine('front 2: 4 words + 1 title box(es)');
          opts.onLine('front 5: 4 words + 1 title box(es)');
        }
        release = r;
      });
    job.start({ root: '/r', key: 'demo', templates: fakeTemplates(), runner });
    await tick(10);
    const live = job.get('demo');
    expect(live.fronts).toBe(4); // fronts are numbered 2..9, so "front 5" is the 4th
    expect(live.frontsTotal).toBe(8);
    release({ status: 1, stderr: 'stop here' });
    await tick(10);
  });

  // Two detections writing one recipe is a race with no winner. A second press
  // must join the run in flight, not start a rival pass over the same files.
  it('does not start a second pass while one is already running', async () => {
    let starts = 0;
    let release;
    const runner = () => {
      starts += 1;
      return new Promise((r) => (release = r));
    };
    const tpl = fakeTemplates();
    const a = job.start({ root: '/r', key: 'demo', templates: tpl, runner });
    const b = job.start({ root: '/r', key: 'demo', templates: tpl, runner });
    expect(b.id).toBe(a.id);
    expect(starts).toBe(1);
    release({ status: 1, stderr: 'stop here' });
    await tick(10);
  });

  it('reports a detection failure instead of leaving the job running forever', async () => {
    const runner = () => Promise.resolve({ status: 1, stderr: 'chrome exploded' });
    job.start({ root: '/r', key: 'demo', templates: fakeTemplates(), runner });
    await tick(20);
    const done = job.get('demo');
    expect(done.state).toBe('error');
    expect(done.error).toMatch(/chrome exploded/);
    expect(done.httpStatus).toBe(422);
  });

  // Calibration failing while detection succeeded is a real, actionable state —
  // the same one the synchronous path surfaced — and must not read as a crash.
  it('reports a recipe that landed while calibration did not', async () => {
    const runner = (bin, args) =>
      Promise.resolve(
        args[0] === 'calibrate.py' ? { status: 1, stderr: 'no board' } : { status: 0, stdout: '' }
      );
    job.start({ root: '/r', key: 'demo', templates: fakeTemplates(), runner });
    await tick(20);
    const done = job.get('demo');
    expect(done.state).toBe('done');
    expect(done.result.calibrated).toBe(false);
  });

  // A throw anywhere in the plumbing is still an outcome the owner must see.
  it('never leaves a job stuck on running when the plumbing throws', async () => {
    const tpl = fakeTemplates({
      recipeDiffPlan: () => {
        throw new Error('bad plan');
      },
    });
    job.start({ root: '/r', key: 'demo', templates: tpl, runner: () => Promise.resolve({}) });
    await tick(20);
    expect(job.get('demo').state).toBe('error');
    expect(job.get('demo').error).toMatch(/bad plan/);
  });

  it('refuses a template that does not exist without registering a job', () => {
    const tpl = fakeTemplates({
      redetectPlan: () => ({ error: 'template not found', httpStatus: 404 }),
    });
    const r = job.start({
      root: '/r',
      key: 'nope',
      templates: tpl,
      runner: () => Promise.resolve({}),
    });
    expect(r.httpStatus).toBe(404);
    expect(job.get('nope')).toBeNull();
  });

  // A job is a running child process, so it cannot outlive the process. The
  // panel is told "gone", which it renders as "the server restarted, press
  // again" — never as a spinner over work that no longer exists.
  it('reports nothing for a key with no job, so a lost run reads as lost', () => {
    expect(job.get('demo')).toBeNull();
  });

  it('forgets finished jobs once nobody is going to ask again', async () => {
    const runner = () => Promise.resolve({ status: 0, stdout: '' });
    job.start({ root: '/r', key: 'demo', templates: fakeTemplates(), runner });
    await tick(20);
    expect(job.get('demo').state).toBe('done');
    job.sweepStale(Date.now() + job.KEEP_FINISHED_MS + 1000);
    expect(job.get('demo')).toBeNull();
  });

  it('keeps a RUNNING job however long it runs — sweeping is for finished ones', async () => {
    let release;
    job.start({
      root: '/r',
      key: 'demo',
      templates: fakeTemplates(),
      runner: () => new Promise((r) => (release = r)),
    });
    job.sweepStale(Date.now() + 10 * job.KEEP_FINISHED_MS);
    expect(job.get('demo').state).toBe('running');
    release({ status: 1, stderr: 'stop here' });
    await tick(10);
  });
});

// The spawn helper itself, against real processes. This is the part that has to
// be right for the container: it must not block, it must collect output, and its
// timeout must take the whole process GROUP — generator/chrome.py leaves Chrome
// in the generator's group precisely so that killing the group reclaims the
// browser, and spawnSync's timeout never did, which is how orphaned Chromes once
// exhausted the container's PID budget.
describe('runAsync', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-redetect-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('collects stdout, stderr and the exit status', async () => {
    const r = await job.runAsync('sh', ['-c', 'echo out; echo err 1>&2; exit 3'], { cwd: tmp });
    expect(r.status).toBe(3);
    expect(r.stdout.trim()).toBe('out');
    expect(r.stderr.trim()).toBe('err');
  });

  it('streams stdout line by line as it arrives', async () => {
    const lines = [];
    await job.runAsync('sh', ['-c', 'echo one; echo two; echo three'], {
      cwd: tmp,
      onLine: (l) => lines.push(l),
    });
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('does not block the event loop', async () => {
    let ticked = false;
    setTimeout(() => (ticked = true), 5);
    await job.runAsync('sh', ['-c', 'sleep 0.2'], { cwd: tmp });
    expect(ticked).toBe(true);
  });

  // The orphan fix: the child's CHILD must die too, not just the child. The
  // grandchild here stands in for headless Chrome.
  it('kills the whole process group on timeout, not just the child', async () => {
    const marker = path.join(tmp, 'grandchild-lived.txt');
    const r = await job.runAsync(
      'sh',
      ['-c', `sh -c 'sleep 2; echo alive > ${marker}' & sleep 5`],
      { cwd: tmp, timeout: 300 }
    );
    expect(r.status).toBeNull();
    expect(r.stderr).toMatch(/timed out/);
    await tick(2500);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('reports an unrunnable binary rather than throwing', async () => {
    const r = await job.runAsync('/definitely/not/a/binary', [], { cwd: tmp });
    expect(r.status).toBeNull();
    expect(r.stderr).toBeTruthy();
  });
});
