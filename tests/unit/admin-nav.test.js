// @vitest-environment node
// THE ADMIN NAV IS COPY-PASTED INTO SIXTEEN PAGES, and it had drifted.
//
// Measured before this test existed: admin-images.html could not reach the FAQ
// or the pricing page, and coupons.html, dashboard.html and design-codes.html
// could not reach the templates page. Nothing was broken — every page worked —
// you simply could not GET to some of them from where you happened to be
// standing.
//
// That is what a hand-maintained list in sixteen files does: a page added to the
// admin gets pasted into most of them, and the ones it misses are invisible
// until someone goes looking for a page that "used to be there".
//
// So the contract is one line: every admin nav lists every admin page, in the
// same order, with the same words — and only the `active` marker differs.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(__dirname, '..', '..', 'site');

const NAV_RE = /<nav class="nav" id="nav">(.*?)<\/nav>/s;
const LINK_RE = /<a data-page="([^"]+)"([^>]*)>([^<]+)<\/a>/g;

// Every page that carries the admin nav, discovered rather than listed — a new
// admin page with a pasted nav is covered the moment it lands.
const PAGES = fs
  .readdirSync(SITE)
  .filter((f) => f.endsWith('.html'))
  .filter((f) => NAV_RE.test(fs.readFileSync(path.join(SITE, f), 'utf8')));

function navOf(file) {
  const html = fs.readFileSync(path.join(SITE, file), 'utf8');
  const block = html.match(NAV_RE)[1];
  const out = [];
  let m;
  while ((m = LINK_RE.exec(block))) {
    out.push({ page: m[1], active: m[2].includes('active'), label: m[3].trim() });
  }
  return out;
}

describe('the admin nav', () => {
  it('is on every admin page (and there are enough of them to be worth this test)', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(16);
  });

  const reference = navOf(PAGES[0]).map((l) => ({ page: l.page, label: l.label }));

  it.each(PAGES)('%s lists every page, in the same order and words', (file) => {
    const nav = navOf(file).map((l) => ({ page: l.page, label: l.label }));
    expect(nav).toEqual(reference);
  });

  it.each(PAGES)('%s marks itself as the current page, and only itself', (file) => {
    const active = navOf(file).filter((l) => l.active);
    expect(active.map((l) => l.page)).toEqual([file]);
  });

  it('every page it links to actually exists', () => {
    for (const { page } of reference) {
      expect(fs.existsSync(path.join(SITE, page)), page).toBe(true);
    }
  });

  // admin-bench.html is deliberately NOT here. It is a per-TEMPLATE tool, opened
  // from the templates screen with the &tpl= parameter that makes it useful, and
  // it carries no nav of its own. It was in the list for one commit, and the row
  // it added made every admin nav a line taller — enough to push the orders
  // table's column-filter menu out of reach on a 390px phone. A global nav is a
  // fixed budget of vertical space, not a place to list everything that exists.
  it('leaves the per-template bench out of the global nav', () => {
    expect(reference.map((l) => l.page)).not.toContain('admin-bench.html');
    const tpl = fs.readFileSync(path.join(SITE, 'admin-templates.html'), 'utf8');
    // ...but it is still reachable from where it belongs.
    expect(tpl).toContain('admin-bench.html');
  });

  it('every admin page that has a nav is reachable FROM the nav', () => {
    // The failure this catches is the quiet one: a page ships, nobody adds it to
    // the list, and it exists only for whoever remembers the URL.
    const linked = new Set(reference.map((l) => l.page));
    for (const file of PAGES) expect(linked.has(file), `${file} is not in the nav`).toBe(true);
  });
});
