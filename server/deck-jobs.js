// Buyer-triggered deck renders, and the only two things that must never happen:
// two renders of the SAME order, and too many renders at once.
//
// WHY THIS EXISTS. Until now a deck was rendered by exactly one person — the
// owner, pressing "צור PDF", one order at a time. Closing the word list now
// renders it too, which moves the trigger from one careful human to every buyer
// who finishes her list, and they do not take turns. A deck render is one
// headless Chrome pass: ~120 processes and ~250MB for 20-50 seconds, against a
// container ceiling of 1000 processes. The measured wall is 8 concurrent runs,
// and past the ceiling the failure mode is a HANG, not an error — see the
// docstring at the top of generator/chrome.py, and the PID exhaustion recorded
// at the top of server/generator-proc.js.
//
// generator/chrome.py already caps Chrome itself at 4 slots, cross-process. That
// is the LAST line, and it is a poor place to queue: a run that loses the race
// sits inside a spawned python holding a node request open for up to four
// minutes before giving up. This module is the first line, in node, where a
// waiter costs a Map entry instead of a process.
//
// THE SHAPE. Per collection: one job, ever, at a time — a second POST joins the
// first rather than starting a second render, which is what makes a re-click or
// a reload mid-render harmless. Globally: MAX_CONCURRENT running, MAX_QUEUED
// waiting, and past THAT the answer is an honest "busy" that the caller turns
// into "we have your list, we'll message you" — never a queue that grows without
// limit and never a promise we can't keep inside the minute we advertised.
//
// Deliberately in memory. A restart loses the queue, and that is the right loss:
// the renders it was tracking died with the process, and the order is closed
// either way — the owner's "צור PDF" still produces the deck by hand. Nothing
// here is a record of anything; db.setProduction is.

// How many buyer renders may be in flight at once. TWO, not four: the four
// Chrome slots are shared with /api/preview (public, unauthenticated) and with
// the owner's own admin produce, and a buyer-facing feature must not be able to
// starve either. 0 disables the cap.
const MAX_CONCURRENT = Number(process.env.DECK_JOB_CONCURRENCY || 2);
// How many may WAIT. Four, so the worst honest wait is roughly two renders deep
// (~2 minutes) — past that "we'll message you" is truer than a spinner.
const MAX_QUEUED = Number(process.env.DECK_JOB_QUEUE || 4);
// How long a finished job stays readable, so a poll that arrives after the last
// one still learns how it ended.
const KEEP_MS = Number(process.env.DECK_JOB_KEEP_MS || 30 * 60 * 1000);

const jobs = new Map();
const queue = [];
let running = 0;

function sweep() {
  const cutoff = Date.now() - KEEP_MS;
  for (const [id, job] of jobs) {
    if ((job.state === 'done' || job.state === 'error') && job.finished_at < cutoff)
      jobs.delete(id);
  }
}

function launch(job) {
  running += 1;
  job.state = 'running';
  job.started_at = Date.now();
  Promise.resolve()
    .then(() => job.run())
    .then(() => {
      job.state = 'done';
    })
    .catch((e) => {
      job.state = 'error';
      job.error = String((e && e.message) || e).slice(0, 800);
    })
    .then(() => {
      job.finished_at = Date.now();
      running -= 1;
      sweep();
      pump();
    });
}

function pump() {
  while ((MAX_CONCURRENT <= 0 || running < MAX_CONCURRENT) && queue.length) launch(queue.shift());
}

// Start a render for `id`, or join the one already going.
//
// Returns the job record. `state` is one of:
//   'running' — this call started it, or it was already running;
//   'queued'  — at the concurrency cap, waiting its turn;
//   'busy'    — at the cap AND the queue is full. NOTHING was started and
//               nothing was recorded; the caller must say so out loud.
function start(id, run) {
  const current = jobs.get(id);
  if (current && (current.state === 'queued' || current.state === 'running')) return current;
  const atCap = MAX_CONCURRENT > 0 && running >= MAX_CONCURRENT;
  if (atCap && queue.length >= MAX_QUEUED) return { id, state: 'busy' };
  const job = {
    id,
    run,
    state: 'queued',
    queued_at: Date.now(),
    started_at: null,
    finished_at: null,
    error: null,
  };
  jobs.set(id, job);
  if (atCap) queue.push(job);
  else launch(job);
  return job;
}

// The job record for `id`, or null. Cheap on purpose — this is what the buyer's
// page polls every couple of seconds while she waits.
function get(id) {
  return jobs.get(id) || null;
}

function stats() {
  return { running, queued: queue.length, tracked: jobs.size, max: MAX_CONCURRENT };
}

// Tests only: forget everything. Never called by the server.
function reset() {
  jobs.clear();
  queue.length = 0;
  running = 0;
}

module.exports = { start, get, stats, reset, MAX_CONCURRENT, MAX_QUEUED };
