import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, FIXTURE_ROOT } from './tpl-fixture.js';

// A directly opened template SVG is served with a sandbox CSP (no script, images only
// from data: or our own origin). That must not cost a card its artwork. The case that
// proves it is a DE-DUPLICATED card: its background is a "../assets/<sha>.png"
// reference the server rewrites to /api/template-asset/…, which an `img-src data:`
// policy blocked. `grapefruit` is the repo's de-duplicated template; the e2e fixture
// (rebuilt from scratch by global-setup.js on every run) ships only anniversary and
// bachelorette, so this spec stages grapefruit's first front and the one background
// it references into that throwaway fixture root before opening it.
const SLUG = 'grapefruit';
const SRC_DIR = path.join(REPO_ROOT, 'resources', 'canva', 'templates', SLUG);
const DST_DIR = path.join(FIXTURE_ROOT, 'resources', 'canva', 'templates', SLUG);
const FRONT = path.join('filled', '2.svg'); // the slot the server maps "front" to

// Atomic copy: both device projects may stage at once, and the server must never read
// a half-written file.
function stage(rel) {
  const dst = path.join(DST_DIR, rel);
  if (fs.existsSync(dst)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.copyFileSync(path.join(SRC_DIR, rel), tmp);
  fs.renameSync(tmp, dst);
}

test.beforeAll(() => {
  stage(FRONT);
  const svg = fs.readFileSync(path.join(SRC_DIR, FRONT), 'utf8');
  const refs = [...new Set(svg.match(/\.\.\/assets\/[A-Za-z0-9._-]+/g) || [])];
  // Guard the premise: if grapefruit stops being de-duplicated, this spec proves
  // nothing and must say so.
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) stage(path.join('assets', path.basename(ref)));
});

test('a de-duplicated card opened directly keeps its background under the sandbox CSP', async ({
  page,
}) => {
  const assetResponse = page.waitForResponse((r) =>
    r.url().includes(`/api/template-asset/${SLUG}/`)
  );
  const res = await page.goto(`/api/template-image/${SLUG}/front`);
  expect(res.status()).toBe(200);

  const h = res.headers();
  expect(h['content-type']).toContain('image/svg+xml');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['content-security-policy']).toBe(
    "default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; font-src data:; sandbox"
  );

  // The background really loaded. A CSP-blocked image is never requested at all, so
  // a completed 200 for the rewritten asset URL is the proof the policy let it
  // through; the body is the actual PNG, not an error page.
  const asset = await assetResponse;
  expect(asset.status()).toBe(200);
  expect(asset.headers()['content-type']).toContain('image/png');
  const body = await asset.body();
  expect(body.length).toBeGreaterThan(1000);
  expect(body.subarray(1, 4).toString('latin1')).toBe('PNG');
});
