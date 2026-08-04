// Spawning the Python generator, and killing it WITH everything it started.
//
// The generator's real work is headless Chrome, which it spawns as its own
// child. `child.kill()` signals only the python pid, so a timeout used to leave
// Chrome running: reparented to PID 1, never reaped, one chromium plus its
// crashpad handler leaked per timed-out run. About nine hundred of those
// exhausted the container's cgroup PID budget (`PIDS current=1001 max=1000`),
// and from then on EVERY spawn on the box failed with EAGAIN — /api/preview,
// order generation and the press build all 500'd in ~0.2s while HTTP kept
// serving, because node itself never forks.
//
// The fix is one rule, applied at every generator spawn site: spawn `detached`
// so the child is a process-GROUP leader that Chrome and its helpers inherit,
// then signal the NEGATIVE pid so the whole group dies together.
// `generator/chrome.py` deliberately does NOT give Chrome its own session, for
// exactly this reason — that would put it outside the group we signal.
//
// Lives in its own module rather than inline in index.js so the group-kill can
// be tested directly against a real process tree; the bug was invisible to every
// test that only checked the route's status code.
const { spawn } = require('child_process');

// Spawn a generator run as its own process-group leader.
function spawnGenerator(python, args, opts = {}) {
  return spawn(python, args, { detached: true, ...opts });
}

// Kill a generator run and every process it started. Safe to call more than
// once, and safe to call on a run that has already exited.
function killGenerator(child, signal = 'SIGKILL') {
  if (!child || !child.pid) return false;
  try {
    // The group: python + chrome + its renderer/GPU/network/crashpad helpers.
    process.kill(-child.pid, signal);
    return true;
  } catch {
    // ESRCH — the group exited between the timer firing and this call, which is
    // the common case and not an error. EPERM/EINVAL — there is no such group
    // (the spawn failed, or `detached` was dropped somewhere); fall back to the
    // bare pid so we still kill what we can, rather than throwing inside a timer
    // callback and taking the process down.
    try {
      child.kill(signal);
      return true;
    } catch {
      return false; // already gone
    }
  }
}

module.exports = { spawnGenerator, killGenerator };
