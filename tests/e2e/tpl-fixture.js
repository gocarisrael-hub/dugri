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
