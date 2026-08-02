// @vitest-environment node
// The E2E harness's own safety rails. Both exist to stop a run from silently
// testing the WRONG server — a failure that reports green, so it can't be caught
// by the suite it breaks. Neither is reachable from inside a normal Playwright
// run (one picks the port before any test exists, the other only fires when a
// foreign server holds the port), which is exactly why they are unit-tested here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { servesRunToken } from '../e2e/global-setup.js';
import { FIXTURE_SENTINEL } from '../e2e/tpl-fixture.js';

const OUR_TOKEN = '11111111-2222-3333-4444-555555555555';
const THEIR_TOKEN = '99999999-8888-7777-6666-555555555555';
const sentinel = (token) => ({
  key: FIXTURE_SENTINEL,
  display_he: 'סנטינל (בדיקות בלבד) · ' + token,
});

describe('e2e port derivation', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.E2E_PORT;
  });
  afterEach(() => {
    delete process.env.E2E_PORT;
  });

  it('derives a port in the private range and keeps it stable for this checkout', async () => {
    const a = await import('../e2e/server-target.js?a');
    vi.resetModules();
    const b = await import('../e2e/server-target.js?b');
    // Stable: a server left running from the previous run in THIS worktree is
    // still reusable. Were it random, every run would strand its predecessor.
    expect(a.E2E_PORT).toBe(b.E2E_PORT);
    expect(Number.isInteger(a.E2E_PORT)).toBe(true);
    // Clear of the usual dev servers (3000/4321/5173/8080).
    expect(a.E2E_PORT).toBeGreaterThanOrEqual(20000);
    expect(a.E2E_PORT).toBeLessThan(40000);
    expect(a.E2E_BASE_URL).toBe('http://localhost:' + a.E2E_PORT);
  });

  it('honours an explicit E2E_PORT', async () => {
    process.env.E2E_PORT = '31234';
    const m = await import('../e2e/server-target.js?c');
    expect(m.E2E_PORT).toBe(31234);
    expect(m.E2E_BASE_URL).toBe('http://localhost:31234');
  });
});

describe('foreign-server detection', () => {
  it('accepts a server carrying THIS run token', () => {
    expect(servesRunToken({ templates: [sentinel(OUR_TOKEN)] }, OUR_TOKEN)).toBe(true);
  });

  it('rejects another checkout — same sentinel key, different run token', () => {
    // The case that used to pass silently: a sibling worktree's e2e server, which
    // looks identical apart from the token it stamped into its own fixture.
    expect(servesRunToken({ templates: [sentinel(THEIR_TOKEN)] }, OUR_TOKEN)).toBe(false);
  });

  it('rejects a server on the real template config (no sentinel at all)', () => {
    expect(servesRunToken({ templates: [{ key: 'bachelorette' }] }, OUR_TOKEN)).toBe(false);
  });

  it('rejects an empty or malformed response rather than assuming it is ours', () => {
    expect(servesRunToken({}, OUR_TOKEN)).toBe(false);
    expect(servesRunToken(null, OUR_TOKEN)).toBe(false);
    expect(servesRunToken({ templates: [null] }, OUR_TOKEN)).toBe(false);
    expect(servesRunToken({ templates: [{ key: FIXTURE_SENTINEL }] }, OUR_TOKEN)).toBe(false);
  });
});
