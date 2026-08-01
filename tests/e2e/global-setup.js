import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  REPO_ROOT,
  FIXTURE_ROOT,
  FIXTURE_TEMPLATES,
  FIXTURE_SENTINEL,
  FIXTURE_STORE,
} from './tpl-fixture.js';
import { E2E_PORT, E2E_BASE_URL } from './server-target.js';

// A token minted fresh each run and stamped onto the fixture-only sentinel theme,
// which the admin templates API re-reads from disk on every request. It is how
// assertOurServer (below) tells THIS checkout's server from any other: a sibling
// worktree's server reads ITS OWN fixture root and so reports a different token,
// while a server left running from an earlier run of THIS checkout re-reads the
// file we just wrote and reports the current one.
const RUN_TOKEN = randomUUID();
const ADMIN_KEY = 'dugri-admin'; // matches webServer.env in playwright.config.js
const PROBE_TIMEOUT_MS = 5000;

// Build a fresh THROWAWAY template root for the admin-templates e2e: a copy of
// generator/themes.json plus the handful of template dirs the spec inspects and
// mutates. The e2e server uses this via TEMPLATE_ROOT, so rename/replace operate
// on the copy — the checked-in config and resources are never modified, and an
// interrupted run can only dirty the gitignored .e2e-tpl-root.
//
// A fixture-only SENTINEL theme is injected so the mutating tests can PROVE they
// are hitting this throwaway root (and not a reused dev server on the real
// config) before they write anything.
export default async function globalSetup() {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  // The admin routes WRITE to the persistent owner store under DATA_DIR, not into
  // the fixture (server/template-store.js). Wipe it too, so a previous run's
  // renames/calibrations can't shadow the freshly-built fixture.
  fs.rmSync(FIXTURE_STORE, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIXTURE_ROOT, 'generator'), { recursive: true });
  const tplBase = path.join(FIXTURE_ROOT, 'resources', 'canva', 'templates');
  fs.mkdirSync(tplBase, { recursive: true });

  const themes = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'generator', 'themes.json'), 'utf8')
  );
  themes[FIXTURE_SENTINEL] = {
    slug: FIXTURE_SENTINEL,
    // The run token rides in the display label because that is a field the admin
    // templates API passes straight through — nothing asserts on this text (the
    // specs match the sentinel by KEY), so it is free to carry the marker.
    display_he: 'סנטינל (בדיקות בלבד) · ' + RUN_TOKEN,
    dir: 'resources/canva/templates/' + FIXTURE_SENTINEL,
    calibrated: false,
    visibility: 'private',
  };
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, 'generator', 'themes.json'),
    JSON.stringify(themes, null, 1) + '\n',
    'utf8'
  );

  for (const t of FIXTURE_TEMPLATES) {
    fs.cpSync(path.join(REPO_ROOT, 'resources', 'canva', 'templates', t), path.join(tplBase, t), {
      recursive: true,
    });
  }

  await assertOurServer();
}

// Refuse to run against a server that is not this checkout's.
//
// Locally Playwright reuses whatever already answers on the port
// (reuseExistingServer: !CI). The port is now derived per checkout, so a sibling
// worktree normally can't collide — but an unrelated process, a hash collision or
// a hand-set E2E_PORT still can, and the failure mode is the worst kind: the whole
// suite exercises SOMEONE ELSE'S code and reports green. Worse, the template
// specs' own sentinel guard SKIPS in that situation, so the run looks clean.
//
// So: whoever answers must report this run's token. Nothing listening yet is
// fine — Playwright starts its own server (this runs either side of that, and the
// probe treats "connection refused" as an empty port either way).
async function assertOurServer() {
  const url = `${E2E_BASE_URL}/api/admin/templates?key=${ADMIN_KEY}`;
  // Abort a stalled probe rather than hanging the run before it starts (same
  // AbortController + timer shape the server's outbound calls use).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let body;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return; // something else entirely — webServer will fail loudly
    body = await res.json();
  } catch {
    return; // nothing listening (or not answering as our API) — nothing to reuse
  } finally {
    clearTimeout(timer);
  }
  if (servesRunToken(body, RUN_TOKEN)) return; // ours

  throw new Error(
    `E2E port ${E2E_PORT} is already serving a DIFFERENT checkout (its template ` +
      `config is not the one this run just built). Refusing to run: the suite would ` +
      `test that checkout's code and report green.\n` +
      `Kill that server, or run with a private port: E2E_PORT=<free port> npx playwright test`
  );
}

// Does an /api/admin/templates response come from the server this run just built
// the fixture for? True only when the fixture-only sentinel is listed AND carries
// this run's token — a foreign checkout has its own sentinel with its own token,
// and a server on a real TEMPLATE_ROOT has no sentinel at all. Exported for the
// unit test; the failure it guards can't be reproduced from inside a normal run.
export function servesRunToken(body, token) {
  const list = (body && body.templates) || [];
  const sentinel = list.find((t) => t && t.key === FIXTURE_SENTINEL);
  return !!sentinel && String(sentinel.display_he || '').includes(token);
}
