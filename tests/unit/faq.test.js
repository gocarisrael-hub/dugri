// @vitest-environment node
// server/faq.js is the SECURITY BOUNDARY for the owner-managed home-page FAQ:
// settings.set and the admin route both call validateFaq, and whatever survives
// it is served to every visitor by the unauthenticated GET /api/faq. So these
// tests are less about "does the happy path work" and more about what must NEVER
// be storable — a javascript: link, an unbounded answer, a list with no end.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { DEFAULT_FAQ, validateFaq, publicFaq, isSafeUrl, MAX_ITEMS, MAX_Q, MAX_A } = require(
  path.join(__dirname, '..', '..', 'server', 'faq.js')
);

// A minimal valid item; each test overrides only the field it is about.
const item = (over = {}) => ({
  id: 'q1',
  enabled: true,
  q: 'שאלה?',
  a: 'תשובה.',
  link_text: '',
  link_url: '',
  ...over,
});

describe('DEFAULT_FAQ — the shipped seed', () => {
  it('is itself valid (the default can never be a value the validator rejects)', () => {
    expect(validateFaq(DEFAULT_FAQ)).toBeNull();
  });

  it('carries the four questions the home page ships, all enabled', () => {
    expect(DEFAULT_FAQ).toHaveLength(4);
    expect(DEFAULT_FAQ.every((r) => r.enabled)).toBe(true);
    expect(DEFAULT_FAQ.map((r) => r.id)).toEqual([
      'what-is-it',
      'how-many-words',
      'when-delivered',
      'how-to-order',
    ]);
  });
});

describe('validateFaq — shape', () => {
  it('accepts a well-formed list', () => {
    expect(validateFaq([item(), item({ id: 'q2', enabled: false })])).toBeNull();
  });

  it('accepts an EMPTY list (the owner clearing the section)', () => {
    expect(validateFaq([])).toBeNull();
  });

  it('rejects a non-array', () => {
    for (const bad of [null, undefined, {}, 'x', 3]) {
      expect(validateFaq(bad)).toBe('faq must be an array');
    }
  });

  it('rejects a non-object entry', () => {
    expect(validateFaq(['just a string'])).toMatch(/must be an object/);
  });

  it('rejects a bad or duplicate id', () => {
    expect(validateFaq([item({ id: 'Has Caps' })])).toMatch(/id must be lowercase-kebab/);
    expect(validateFaq([item({ id: '' })])).toMatch(/id must be lowercase-kebab/);
    expect(validateFaq([item({ id: 'a'.repeat(32) })])).toMatch(/id must be lowercase-kebab/);
    expect(validateFaq([item(), item()])).toMatch(/duplicate id: q1/);
  });

  it('rejects a non-boolean enabled — "false" reads as off but is truthy to a gate', () => {
    expect(validateFaq([item({ enabled: 'false' })])).toMatch(/enabled must be a boolean/);
    expect(validateFaq([item({ enabled: 0 })])).toMatch(/enabled must be a boolean/);
  });

  it('rejects an empty or whitespace-only question / answer', () => {
    expect(validateFaq([item({ q: '' })])).toMatch(/q must be a non-empty string/);
    expect(validateFaq([item({ q: '   ' })])).toMatch(/q must be a non-empty string/);
    expect(validateFaq([item({ a: '' })])).toMatch(/a must be a non-empty string/);
    expect(validateFaq([item({ a: 42 })])).toMatch(/a must be a non-empty string/);
  });

  it('names the offending question by position', () => {
    expect(validateFaq([item(), item({ id: 'q2', q: '' })])).toMatch(/^question 2: /);
  });
});

describe('validateFaq — caps (an unauthenticated endpoint serves this)', () => {
  it('caps the number of questions', () => {
    const many = Array.from({ length: MAX_ITEMS }, (_, i) => item({ id: 'q' + i }));
    expect(validateFaq(many)).toBeNull();
    expect(validateFaq([...many, item({ id: 'one-too-many' })])).toMatch(/too many questions/);
  });

  it('caps the question length', () => {
    expect(validateFaq([item({ q: 'א'.repeat(MAX_Q) })])).toBeNull();
    expect(validateFaq([item({ q: 'א'.repeat(MAX_Q + 1) })])).toMatch(/q is too long/);
  });

  it('caps the answer length', () => {
    expect(validateFaq([item({ a: 'א'.repeat(MAX_A) })])).toBeNull();
    expect(validateFaq([item({ a: 'א'.repeat(MAX_A + 1) })])).toMatch(/a is too long/);
  });

  it('caps the link label and URL length', () => {
    expect(validateFaq([item({ link_text: 'ל'.repeat(61), link_url: '/x' })])).toMatch(
      /link_text is too long/
    );
    expect(
      validateFaq([item({ link_text: 'ok', link_url: 'https://a.co/' + 'x'.repeat(300) })])
    ).toMatch(/link_url is too long/);
  });
});

describe('validateFaq — the answer is PLAIN TEXT', () => {
  it('allows newlines in an answer (blank line = paragraph) but not in a question', () => {
    expect(validateFaq([item({ a: 'פסקה\n\nפסקה שנייה' })])).toBeNull();
    expect(validateFaq([item({ a: 'שורות\r\nעם CRLF' })])).toBeNull();
    expect(validateFaq([item({ q: 'שאלה\nבשתי שורות' })])).toMatch(/q must be a single line/);
  });

  it('rejects control characters (invisible in an admin field, meaningful downstream)', () => {
    expect(validateFaq([item({ a: 'לפני\u0000אחרי' })])).toMatch(/control characters/);
    expect(validateFaq([item({ q: 'שאלה\u001B[31m' })])).toMatch(/q must be a single line/);
  });

  it('STORES markup as-is — it is escaped at render, never interpreted', () => {
    // The validator does not strip tags: the renderer's job is to make them
    // inert. This test pins that division of labour, so a future "sanitiser"
    // here can't quietly become the only defence.
    expect(validateFaq([item({ a: '<script>alert(1)</script>' })])).toBeNull();
    expect(validateFaq([item({ q: '<img src=x onerror=alert(1)>' })])).toBeNull();
  });
});

describe('isSafeUrl / link validation — a javascript: URL must never be storable', () => {
  it('accepts https:// and same-site /paths', () => {
    expect(isSafeUrl('https://dugri.co.il/options.html')).toBe(true);
    expect(isSafeUrl('/options.html')).toBe(true);
    expect(isSafeUrl('/')).toBe(true);
  });

  it('rejects every dangerous or off-site scheme', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'java\u0000script:alert(1)', // a NUL smuggled into the scheme
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'http://dugri.co.il', // plain http downgrades the page
      '//evil.example/looks-like-a-path', // protocol-relative → off-site
      'dugri.co.il', // no scheme at all
      '',
    ]) {
      expect(isSafeUrl(bad), bad).toBe(false);
    }
  });

  it('refuses a whole list because ONE link is dangerous', () => {
    const err = validateFaq([
      item(),
      item({ id: 'q2', link_text: 'לחצו', link_url: 'javascript:alert(1)' }),
    ]);
    expect(err).toMatch(/^question 2: /);
    expect(err).toMatch(/link_url must start with https:\/\/ or \//);
  });

  it('requires the label and the URL together (a half-filled link is refused)', () => {
    expect(validateFaq([item({ link_text: 'לחצו', link_url: '' })])).toMatch(
      /must be set together/
    );
    expect(validateFaq([item({ link_text: '', link_url: '/x' })])).toMatch(/must be set together/);
    expect(validateFaq([item({ link_text: 'לחצו', link_url: '/x' })])).toBeNull();
  });

  it('rejects a non-string link field', () => {
    expect(validateFaq([item({ link_url: 5 })])).toMatch(/link_url must be a string/);
    expect(validateFaq([item({ link_text: {} })])).toMatch(/link_text must be a string/);
  });
});

describe('publicFaq — the whitelisted projection', () => {
  it('drops disabled questions and keeps the order', () => {
    const out = publicFaq([
      item({ id: 'a' }),
      item({ id: 'b', enabled: false }),
      item({ id: 'c' }),
    ]);
    expect(out.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('exposes ONLY the display fields — never an internal key that crept in', () => {
    const out = publicFaq([{ ...item(), secret_note: 'owner-only', enabled: true }]);
    expect(Object.keys(out[0]).sort()).toEqual(['a', 'id', 'link_text', 'link_url', 'q']);
    expect(JSON.stringify(out)).not.toContain('owner-only');
  });

  it('falls back to the shipped defaults when the stored value is malformed', () => {
    // A corrupt override must not blank the home page's FAQ section.
    expect(publicFaq(null)).toHaveLength(DEFAULT_FAQ.length);
    expect(publicFaq([{ id: 'broken' }])).toHaveLength(DEFAULT_FAQ.length);
  });

  it('returns an empty list for a VALID empty list (the owner cleared it)', () => {
    // Distinct from the corrupt case above: [] is a deliberate choice and is
    // passed through, so the home page hides the section.
    expect(publicFaq([])).toEqual([]);
  });
});
