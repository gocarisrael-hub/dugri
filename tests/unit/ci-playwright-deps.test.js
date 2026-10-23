// @vitest-environment node
// scripts/ci-playwright-deps.sh, the E2E job's guard around
// `playwright install-deps`. Its retry path only runs when an apt mirror stalls,
// which no healthy CI run exercises, so it is driven here with stub commands:
// sudo, timeout, npx, dpkg and apt-get are shell scripts on PATH that log their
// arguments, and npx exits with whatever the test scripts for each attempt.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(process.cwd(), 'scripts/ci-playwright-deps.sh');
const AZURE = 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n';

const STUBS = {
  sudo: 'exec "$@"',
  // timeout -k 15 <secs> cmd...: log the cap, run the command.
  timeout: 'echo "timeout $3" >> "$STUB_LOG"; shift 3; exec "$@"',
  // Exit with the next code from STUB_NPX_EXITS (space-separated, one per call).
  npx: [
    'n=$(grep -c "^npx" "$STUB_LOG" 2>/dev/null || true)',
    'echo "npx $*" >> "$STUB_LOG"',
    'set -- $STUB_NPX_EXITS',
    'shift "$n"',
    'exit "${1:-0}"',
  ].join('\n'),
  dpkg: 'echo "dpkg $*" >> "$STUB_LOG"',
  'apt-get': 'echo "apt-get $*" >> "$STUB_LOG"',
};

let dir;
let env;

function run(npxExits) {
  const r = spawnSync('bash', [SCRIPT], {
    env: { ...env, STUB_NPX_EXITS: npxExits },
    encoding: 'utf8',
  });
  const log = fs.readFileSync(env.STUB_LOG, 'utf8').trim().split('\n');
  return { status: r.status, out: r.stdout + r.stderr, log };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-deps-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(dir, 'mirrors.txt'), AZURE);
  env = {
    PATH: bin + ':' + process.env.PATH,
    HOME: dir,
    STUB_LOG: path.join(dir, 'log'),
    APT_MIRRORS_FILE: path.join(dir, 'mirrors.txt'),
    APT_CONF_FILE: path.join(dir, 'apt.conf'),
    APT_DEBS_DIR: path.join(dir, 'debs'),
    PW_DEPS_ATTEMPT_SECS: '240',
  };
  fs.writeFileSync(env.STUB_LOG, '');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ci-playwright-deps.sh', () => {
  it('installs once on a healthy mirror and leaves the mirror list alone', () => {
    const r = run('0');
    expect(r.status).toBe(0);
    expect(r.log.filter((l) => l.startsWith('npx'))).toEqual([
      'npx playwright install-deps chromium webkit',
    ]);
    expect(r.log).toContain('timeout 240');
    expect(r.out).not.toContain('::warning::');
    expect(fs.readFileSync(env.APT_MIRRORS_FILE, 'utf8')).toBe(AZURE);
  });

  it('points apt at the cached directory and keeps what it downloads', () => {
    run('0');
    const conf = fs.readFileSync(env.APT_CONF_FILE, 'utf8');
    expect(conf).toContain(`Dir::Cache::Archives "${env.APT_DEBS_DIR}/";`);
    expect(conf).toContain('APT::Keep-Downloaded-Packages "true";');
    expect(fs.statSync(path.join(env.APT_DEBS_DIR, 'partial')).isDirectory()).toBe(true);
  });

  it('retries a stalled attempt once, off the Azure mirror, after repairing dpkg', () => {
    // 124 is what GNU timeout exits with when it fires.
    const r = run('124 0');
    expect(r.status).toBe(0);
    expect(r.log.filter((l) => l.startsWith('npx'))).toHaveLength(2);
    expect(r.out).toContain('::warning::playwright install-deps attempt 1 failed');
    expect(r.out).not.toContain('::error::');
    expect(fs.readFileSync(env.APT_MIRRORS_FILE, 'utf8')).toBe(
      'http://archive.ubuntu.com/ubuntu/\tpriority:1\n'
    );
    // dpkg is repaired between the attempts, not after.
    const dpkg = r.log.indexOf('dpkg --configure -a');
    const npx = r.log.map((l, i) => (l.startsWith('npx') ? i : -1)).filter((i) => i >= 0);
    expect(dpkg).toBeGreaterThan(npx[0]);
    expect(dpkg).toBeLessThan(npx[1]);
  });

  it('caps the first attempt separately when asked', () => {
    env.PW_DEPS_FIRST_ATTEMPT_SECS = '2';
    const r = run('124 0');
    expect(r.log.filter((l) => l.startsWith('timeout'))).toEqual(['timeout 2', 'timeout 240']);
  });

  it('fails the step with an error after two failed attempts, and tries no third', () => {
    const r = run('124 124 0');
    expect(r.status).toBe(1);
    expect(r.log.filter((l) => l.startsWith('npx'))).toHaveLength(2);
    expect(r.out).toContain('::error::playwright install-deps failed twice');
  });
});

describe('the E2E job runs it', () => {
  const ci = fs.readFileSync(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  const e2e = ci.slice(ci.indexOf('\n  e2e:'), ci.indexOf('\n  python:'));

  it('as its own capped step, after the .deb cache is restored and before the tests', () => {
    const cache = e2e.indexOf('path: ~/apt-debs');
    const step = e2e.indexOf('run: scripts/ci-playwright-deps.sh');
    const tests = e2e.indexOf('npx playwright test');
    expect(cache).toBeGreaterThan(0);
    expect(step).toBeGreaterThan(cache);
    expect(tests).toBeGreaterThan(step);
    const stepBlock = e2e.slice(e2e.lastIndexOf('- name:', step), step);
    const cap = Number(/timeout-minutes: (\d+)/.exec(stepBlock)?.[1]);
    // Above the script's two 4-minute attempts, well under the job's 20.
    expect(cap).toBeGreaterThan(8);
    expect(cap).toBeLessThanOrEqual(10);
  });

  it('and nothing else in the job calls install-deps unguarded', () => {
    expect(e2e).not.toMatch(/playwright install-deps/);
  });

  it('with the script executable, as the step runs it by path', () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});
