import { defineConfig, devices } from '@playwright/test';

// E2E specs live in tests/e2e/*.spec.js and run against the static site,
// which is served from the `site/` folder on localhost:4321.
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

  // Serve the static site/ folder. Reuse an already-running server if present.
  webServer: {
    command: `npx serve site -l ${PORT}`,
    port: PORT,
    reuseExistingServer: true,
  },
});
