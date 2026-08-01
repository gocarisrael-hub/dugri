import { createHash } from 'node:crypto';
import { REPO_ROOT } from './tpl-fixture.js';

// WHERE the e2e server lives — shared by playwright.config.js (which starts it)
// and global-setup.js (which verifies the thing answering there is ours).
//
// The port is DERIVED FROM THIS CHECKOUT'S ABSOLUTE PATH rather than fixed. With
// one hardcoded port, a server left running in a SIBLING WORKTREE owns it, and
// `reuseExistingServer` (on locally) hands the whole run to that foreign
// checkout: the specs then exercise someone else's site/ and server/ and report
// green, which is worse than failing. A path-derived port gives every worktree
// its own, so parallel agents can run E2E at the same time and each tests its own
// code. It stays STABLE for a given checkout, so a server left running from the
// previous run in THIS worktree is still reused (the fast local path).
//
// Set E2E_PORT to override (a locked-down CI runner, or debugging two runs of the
// same checkout side by side).
export const E2E_PORT = Number(process.env.E2E_PORT) || derivedPort();
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

// 20000–39999: above the ephemeral-adjacent low ports and clear of the usual dev
// servers (3000/4321/5173/8080), so the derived port doesn't land on one.
function derivedPort() {
  const digest = createHash('sha1').update(REPO_ROOT).digest('hex').slice(0, 8);
  return 20000 + (parseInt(digest, 16) % 20000);
}
