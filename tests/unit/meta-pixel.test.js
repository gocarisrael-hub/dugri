// @vitest-environment node
//
// The Meta pixel is injected per request from an owner-editable setting, so the
// two things that matter are: it stays completely absent until she sets an id,
// and it never reaches a page she didn't mean to measure (an admin screen would
// put her own working sessions into the ad account's numbers).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const metaPixel = require('../../server/meta-pixel.js');
const settings = require('../../server/settings.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(__dirname, '..', '..', 'site');
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');

const ID = '1234567890123456';

describe('meta-pixel injection', () => {
  it('puts the pixel into a buyer page, initialised with the id', () => {
    const out = metaPixel.inject(read('index.html'), ID);
    expect(out).toContain(`fbq('init', '${ID}')`);
    expect(out).toContain("fbq('track', 'PageView')");
    expect(out).toContain('connect.facebook.net/en_US/fbevents.js');
    // Before </head>, so a PageView queues as early as the page allows.
    expect(out.indexOf("fbq('init'")).toBeLessThan(out.indexOf('</head>'));
  });

  it('reaches the two pages that had no measurement at all', () => {
    for (const page of ['products.html', 'pay-success.html']) {
      expect(metaPixel.inject(read(page), ID)).toContain(`fbq('init', '${ID}')`);
    }
  });

  it('reaches the campaign landing page, which is the one ads point at', () => {
    // lp.html is the destination of paid Meta traffic. A landing page the pixel
    // does not see cannot report a conversion, cannot build an audience and
    // cannot optimise a campaign — so this is the page it can least afford to
    // miss. It qualifies by carrying the GA stub, the same marker every other
    // buyer page uses; this test is here so a future edit to that <head> cannot
    // silently drop it out of measurement.
    expect(metaPixel.inject(read('lp.html'), ID)).toContain(`fbq('init', '${ID}')`);
  });

  it('leaves every page untouched when no id is set — the shipped state', () => {
    for (const page of ['index.html', 'products.html', 'pay-success.html']) {
      const html = read(page);
      expect(metaPixel.inject(html, '')).toBe(html);
      expect(metaPixel.inject(html, null)).toBe(html);
      expect(metaPixel.inject(html, undefined)).toBe(html);
    }
  });

  it('never touches an admin page, so the owner is not counted as an audience', () => {
    for (const page of ['admin.html', 'admin-analytics.html', 'dashboard.html', 'coupons.html']) {
      const html = read(page);
      expect(metaPixel.inject(html, ID)).toBe(html);
    }
  });

  it('refuses an id that is not a bare number', () => {
    const html = read('index.html');
    for (const bad of ['abc', '12', "1234'); alert(1); //", '1234567890123456 ', '<script>']) {
      expect(metaPixel.inject(html, bad)).toBe(html);
    }
  });

  it('does not load the network script on localhost', () => {
    // The loader is guarded by hostname, so dev and E2E queue events without
    // ever contacting Meta.
    expect(metaPixel.snippet(ID)).toContain("host !== 'localhost'");
  });
});

describe('the pixel id as a setting', () => {
  it('defaults to empty — off until the owner pastes one', () => {
    expect(settings.get('analytics', 'meta_pixel_id')).toBe('');
  });

  it('accepts a numeric id and an empty string, and refuses anything else', () => {
    expect(settings.validateValue('analytics', 'meta_pixel_id', ID)).toBeNull();
    expect(settings.validateValue('analytics', 'meta_pixel_id', '')).toBeNull();
    for (const bad of ['abc', '123', 'https://facebook.com/1234567890', '12345 67890']) {
      expect(settings.validateValue('analytics', 'meta_pixel_id', bad)).toBeTruthy();
    }
  });
});
