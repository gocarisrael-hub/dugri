// Flat ESLint config for the static site.
// Three passes: browser ES modules (site/js/** + e2e/unit tests), the CommonJS
// backend (server/**), and Node config files.
// Globals are declared inline to avoid an extra `globals` dependency.

const browserGlobals = {
  document: 'readonly',
  window: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
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
  AbortController: 'readonly',
  FormData: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  // js/admin-role.js watches the admin tiles so a money figure the orders page
  // redraws on its poll cannot creep back in for a staff key.
  MutationObserver: 'readonly',
  // Synthesised by the e2e specs that drive the product page's pinch zoom.
  Touch: 'readonly',
  TouchEvent: 'readonly',
  getComputedStyle: 'readonly',
  gtag: 'readonly',
  dataLayer: 'readonly',
  FileReader: 'readonly',
  // The pawn-photo background cut decodes the buyer's file to a canvas.
  createImageBitmap: 'readonly',
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
  // The backend (CommonJS). Until now server/** matched NO config block, so the
  // whole backend went unlinted — and a duplicate object key merged to main
  // unnoticed (two `board_file` entries in one setProduction literal, the second
  // silently winning). These are the "this is a mistake, not a style opinion"
  // rules; the pass is clean today, so a new error here means a real defect.
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...nodeGlobals,
        // Web APIs Node ships as globals and the backend actually uses.
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        structuredClone: 'readonly',
        queueMicrotask: 'readonly',
      },
    },
    rules: {
      ...commonRules,
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-unreachable': 'error',
    },
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
