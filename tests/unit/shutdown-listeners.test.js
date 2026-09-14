// @vitest-environment node
//
// The unit tests reload the app by purging require.cache and requiring
// server/index.js again. Each load used to add ANOTHER SIGTERM / SIGINT / exit
// listener (server/routes/platform.js), so a file that reloads the app a dozen
// times ended in a MaxListenersExceededWarning and ran the shutdown flush once per
// load. A reload must replace the previous app's listeners, not stack on them.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const SIGNALS = ['SIGTERM', 'SIGINT', 'exit'];

function loadApp() {
  for (const f of Object.keys(require.cache)) {
    if (f.startsWith(serverDir + path.sep) && !f.includes(path.sep + 'node_modules' + path.sep)) {
      delete require.cache[f];
    }
  }
  return require(path.join(serverDir, 'index.js'));
}

const counts = () => Object.fromEntries(SIGNALS.map((s) => [s, process.listenerCount(s)]));

beforeAll(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-shutdown-listeners-'));
});

describe('shutdown listeners', () => {
  it('reloading the app does not stack SIGTERM / SIGINT / exit listeners', () => {
    const before = counts();
    loadApp();
    const once = counts();
    // The app does listen: a deploy's SIGTERM must still flush the ad ledger.
    for (const s of SIGNALS) expect(once[s]).toBe(before[s] + 1);
    for (let i = 0; i < 5; i++) loadApp();
    expect(counts()).toEqual(once);
  });
});
