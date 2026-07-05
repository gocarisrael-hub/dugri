// @vitest-environment node
// Branded HTML bodies for the customer-facing emails. Each customer builder must
// return a non-empty `html` that carries the honoree name, the CTA link and the
// hosted logo, while keeping the existing plain `text` as the fallback.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.join(__dirname, '..', '..', 'server', 'notify.js');

function loadFresh() {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

const BASE = 'https://dugri.example';
const LOGO = 'dugri-logo-email.png';

const collection = {
  id: 'col-1',
  honoree_name: 'שירה',
  owner_token: 'tok-abc',
  owner_email: 'buyer@example.com',
  design: 'קלאסי',
  color: 'ורוד',
  order: { version: 'delivery', total: 199 },
  count: 142,
};

const collectLink = `${BASE}/collect.html?c=col-1&k=tok-abc`;
// Inside the HTML body the `&` in the URL is HTML-escaped to `&amp;` (correct
// for an href attribute), so html assertions use the escaped form.
const collectLinkHtml = collectLink.replace(/&/g, '&amp;');

describe('renderEmailHtml helper', () => {
  it('produces an RTL document with the hosted logo and a rounded CTA button', () => {
    const html = loadFresh().renderEmailHtml({
      title: 'שלום',
      bodyLines: ['שורה ראשונה', '', 'שורה שנייה'],
      cta: { label: 'לחצו כאן', url: 'https://x.example/go' },
      baseUrl: BASE,
    });
    expect(html).toContain('dir="rtl"');
    // Hosted logo src is the public base + the served logo path.
    expect(html).toContain(`${BASE}/assets/${LOGO}`);
    // Rounded CTA button carrying the target URL + label.
    expect(html).toContain('border-radius:9999px');
    expect(html).toContain('https://x.example/go');
    expect(html).toContain('לחצו כאן');
    // Body lines rendered.
    expect(html).toContain('שורה ראשונה');
    expect(html).toContain('שורה שנייה');
  });

  it('escapes HTML-special characters in interpolated content', () => {
    const html = loadFresh().renderEmailHtml({
      title: 'a & b',
      bodyLines: ['<script>x</script>'],
      baseUrl: BASE,
    });
    expect(html).toContain('a &amp; b');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>x</script>');
  });

  it('falls back to the brand wordmark when no baseUrl is given (no broken img)', () => {
    const html = loadFresh().renderEmailHtml({ title: 'x', bodyLines: ['y'] });
    expect(html).not.toContain('<img');
    expect(html).toContain('דוגרי');
  });
});

describe('buildBuyerConfirmation — branded html', () => {
  it('returns a non-empty html with the name, the collect CTA link and the logo, plus plain text', () => {
    const { text, html } = loadFresh().buildBuyerConfirmation(collection, BASE);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('שירה');
    expect(html).toContain(collectLinkHtml);
    expect(html).toContain(`${BASE}/assets/${LOGO}`);
    // Plain-text fallback still present and unchanged in shape (raw link included).
    expect(text).toContain('תודה');
    expect(text).toContain(collectLink);
  });
});

describe('buildPdfReadyMessage — branded html', () => {
  it('returns html with the download CTA link, the name and the logo', () => {
    const link = `${BASE}/api/admin/collections/col-1/pdf?key=SECRET`;
    const { text, html } = loadFresh().buildPdfReadyMessage(collection, link, BASE);
    expect(html).toContain(link);
    expect(html).toContain('שירה');
    expect(html).toContain(`${BASE}/assets/${LOGO}`);
    // Plain-text fallback still carries the raw link.
    expect(text).toContain(link);
  });
});

describe('buildProductionError — branded html', () => {
  it('lists the problems, uses the owner link as the CTA and includes the logo', () => {
    const problems = ['חסרות מילים', 'שם חסר'];
    const { text, html } = loadFresh().buildProductionError(collection, BASE, problems);
    for (const p of problems) {
      expect(html).toContain(p);
      expect(text).toContain(p);
    }
    expect(html).toContain(collectLinkHtml); // owner/collect link is the CTA target
    expect(html).toContain('שירה');
    expect(html).toContain(`${BASE}/assets/${LOGO}`);
  });
});

describe('buildWordsReminder', () => {
  it('renders a subject, a Hebrew nudge body, the collect CTA link, the logo and plain text', () => {
    const { subject, text, html } = loadFresh().buildWordsReminder(collection, BASE);
    expect(subject).toBe('דוגרי · עוד לא הוספתם מילים — שירה');
    // Plain-text fallback present.
    expect(text).toContain('עוד לא קיבלנו את רשימת המילים');
    expect(text).toContain(collectLink);
    // Branded html present with name, CTA link and logo.
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('שירה');
    expect(html).toContain(collectLinkHtml);
    expect(html).toContain(`${BASE}/assets/${LOGO}`);
  });

  it('falls back to a placeholder name and omits the link without a baseUrl', () => {
    const { subject, text, html } = loadFresh().buildWordsReminder({
      owner_email: 'buyer@example.com',
    });
    expect(subject).toBe('דוגרי · עוד לא הוספתם מילים — ללא שם');
    expect(text).not.toContain('collect.html');
    expect(html).not.toContain('collect.html');
  });
});

describe('sendWordsReminder', () => {
  const RESEND = {
    RESEND_API_KEY: 're_test_key',
    NOTIFY_TO: 'owner@dugri.example',
    NOTIFY_FROM: 'Dugri <orders@dugri.example>',
  };
  function setResend(on) {
    for (const k of Object.keys(RESEND)) {
      if (on) process.env[k] = RESEND[k];
      else delete process.env[k];
    }
  }

  it('is a no-op (returns false) when Resend is unconfigured', async () => {
    setResend(false);
    await expect(loadFresh().sendWordsReminder(collection, BASE)).resolves.toBe(false);
  });

  it('skips gracefully (returns false) when the buyer has no email', async () => {
    setResend(true);
    const notify = loadFresh();
    await expect(notify.sendWordsReminder({ ...collection, owner_email: '' }, BASE)).resolves.toBe(
      false
    );
    setResend(false);
  });
});
