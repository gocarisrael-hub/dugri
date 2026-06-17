import { defineConfig } from 'vitest/config';

// Unit tests for the static site's vanilla ES modules (site/js/**).
// - `jsdom` environment so module code that touches the DOM can be tested.
// - `globals: false` — tests import describe/it/expect explicitly from 'vitest'.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.js'],
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['site/js/**/*.js'],
      exclude: ['tests/**'],
    },
  },
});
