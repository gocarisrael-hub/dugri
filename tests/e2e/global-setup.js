import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, FIXTURE_ROOT, FIXTURE_TEMPLATES, FIXTURE_SENTINEL } from './tpl-fixture.js';

// Build a fresh THROWAWAY template root for the admin-templates e2e: a copy of
// generator/themes.json plus the handful of template dirs the spec inspects and
// mutates. The e2e server uses this via TEMPLATE_ROOT, so rename/replace operate
// on the copy — the checked-in config and resources are never modified, and an
// interrupted run can only dirty the gitignored .e2e-tpl-root.
//
// A fixture-only SENTINEL theme is injected so the mutating tests can PROVE they
// are hitting this throwaway root (and not a reused dev server on the real
// config) before they write anything.
export default function globalSetup() {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIXTURE_ROOT, 'generator'), { recursive: true });
  const tplBase = path.join(FIXTURE_ROOT, 'resources', 'canva', 'templates');
  fs.mkdirSync(tplBase, { recursive: true });

  const themes = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'generator', 'themes.json'), 'utf8')
  );
  themes[FIXTURE_SENTINEL] = {
    slug: FIXTURE_SENTINEL,
    display_he: 'סנטינל (בדיקות בלבד)',
    dir: 'resources/canva/templates/' + FIXTURE_SENTINEL,
    calibrated: false,
    visibility: 'private',
  };
  fs.writeFileSync(
    path.join(FIXTURE_ROOT, 'generator', 'themes.json'),
    JSON.stringify(themes, null, 1) + '\n',
    'utf8'
  );

  for (const t of FIXTURE_TEMPLATES) {
    fs.cpSync(path.join(REPO_ROOT, 'resources', 'canva', 'templates', t), path.join(tplBase, t), {
      recursive: true,
    });
  }
}
