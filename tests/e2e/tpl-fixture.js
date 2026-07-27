import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared config for the admin-templates e2e isolation. The e2e server points
// TEMPLATE_ROOT at FIXTURE_ROOT (a throwaway copy built by global-setup.js), so
// the rename/replace tests never touch the checked-in generator/themes.json or
// resources/. Only these two templates are copied in: 'anniversary' backs the
// read-only present/missing assertions, 'bachelorette' is the mutation target.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, '..', '..');
export const FIXTURE_ROOT = path.join(REPO_ROOT, '.e2e-tpl-root');
export const FIXTURE_TEMPLATES = ['anniversary', 'bachelorette'];
// A theme key that exists ONLY in the throwaway fixture themes.json. The mutating
// tests check the live server lists it before writing anything — its presence
// PROVES the server is the test-owned one honoring TEMPLATE_ROOT=FIXTURE_ROOT and
// not a reused dev server on the real config. Its value never appears in the real
// checked-in themes.json, so a real server can never expose it.
export const FIXTURE_SENTINEL = 'e2e-fixture-sentinel-do-not-ship';

// The e2e server's DATA_DIR (see playwright.config.js) and the persistent OWNER
// TEMPLATE STORE inside it. FIXTURE_ROOT is the read-only "image" layer; every
// admin write the specs perform lands HERE instead (server/template-store.js), so
// the assertions below have to read through the same overlay the server does.
export const FIXTURE_DATA_DIR = path.join(REPO_ROOT, '.e2e-data');
export const FIXTURE_STORE = path.join(FIXTURE_DATA_DIR, 'templates');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// The MERGED themes the server sees: fixture ("shipped") under the owner store.
export function readThemes() {
  return {
    ...readJson(path.join(FIXTURE_ROOT, 'generator', 'themes.json')),
    ...readJson(path.join(FIXTURE_STORE, 'themes.json')),
  };
}

// A template's resolved asset dir: the owner store's copy when it exists, else
// the fixture's.
export function templateDirFor(slug) {
  const owned = path.join(FIXTURE_STORE, slug);
  if (fs.existsSync(owned)) return owned;
  return path.join(FIXTURE_ROOT, 'resources', 'canva', 'templates', slug);
}
