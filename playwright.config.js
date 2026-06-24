import { defineConfig, devices } from '@playwright/test';

// E2E specs live in tests/e2e/*.spec.js and run against the Node server
// (Express serving site/ + the word-collection /api) on localhost:4321.
const PORT = 4321;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',

  use: {
    baseURL,
    trace: 'on-first-retry',
  },

  // Run spec files on all three device profiles.
  projects: [
    { name: 'Desktop Chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'iPhone 14', use: { ...devices['iPhone 14'], browserName: 'chromium' } },
    { name: 'Pixel 7', use: { ...devices['Pixel 7'] } },
  ],

  // Start the Node server (static site + /api). Data goes to a throwaway dir.
  webServer: {
    command: `node server/index.js`,
    env: { PORT: String(PORT), DATA_DIR: '.e2e-data' },
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
});
