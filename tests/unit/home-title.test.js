// @vitest-environment node
// The homepage title is what Google shows as the search result headline, and
// og:title is what WhatsApp/Instagram show on a shared link. The owner chose
// "המתנה הכי אישית" (the gift), not "המשחק הכי אישי" (the game). Neither tag
// carries data-edit, so the admin content editor cannot override them: the
// shipped HTML is the live value.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(ROOT, 'site/index.html'), 'utf8');
const doc = new JSDOM(html).window.document;

const TITLE = 'דוגרי - המתנה הכי אישית שתעניקו אי פעם';

describe('homepage title', () => {
  it('<title> is the gift headline', () => {
    expect(doc.querySelectorAll('title')).toHaveLength(1);
    expect(doc.title).toBe(TITLE);
  });

  it('og:title matches <title>', () => {
    const og = doc.querySelectorAll('meta[property="og:title"]');
    expect(og).toHaveLength(1);
    expect(og[0].getAttribute('content')).toBe(TITLE);
  });

  it('the old game headline is gone', () => {
    expect(html).not.toContain('המשחק הכי אישי');
  });

  it('the live smoke marker for / is still on the page', () => {
    // scripts/smoke.mjs fails a staging deploy when its marker for / is missing;
    // it used to point at the old title.
    const smoke = fs.readFileSync(path.join(ROOT, 'scripts/smoke.mjs'), 'utf8');
    const m = smoke.match(/\{ path: '\/', marker: '([^']+)' \}/);
    expect(m).not.toBeNull();
    expect(html).toContain(m[1]);
  });
});
