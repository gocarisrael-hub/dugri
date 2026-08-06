// Re-detection ("זהה מחדש") as a JOB, not as an HTTP request.
//
// WHY THIS EXISTS — measured, in the staging container, not on a laptop:
//
//   recipe_diff.py --single  on מרקאנה   7-9s
//   calibrate.py             on מרקאנה  53-59s
//   ------------------------------------------
//   one press of the button            ~61s
//
// and `server/templates.js` ran both through **spawnSync**. spawnSync blocks
// Node's single thread for the whole child's life, so for those 61 seconds the
// server answered NOTHING — not the admin page, not a customer's product page,
// not the health probe. Measured against staging: while one re-detection ran,
// `/api/pricing` timed out eight times in a row, a plain page request fired nine
// seconds in came back **HTTP 408 after 121s**, and a second re-detection
// started three seconds later took **127s** — it sat out the first one's whole
// run before its own began. Railway's edge answers an unanswered request with
// **502 "Application failed to respond"**, which is exactly the
// `הזיהוי נכשל: 502` the owner saw. The work usually SUCCEEDED; nobody was
// listening when it finished.
//
// Two things follow, and this module does both.
//
//   1. Spawn ASYNCHRONOUSLY. `child_process.spawn`, not spawnSync. The event
//      loop stays free, so the site keeps serving while detection runs and one
//      admin action can no longer take the storefront down with it.
//
//   2. Do not hold the request open. A 61-second request is fragile to every
//      restart — a deploy, a crash, a proxy's own ceiling — and it loses the
//      work when any of them lands. The POST starts the job and returns at
//      once; the panel polls, and sees which STAGE is running rather than a
//      spinner that may or may not mean anything.
//
// What this deliberately does NOT do is make the failure quieter. A job that
// dies with the process is reported as INTERRUPTED on the next poll, never as
// "still running" forever (see `sweepStale`) — the owner has to be able to tell
// "it is working" from "it stopped and nothing was written".
//
// It also fixes a real leak on the way. spawnSync's `timeout` signals the child
// ONLY — the Python — and generator/chrome.py says in as many words that Chrome
// is left in the generator's process group precisely so that killing the GROUP
// takes the browser with it. spawnSync never killed the group, so every timed-out
// detection orphaned a headless Chrome; nine hundred of those exhausted the
// container's PID budget once already. This spawns detached and kills the whole
// group.
const { spawn } = require('child_process');

// Per-stage ceilings, matching what the synchronous path allowed. Generous
// against the measured 9s/59s so a slow shared container CPU never has a real
// run cut short, while a genuinely stuck child is still reclaimed.
const RECIPE_TIMEOUT_MS = Number(process.env.REDETECT_RECIPE_TIMEOUT_MS || 300000);
const CALIBRATE_TIMEOUT_MS = Number(process.env.REDETECT_CALIBRATE_TIMEOUT_MS || 420000);

// How long a FINISHED job stays readable. The panel polls every couple of
// seconds, but the owner may also close the tab, come back, and want to know how
// the run she started went — so the answer outlives the page that asked for it.
const KEEP_FINISHED_MS = 30 * 60 * 1000;

// The jobs currently known to this process, keyed by template key. In memory on
// purpose: a job IS a running child process, and a child process does not
// survive a restart, so persisting the row would only let the panel report a run
// that no longer exists as live. See `sweepStale`.
const jobs = new Map();

let seq = 0;

/**
 * Run one command to completion without blocking the event loop.
 *
 * Resolves with the spawnSync-shaped `{ status, stdout, stderr }` that
 * `templates.recipeDiffOutcome` / `calibrateOutcome` already know how to read,
 * so success and failure are judged by the same code on both paths.
 *
 * `onLine` receives each stdout line as it arrives — that is where the honest
 * progress comes from: recipe_diff.py already prints "front 4: 4 words + 1 title
 * box(es)" per card, so the panel can say which card is being measured instead
 * of guessing.
 */
function runAsync(bin, args, { cwd, timeout, onLine, spawnFn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = (spawnFn || spawn)(bin, args, {
        cwd,
        // Its own process group, so the timeout below can kill the browser
        // Chrome leaves running underneath the generator — not just the Python.
        detached: true,
      });
    } catch (e) {
      return resolve({ status: null, stdout: '', stderr: String((e && e.message) || e) });
    }
    let stdout = '';
    let stderr = '';
    let pending = '';
    let settled = false;
    let timer = null;

    const finish = (status, extraErr) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr: extraErr ? stderr + extraErr : stderr });
    };

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!onLine) return;
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) if (line.trim()) onLine(line.trim());
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    if (timeout) {
      timer = setTimeout(() => {
        // Kill the GROUP (negative pid), not the child: the generator's Chrome
        // is in it deliberately, and signalling only the Python is what left
        // orphaned browsers behind before.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
        finish(null, `\n(timed out after ${Math.round(timeout / 1000)}s and was killed)`);
      }, timeout);
      // Never hold the process open just to enforce a timeout.
      if (typeof timer.unref === 'function') timer.unref();
    }

    child.on('error', (e) => finish(null, '\n' + String((e && e.message) || e)));
    child.on('close', (code) => finish(code));
  });
}

// The Hebrew the panel shows for the stage currently running. Kept here rather
// than in the page so the words and the states can never drift apart.
const STAGE_TEXT = {
  detecting: 'מודד את מיקומי הטקסט מתוך הקבצים',
  calibrating: 'מכייל את הגופנים והצבעים',
};

// A job as the API hands it out — never the internal object, so a caller cannot
// mutate a live run, and never the raw child handle.
function snapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    key: job.key,
    state: job.state,
    stage: job.stage,
    stageText: STAGE_TEXT[job.stage] || null,
    // Real progress, not a fraction invented to fill a bar: how many of the
    // deck's fronts detection has actually reported measuring.
    fronts: job.fronts,
    frontsTotal: job.frontsTotal,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    result: job.result || null,
    error: job.error || null,
    httpStatus: job.httpStatus || null,
  };
}

// Anything a re-detection prints that tells the owner something true about where
// it has got to. Only the per-front line is a progress signal; the rest is the
// detector's own reporting and is left to the recipe.
const FRONT_LINE = /^front (\d+):/;

function noteLine(job, line) {
  job.lastLine = line;
  const m = FRONT_LINE.exec(line);
  if (m) job.fronts = Math.max(job.fronts, Number(m[1]) - 1);
}

/**
 * Start re-detecting `key`, or hand back the run already in flight for it.
 *
 * Returns `{ error, httpStatus }` for a key that does not exist — checked BEFORE
 * a job is registered, so a typo never leaves a phantom row behind — and a job
 * snapshot otherwise. Never throws, never blocks: the caller responds
 * immediately and the work continues behind it.
 */
function start({ root, key, pythonBin = 'python3', templates, runner, now = Date.now }) {
  const tpl = templates || require('./templates.js');
  const existing = jobs.get(key);
  // A second press while one is running is not an error and must NOT start a
  // second pass over the same files — two detections writing one recipe is a
  // race with no winner. The owner simply gets the run she already has.
  if (existing && existing.state === 'running') return snapshot(existing);

  const plan = tpl.redetectPlan({ root, key });
  if (plan.error) return { error: plan.error, httpStatus: plan.httpStatus || 400 };

  const job = {
    id: `redetect-${++seq}-${now()}`,
    key,
    state: 'running',
    stage: 'detecting',
    fronts: 0,
    // The eight fronts of a card deck; a sheet template reports no per-front
    // lines at all and simply never advances this, which is honest.
    frontsTotal: plan.cards ? 8 : 0,
    startedAt: now(),
    finishedAt: null,
    result: null,
    error: null,
    lastLine: null,
  };
  jobs.set(key, job);

  const run = runner || runAsync;
  const finishWith = (patch) => {
    Object.assign(job, patch, { finishedAt: Date.now(), stage: null });
  };

  (async () => {
    try {
      const rd = tpl.recipeDiffPlan({
        root,
        slug: key,
        recipeName: plan.recipeName,
        cards: plan.cards,
      });
      const rdResult = await run(pythonBin, rd.args, {
        cwd: root,
        timeout: RECIPE_TIMEOUT_MS,
        onLine: (line) => noteLine(job, line),
      });
      const recipe = tpl.recipeDiffOutcome({ root, slug: key, out: rd.out, result: rdResult });
      if (!recipe.ok) {
        return finishWith({
          state: 'error',
          error: 'detection failed: ' + (recipe.detail || 'unknown error'),
          httpStatus: 422,
        });
      }

      job.stage = 'calibrating';
      const cal = tpl.calibratePlan({ root, slug: key });
      const calResult = await run(pythonBin, cal.args, {
        cwd: root,
        timeout: CALIBRATE_TIMEOUT_MS,
      });
      const calibration = tpl.calibrateOutcome({ out: cal.out, result: calResult });
      if (calibration.ok) {
        tpl.applyCalibration(tpl.themesPathFor(root), key, calibration.blob);
      }
      finishWith({
        state: 'done',
        result: tpl.redetectReport({ key, recipe, calibration }),
      });
    } catch (e) {
      // A crash in the plumbing is still an outcome the owner must see; it must
      // never leave the job stuck on "running".
      finishWith({ state: 'error', error: String((e && e.message) || e), httpStatus: 500 });
    }
  })();

  return snapshot(job);
}

/** The current (or most recent) job for `key`, or null. */
function get(key) {
  return snapshot(jobs.get(key));
}

/**
 * Drop finished jobs nobody is going to ask about again.
 *
 * Called on every read rather than on a timer: a Map of at most one row per
 * template needs no scheduler, and a swept-on-read store cannot keep the process
 * alive the way an interval can.
 */
function sweepStale(nowMs = Date.now()) {
  for (const [key, job] of jobs) {
    if (job.state !== 'running' && nowMs - (job.finishedAt || job.startedAt) > KEEP_FINISHED_MS) {
      jobs.delete(key);
    }
  }
}

/** Forget every job — for tests, and for nothing else. */
function reset() {
  jobs.clear();
  seq = 0;
}

module.exports = {
  start,
  get,
  sweepStale,
  reset,
  runAsync,
  snapshot,
  STAGE_TEXT,
  RECIPE_TIMEOUT_MS,
  CALIBRATE_TIMEOUT_MS,
  KEEP_FINISHED_MS,
};
