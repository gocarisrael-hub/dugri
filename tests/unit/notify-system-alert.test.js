// @vitest-environment node
// notify.sendSystemAlert — the owner "operational escalation" email (used by the
// WhatsApp paid-order hook when a buyer can't be added or DM'd). Pure builder is
// asserted directly; the send stays DORMANT (returns false, no fetch) with Resend
// unconfigured, like every other notify send.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const notifyPath = path.join(__dirname, '..', '..', 'server', 'notify.js');

function loadFresh() {
  delete require.cache[require.resolve(notifyPath)];
  return require(notifyPath);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildSystemAlert', () => {
  it('prefixes the subject and joins the body lines', () => {
    const notify = loadFresh();
    const msg = notify.buildSystemAlert('צריך צירוף ידני', ['שורה 1', 'שורה 2']);
    expect(msg.subject).toBe('דוגרי · צריך צירוף ידני');
    expect(msg.text).toBe('שורה 1\nשורה 2');
  });

  it('accepts a single string body and falls back to a default subject', () => {
    const notify = loadFresh();
    const msg = notify.buildSystemAlert('', 'הודעה');
    expect(msg.subject).toBe('דוגרי · התראת מערכת');
    expect(msg.text).toBe('הודעה');
  });
});

describe('sendSystemAlert', () => {
  it('is a no-op (returns false, no network) when Resend is unconfigured', async () => {
    for (const k of ['RESEND_API_KEY', 'NOTIFY_TO', 'NOTIFY_FROM']) delete process.env[k];
    const notify = loadFresh();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const ok = await notify.sendSystemAlert('x', ['y']);
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
