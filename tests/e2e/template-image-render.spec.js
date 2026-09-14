import { test, expect } from '@playwright/test';

// The direct-open view of a template SVG is HARDENED (a `… sandbox` CSP + nosniff,
// added because a directly opened SVG runs on the site's origin), but real card
// art must STILL render under that policy. `bachelorette` is one of the two
// templates the e2e fixture ships with full artwork (tests/e2e/tpl-fixture.js), and
// its filled fronts are pure vector — nothing an `img-src data:` policy could block
// — so it is the honest "does it still draw" probe.
test.describe('template image — sandboxed but still renders', () => {
  test('bachelorette front carries the sandbox headers and draws as SVG', async ({ page }) => {
    const res = await page.goto('/api/template-image/bachelorette/front');
    expect(res.status()).toBe(200);

    const h = res.headers();
    expect(h['content-type']).toContain('image/svg+xml');
    expect(h['x-content-type-options']).toBe('nosniff');
    const csp = h['content-security-policy'] || '';
    expect(csp).toContain('sandbox');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('img-src data:');

    // It parsed as an SVG document and drew real shapes (not a blank/parser-error
    // page). Read the DOM the browser actually built.
    const shape = await page.evaluate(() => {
      const root = document.documentElement;
      if (!root || root.tagName.toLowerCase() !== 'svg') return { ok: false, n: 0 };
      const n = root.querySelectorAll('path, rect, g, use, image, polygon').length;
      return { ok: true, n };
    });
    expect(shape.ok).toBe(true);
    expect(shape.n).toBeGreaterThan(0);
  });
});
