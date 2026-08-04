// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// The bug these pin took staging down and no test saw it coming.
//
// The generator spawns headless Chrome as ITS OWN child. When node's timeout
// fired it called `child.kill('SIGKILL')` on the bare python pid, which kills
// python and nothing else — Chrome was left running, reparented to PID 1 and
// never reaped. One chromium + its crashpad handler leaked per timed-out run;
// about nine hundred of them exhausted the container's cgroup PID budget
// (`PIDS current=1001 max=1000`) and every subsequent spawn failed with EAGAIN,
// so /api/preview, order generation and the press build all 500'd in ~0.2s while
// HTTP kept serving (node itself never forks).
//
// So the property under test is NOT "the request fails cleanly" — that was
// already true and green. It is "the GRANDCHILD is dead too". Each test below
// builds a real process tree (a script that backgrounds a long sleep, the stand
// -in for Chrome) and asserts the whole tree is gone.
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const { spawnGenerator, killGenerator } = require(path.join(serverDir, 'generator-proc.js'));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitGone = async (pid, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until && alive(pid)) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

const waitFor = async (fn, ms = 5000) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
};

// A "generator" that starts a "Chrome" (a long sleep) in the background, writes
// that grandchild's pid where the test can read it, and then hangs — exactly the
// shape of the real thing when Chrome never exits.
function writeHangingGenerator(dir, pidFile) {
  const script = path.join(dir, 'hanging-generator.sh');
  fs.writeFileSync(
    script,
    ['#!/bin/sh', 'sleep 120 &', `echo "$!" > "${pidFile}"`, 'wait', ''].join('\n'),
    { mode: 0o755 }
  );
  return script;
}

describe('killGenerator (the process-group kill)', () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-killgen-'));
  });
  afterAll(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('kills the whole tree, not just the process it spawned', async () => {
    const pidFile = path.join(tmp, 'grandchild.pid');
    const child = spawnGenerator('/bin/sh', [writeHangingGenerator(tmp, pidFile)]);
    const raw = await waitFor(() => {
      try {
        const v = fs.readFileSync(pidFile, 'utf8').trim();
        return v || null;
      } catch {
        return null;
      }
    });
    expect(raw, 'the fake generator never reported its grandchild').toBeTruthy();
    const grandchild = Number(raw);
    expect(alive(grandchild)).toBe(true);

    killGenerator(child);

    expect(await waitGone(child.pid)).toBe(true);
    // THE assertion. `child.kill()` alone leaves this one running forever.
    expect(
      await waitGone(grandchild),
      'the grandchild survived — this is the leak that exhausted the PID budget'
    ).toBe(true);
  });

  it('spawns detached, so the child leads a group of its own', () => {
    // Not a style preference: the negative-pid kill above only reaches Chrome
    // because the generator is a process-GROUP leader whose group Chrome
    // inherits. Drop `detached` and the kill silently degrades to the bare pid.
    const child = spawnGenerator('/bin/sh', ['-c', 'sleep 30']);
    try {
      // A detached child is its own group leader: pgid === pid.
      const pgid = Number(
        require('child_process')
          .execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' })
          .trim()
      );
      expect(pgid).toBe(child.pid);
    } finally {
      killGenerator(child);
    }
  });

  it('does not throw when the group is already gone', async () => {
    const child = spawnGenerator('/bin/sh', ['-c', 'exit 0']);
    await new Promise((r) => child.on('close', r));
    // process.kill(-pid) throws ESRCH here; a throw inside a timer callback
    // would take the server down instead of the run.
    expect(() => killGenerator(child)).not.toThrow();
    expect(() => killGenerator(child)).not.toThrow();
  });

  it('tolerates a missing/failed child instead of throwing', () => {
    expect(() => killGenerator(null)).not.toThrow();
    expect(() => killGenerator({})).not.toThrow();
    expect(killGenerator(null)).toBe(false);
  });

  it('still kills a child that was NOT spawned detached', async () => {
    // Defensive: process.kill(-pid) fails when pid is not a group leader, and
    // the fallback must not leave the child running.
    const child = require('child_process').spawn('/bin/sh', ['-c', 'sleep 30']);
    killGenerator(child);
    expect(await waitGone(child.pid)).toBe(true);
  });
});

describe('the container reaps orphans (backstop)', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', 'Dockerfile'), 'utf8');

  it('runs an init as PID 1, because node is not a reaper', () => {
    // node only waits on processes it spawned itself. As PID 1 it ADOPTS any
    // Chrome helper that outlives the generator and never reaps it, so the
    // helper stays a zombie holding a slot in the same PID budget that ran out.
    // The process-group kill is the fix; this is what catches anything that
    // dies out of order anyway.
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/sbin\/tini", "--"\]$/m);
    expect(dockerfile).toMatch(/^\s+tini\s*\\?$/m); // installed, not just invoked
    // tini must WRAP the server, not replace it — Railway still starts node.
    expect(dockerfile).toMatch(/^CMD \["node", "server\/index\.js"\]$/m);
  });
});

// End-to-end through the real route: a preview whose generator hangs must time
// out AND take its "Chrome" with it.
describe('POST /api/preview leaves nothing behind when it times out', () => {
  let server;
  let base;
  let pidFile;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-prevleak-'));
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-prevleak-data-'));
    process.env.ADMIN_KEY = 'test-admin-key';
    // Short enough to keep the test fast; the point is the timeout PATH, not the
    // number.
    process.env.PREVIEW_TIMEOUT_MS = '1200';
    pidFile = path.join(dir, 'chrome.pid');
    process.env.PYTHON = writeHangingGenerator(dir, pidFile);

    for (const f of ['db.js', 'pelecard.js', 'notify.js', 'validate.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
    const app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(() => {
    if (server) server.close();
    delete process.env.PREVIEW_TIMEOUT_MS;
  });

  it('fails the request and kills the generator AND its Chrome', async () => {
    const res = await fetch(base + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'trip comeback', name: 'OZ' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);

    // WAIT for the pid file rather than reading it straight off. The request
    // fails on a 1200ms timer, and under a loaded full-suite run the fake
    // generator has not always finished writing the file by then — reading it
    // immediately threw ENOENT and failed a test whose subject had not even been
    // exercised yet. Nothing here is being given more time to PASS: the
    // grandchild kill is still asserted below, on the same budget.
    const raw = await waitFor(() => {
      try {
        return fs.readFileSync(pidFile, 'utf8').trim() || null;
      } catch {
        return null; // not written yet
      }
    });
    expect(raw, 'the fake generator never started its "Chrome"').toBeTruthy();
    expect(
      await waitGone(Number(raw)),
      'the preview timed out but its Chrome kept running — every one of those ' +
        'permanently consumes a PID until the container is restarted'
    ).toBe(true);
  }, 20000);
});
