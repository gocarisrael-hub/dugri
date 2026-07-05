// Flat ESLint config for the static site.
// Two passes: browser ES modules (site/js/** + e2e/unit tests) and Node config files.
// Globals are declared inline to avoid an extra `globals` dependency.

const browserGlobals = {
  document: 'readonly',
  window: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  console: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  alert: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  getComputedStyle: 'readonly',
  gtag: 'readonly',
  dataLayer: 'readonly',
  FileReader: 'readonly',
  // vitest/jsdom unit tests run with Node's `global`/`process`/`Buffer` too.
  global: 'writable',
  process: 'readonly',
  Buffer: 'readonly',
};

const nodeGlobals = {
  process: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'writable',
  require: 'readonly',
  exports: 'writable',
  global: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

const commonRules = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-undef': 'error',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-constant-condition': ['error', { checkLoops: false }],
};

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'test-results/**', 'playwright-report/**'],
  },
  // Browser ES modules: the site's JS plus the test files (which use browser/Playwright APIs).
  {
    files: ['site/js/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: commonRules,
  },
  // Node config files at the repo root.
  {
    files: ['*.config.js', 'eslint.config.js', 'vitest.config.js', 'playwright.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: commonRules,
  },
];
