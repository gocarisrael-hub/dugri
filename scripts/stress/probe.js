// Container-side sampler: memory + process count inside the running Railway
// container, sampled WHILE a generation is in flight.
//
// WHY: the leading hypothesis for "it fails a lot with real orders" is resource
// exhaustion, and neither of the two limits that could bite is visible from
// outside. One generation was measured at ~113 PIDs against a cgroup ceiling of
// 1000, and Chrome sizes its process pool off nproc (48 on this host) — so the
// ceiling is reachable with a single-digit number of concurrent renders. A
// results table without PIDs/memory cannot tell "the template is broken" apart
// from "the box ran out of room".
//
// Implementation: ONE long-lived `railway ssh` child running a shell loop, not a
// railway invocation per sample (each connect costs seconds, which would alias
// away the very spike we are hunting). Every failure degrades to "no samples"
// rather than failing the run — the harness must still produce a results table
// on a machine with no Railway CLI.

import { spawn } from 'node:child_process';

const CGROUP_MEM = '/sys/fs/cgroup/memory.current';
const CGROUP_PIDS = '/sys/fs/cgroup/pids.current';

// One sample per second. `ps -eo pid=` counts every process in the container's
// PID namespace, which is exactly what pids.current caps.
const REMOTE_LOOP =
  'while :; do ' +
  `echo "S $(date +%s) $(cat ${CGROUP_MEM} 2>/dev/null || echo 0) ` +
  `$(cat ${CGROUP_PIDS} 2>/dev/null || echo 0) $(ps -eo pid= | wc -l)"; ` +
  'sleep 1; done';

class Probe {
  constructor({ environment, service, project, enabled = true }) {
    this.environment = environment;
    this.service = service;
    // The Railway CLI resolves the project from the CWD's link file. A git
    // WORKTREE is not the linked checkout, so an explicit project id is what
    // lets the harness run from anywhere (including CI) instead of only from
    // the one directory that happens to be linked.
    this.project = project || null;
    this.enabled = enabled;
    this.samples = []; // { t (ms epoch), memBytes, pids, procs }
    this.child = null;
    this.error = null;
  }

  start() {
    if (!this.enabled) return this;
    try {
      const argv = ['ssh', '--environment', this.environment, '--service', this.service];
      if (this.project) argv.push('--project', this.project);
      argv.push(`sh -c '${REMOTE_LOOP}'`);
      this.child = spawn('railway', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.error = String((e && e.message) || e);
      return this;
    }
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = /^S (\d+) (\d+) (\d+) (\d+)/.exec(line.trim());
        if (!m) continue;
        this.samples.push({
          t: Number(m[1]) * 1000,
          memBytes: Number(m[2]),
          pids: Number(m[3]),
          procs: Number(m[4]),
        });
      }
    });
    this.child.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) this.error = s.slice(0, 300);
    });
    this.child.on('error', (e) => {
      this.error = String((e && e.message) || e);
    });
    return this;
  }

  // Peak memory / PIDs observed in [from, to] (ms epoch). Null when the window
  // caught no samples — never 0, which would read as "used nothing".
  window(from, to) {
    const inWin = this.samples.filter((s) => s.t >= from - 1500 && s.t <= to + 1500);
    if (!inWin.length) return { peakMemMb: null, peakPids: null, peakProcs: null, samples: 0 };
    return {
      peakMemMb: Math.round(Math.max(...inWin.map((s) => s.memBytes)) / 1048576),
      peakPids: Math.max(...inWin.map((s) => s.pids)),
      peakProcs: Math.max(...inWin.map((s) => s.procs)),
      samples: inWin.length,
    };
  }

  stop() {
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      this.child = null;
    }
  }
}

export { Probe };
