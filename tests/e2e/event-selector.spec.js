import { test, expect } from '@playwright/test';

// Homepage event selector: clicking an event pill swaps the product mockup,
// accent, swatches and CTA IN PLACE — no navigation. This exercises the
// #events section contract that event-selector.js wires up.

test.describe('homepage event selector', () => {
  test('clicking a pill swaps the mockup + CTA in place without navigating', async ({ page }) => {
    await page.goto('/index.html');

    const section = page.locator('#events');
    await expect(section).toBeVisible();

    const cta = page.locator('#eventCta');
    const mockup = page.locator('#eventMockup');

    const urlBefore = page.url();
    const hrefBefore = await cta.getAttribute('href');
    const srcBefore = await mockup.getAttribute('src');

    // Click the bachelorette pill.
    const pill = page.locator('.event-pill[data-design-id="bachelorette"]');
    await pill.click();

    // CTA now deep-links to the bachelorette design.
    await expect(cta).toHaveAttribute('href', /design=bachelorette/);

    // Mockup image changed.
    await expect.poll(async () => await mockup.getAttribute('src')).not.toBe(srcBefore);

    // The clicked pill is the selected/active one.
    await expect(pill).toHaveAttribute('aria-selected', 'true');
    await expect(pill).toHaveClass(/is-active/);

    // No navigation happened — same page URL.
    expect(page.url()).toBe(urlBefore);
    expect(hrefBefore).not.toBeNull();

    // The section exposes a non-empty accent colour via --event-accent.
    const accent = await section.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--event-accent').trim()
    );
    expect(accent.length).toBeGreaterThan(0);
    expect(/^(#|rgb)/.test(accent)).toBe(true);
  });
});
