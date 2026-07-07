import { test, expect } from '@playwright/test';

// "Add to Home Screen" needs a real icon, not a page screenshot: iOS reads
// <link rel="apple-touch-icon">, Android/Chrome reads the web app manifest and
// its icons. This guards that both are wired on the public pages and that every
// referenced icon (plus the manifest itself) actually loads.

const PUBLIC_PAGES = ['/index.html', '/products.html', '/product.html?design=bachelorette'];

test.describe('home-screen / PWA icons', () => {
  for (const path of PUBLIC_PAGES) {
    test(`${path} links an apple-touch-icon, a manifest and a theme-color`, async ({ page }) => {
      await page.goto(path);

      // iOS home-screen icon.
      await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
        'href',
        '/assets/icons/apple-touch-icon.png'
      );
      // Android/Chrome install manifest.
      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
        'href',
        '/manifest.webmanifest'
      );
      // Brand chrome colour for the standalone shell.
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ffffff');
    });
  }

  test('the apple-touch-icon file is served (200) as a PNG', async ({ request }) => {
    const res = await request.get('/assets/icons/apple-touch-icon.png');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
  });

  test('the manifest is valid JSON with a name and icons that all load (200)', async ({
    request,
  }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.status()).toBe(200);

    const manifest = JSON.parse(await res.text());
    expect(manifest.name).toBeTruthy();
    expect(manifest.display).toBe('standalone');
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

    // A maskable icon must exist so Android doesn't letterbox the icon.
    expect(manifest.icons.some((i) => (i.purpose || '').includes('maskable'))).toBe(true);

    // Every icon the manifest points at must actually be served.
    for (const icon of manifest.icons) {
      const iconRes = await request.get(icon.src);
      expect(iconRes.status(), `${icon.src} should load`).toBe(200);
      expect(iconRes.headers()['content-type']).toContain('image/png');
    }
  });
});
