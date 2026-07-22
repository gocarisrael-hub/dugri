import { defineConfig, devices } from '@playwright/test';
import { FIXTURE_ROOT } from './tests/e2e/tpl-fixture.js';

// E2E specs live in tests/e2e/*.spec.js and run against the Node server
// (Express serving site/ + the word-collection /api) on localhost:4321.
const PORT = 4321;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  // Retry a failed test twice ON CI ONLY. The whole suite hits ONE Node server on
  // one port, so at full worker parallelism a busy runner occasionally starves a
  // request and a test hits the 30s timeout — a DIFFERENT test each run, the
  // signature of load contention rather than a real defect (these all pass in
  // isolation). Retries run after the initial batch drains, when contention has
  // eased, so a load-flake goes green while a genuine failure still fails all
  // three attempts (nothing is masked). Locally retries stay 0 for fast feedback.
  // `trace: 'on-first-retry'` (below) captures a trace when a retry happens.
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  // Builds .e2e-tpl-root (a throwaway copy of the template config + a couple of
  // template dirs) so the admin-templates rename/replace tests never touch the
  // checked-in generator/themes.json or resources/ (see tests/e2e/global-setup.js).
  globalSetup: './tests/e2e/global-setup.js',

  use: {
    baseURL,
    trace: 'on-first-retry',
  },

  // Run spec files on two device profiles: a desktop and a phone. These are the
  // only profiles with device-gated specs (mobile-only checks run on iPhone 14;
  // several layout/measurement specs are Desktop-Chrome-only), so together they
  // exercise every merge-gating test. Pixel 7 was dropped — it was a redundant
  // chromium-mobile profile with no unique specs, so it only added CI minutes.
  projects: [
    { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'iPhone 14', use: { ...devices['iPhone 14'], browserName: 'chromium' } },
  ],

  // Start the Node server (static site + /api). Data goes to a throwaway dir, and
  // the admin template routes are pointed at the throwaway .e2e-tpl-root so the
  // rename/replace tests never mutate the checked-in template config.
  webServer: {
    command: `node server/index.js`,
    env: {
      PORT: String(PORT),
      DATA_DIR: '.e2e-data',
      ADMIN_KEY: 'dugri-admin',
      TEMPLATE_ROOT: FIXTURE_ROOT,
    },
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
});
